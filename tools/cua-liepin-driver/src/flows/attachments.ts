/**
 * attach-fetch / attach-download - 附件检出与下载(UI 模式,W4)。
 *
 * 流程:打开会话页 → 语义快照检出附件卡片 → browser_download(按 ref 触发真实下载,
 * 落盘到白名单目录)→ 目录差集识别新文件 → PDF 签名/SHA-256 校验 → 输出。
 *
 * 契约对齐(ChatPollService):
 * - attach-fetch 三态:成功 {found:true,success:true,file,fileName,bytes,sha256} /
 *   无附件 {found:false,success:false,reason:"no-attachment"} /
 *   失败 {found:true,success:false,reason,detail};
 * - attach-download:任一失败抛错(退出码非 0),成功输出同 fetch 成功形态。
 *
 * 已知联调项:会话页 URL(im_id → URL)待确认;browser_download 的目录审批行为待实测。
 */

import { copyFileSync, existsSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CuaError } from "../contract.js";
import { currentSessionName } from "../cua/extract.js";
import { clickRef, type SnapshotResult } from "../cua/session.js";
import {
  ensureAbsoluteDir,
  fileNameOf,
  listDir,
  validateResumeFile,
  waitForNewFile,
} from "../cua/download.js";
import { navigate, takeSnapshot, type UiContext } from "../cua/ui-actions.js";
import { checkPageState, navigateChecked } from "./common.js";
import { findConversationRow, PAGE_RETRY_ATTEMPTS } from "./read-pages.js";

export interface AttachOutcome {
  found: boolean;
  success: boolean;
  reason?: string;
  detail?: string;
  file?: string;
  fileName?: string;
  bytes?: number;
  sha256?: string;
  sourceOrigin?: string;
  steps: string[];
}

/** 附件卡片候选:文件名样式优先,其次"简历/附件"文案的可点击节点;
 * 2026-09-30 真机:排除会话页 UI 词(筛选 tab"有简历"/工具栏"浏览简历"等),避免误报;
 * 范围限定在最后一个"在线沟通" rootwebarea 之后(消息区)——列表区通知卡
 * "收到了 X、Y等N人的简历"可点且含"简历",曾导致附件下载点错 ref(2026-09-30 实验发现)。
 */
export function findAttachmentRef(snap: SnapshotResult): { ref: string; name: string } | null {
  let start = 0;
  for (let i = snap.refs.length - 1; i >= 0; i--) {
    if (snap.refs[i].role === "rootwebarea" && (snap.refs[i].name ?? "").includes("在线沟通")) {
      start = i + 1;
      break;
    }
  }
  const scoped = snap.refs.slice(start);
  const fileish = scoped.find(
    (r) => r.name !== null && /\.(pdf|docx?|doc)\b/i.test(r.name) && r.actions.includes("click"),
  );
  if (fileish !== null && fileish !== undefined) {
    return { ref: fileish.ref, name: fileish.name as string };
  }
  const hint = scoped.find(
    (r) =>
      r.name !== null &&
      /简历|附件/.test(r.name) &&
      !/^(有简历|浏览简历|通过筛选|不合适|超级聊聊|在线简历|收到简历|收到了)/.test(r.name.trim()) &&
      r.actions.includes("click"),
  );
  if (hint !== null && hint !== undefined) {
    return { ref: hint.ref, name: hint.name as string };
  }
  return null;
}

export interface AttachInput {
  /** 会话页 URL(--name 会话名键模式下可缺省,自动导航 /chat/im) */
  pageUrl?: string;
  /** 对方会话 im_id(仅留痕) */
  imId?: string;
  /** UI 会话键:候选人名(替代 im_id;导航 /chat/im 后按名点开会话再检出附件) */
  name?: string;
  /** 下载目录(绝对路径;后端传 attachWorkDir()) */
  outDir: string;
  dryRun: boolean;
}

/**
 * 「附件简历」页签(附件预览弹窗入口;2026-09-30 真机:点击后打开弹窗,内含下载按钮)。
 * 找不到页签=无附件入口(与旧"未检出附件卡"语义一致,诚实返回无附件)。
 */
export function findAttachmentTab(snap: SnapshotResult): { ref: string; name: string } | null {
  const tab = snap.refs.find(
    (r) => r.name !== null && r.name.trim() === "附件简历" && r.actions.includes("click"),
  );
  return tab === undefined ? null : { ref: tab.ref, name: "附件简历" };
}

/** 下载按钮基准(2026-09-30 真机实测):窗口 3072 宽时按钮中心 (2334,430);
 * x 相对窗口右缘(3072-2334=738),y 固定(弹窗为页面固定布局,顶部距稳定)。
 * 窗口尺寸变化时按右缘偏移换算;部署环境窗口固定,首点后如有偏差用邻域微调。
 */
export const DL_BUTTON_RIGHT_OFFSET = 738;
export const DL_BUTTON_Y = 430;

export function downloadButtonXY(windowWidth: number): { x: number; y: number } {
  return { x: Math.round(windowWidth - DL_BUTTON_RIGHT_OFFSET), y: DL_BUTTON_Y };
}

/** Chrome 原生下载目录(可用 LIEPIN_DOWNLOAD_DIR 覆盖;测试/非默认部署用) */
export function downloadsPath(): string {
  return process.env.LIEPIN_DOWNLOAD_DIR ?? join(homedir(), "Downloads");
}

/** Chrome 重名去重后缀(" (1)"/" (2)"…)→ 规范化回原名(后端入库名含去重后缀无意义;
 * 2026-09-30 smoke:Downloads 有同名旧文件时 Chrome 自动加 " (1)")。
 */
export function stripChromeDuplicateSuffix(name: string): string {
  return name.replace(/ \(\d+\)(\.[^.]+)$/, "$1");
}

/** 把 Downloads 落盘文件搬入目标目录(文件名规范化去重后缀;同名覆盖;跨盘回退 copy+unlink) */
export function moveIntoDir(src: string, dir: string): string {
  const dest = join(dir, stripChromeDuplicateSuffix(fileNameOf(src)));
  try {
    if (existsSync(dest)) {
      unlinkSync(dest);
    }
    renameSync(src, dest);
    return dest;
  } catch {
    copyFileSync(src, dest);
    try {
      unlinkSync(src);
    } catch {
      /* 源文件清理失败不阻断(Downloads 残留可人工清理) */
    }
    return dest;
  }
}

/** 坐标点击下载按钮(background 优先;background_unavailable 时 foreground 升级)
 * 2026-09-30 真机:窗口截图坐标 (2334,430) background 点击即触发 Chrome 原生下载。
 */
async function clickDownloadButton(
  ctx: UiContext,
  pos: { x: number; y: number },
  captureId?: string,
): Promise<boolean> {
  const base = {
    pid: ctx.session.window.pid,
    window_id: ctx.session.window.windowId,
    x: pos.x,
    y: pos.y,
  };
  try {
    const res = await ctx.client.callTool(
      "click",
      captureId !== undefined && captureId !== "" ? { ...base, capture_id: captureId } : base,
    );
    return res.status === "ok";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/background_unavailable/.test(msg)) {
      try {
        const res2 = await ctx.client.callTool("click", { ...base, delivery_mode: "foreground" });
        return res2.status === "ok";
      } catch {
        return false;
      }
    }
    throw err;
  }
}

/** 附件检出+下载核心(返回三态;不抛业务失败,仅契约异常上抛) */
export async function runAttachCore(ctx: UiContext, input: AttachInput): Promise<AttachOutcome> {
  const steps: string[] = [];
  const note = (msg: string): void => {
    steps.push(msg);
    ctx.log(msg);
  };

  if (input.name !== undefined && input.name !== "") {
    // UI 会话名键模式(2026-09-30):导航会话页 → 按名点开会话 → 再检出附件;
    // 语义快照可能间歇性残缺(会话行缺失),重导航重试
    const listUrl =
      input.pageUrl !== undefined && input.pageUrl !== ""
        ? input.pageUrl
        : "https://lpt.liepin.com/chat/im";
    let row: ReturnType<typeof findConversationRow> = null;
    for (let attempt = 1; attempt <= PAGE_RETRY_ATTEMPTS; attempt++) {
      // 2026-09-30 与 readPage/runReadChatMsg 同款:清场前置 + 单快照 + 残缺后标签轮换
      await navigate(ctx, "about:blank", 800);
      await navigate(ctx, listUrl, 3000);
      row = findConversationRow((await takeSnapshot(ctx)).refs, input.name);
      if (row !== null) {
        break;
      }
      note(`会话行未找到(疑似语义快照残缺),清场重试 ${attempt}/${PAGE_RETRY_ATTEMPTS}`);
      if (attempt < PAGE_RETRY_ATTEMPTS) {
        if (ctx.rotateSession !== undefined) {
          await ctx.rotateSession();
        }
        await ctx.sleep(1_800);
      }
    }
    if (row === null) {
      // 降级通道(2026-09-30):左侧列表不进语义树;若目标会话已打开(右侧详情区含名字),继续附件检出
      const opened = currentSessionName(await takeSnapshot(ctx));
      if (opened === input.name) {
        note(`左侧列表不可用,但当前已打开「${opened}」会话,继续附件检出(降级通道)`);
      } else {
        throw new CuaError(
          "failed",
          `会话列表中未找到「${input.name}」(已重试 ${PAGE_RETRY_ATTEMPTS} 次;` +
            `左侧列表受虚拟滚动容器限制;当前打开会话=${opened ?? "未知"})`,
        );
      }
    } else {
      note(`会话行 ${row.ref}「${row.name ?? ""}」`);
      if (!input.dryRun) {
        await clickRef(ctx.client, ctx.session, row.ref);
        await ctx.sleep(2_000);
      }
    }
  } else {
    if (input.pageUrl === undefined || input.pageUrl === "") {
      throw new CuaError("failed", "attach 需要 --url <会话页> 或 --name <候选人名>");
    }
    await navigateChecked(ctx, input.pageUrl);
  }
  const snap = await takeSnapshot(ctx);
  checkPageState(snap);
  if (input.imId !== undefined && input.imId !== "") {
    note(`im_id=${input.imId}(仅留痕;UI 按 --url 直达会话)`);
  }

  const tab = findAttachmentTab(snap);
  if (tab === null) {
    note("未检出附件入口(「附件简历」页签)");
    return { found: false, success: false, reason: "no-attachment", steps };
  }
  note(`检出附件入口「${tab.name}」(${tab.ref})`);

  if (input.dryRun) {
    return { found: true, success: false, reason: "dry-run", detail: `target=${tab.ref}`, steps };
  }

  // 打开「附件预览」弹窗(2026-09-30 v2:UI 原生下载通道,替代 browser_download)
  await clickRef(ctx.client, ctx.session, tab.ref);
  await ctx.sleep(3_000);
  note("附件预览弹窗已打开");

  // 截图取窗口尺寸与 capture_id(坐标锚点),计算下载按钮位置
  const shot = await ctx.client.requireOk("get_window_state", {
    pid: ctx.session.window.pid,
    window_id: ctx.session.window.windowId,
    include_accessibility_tree: false,
    include_screenshot: true,
    max_image_dimension: 0,
  });
  const winWidth = typeof shot.screenshot_width === "number" ? shot.screenshot_width : 3072;
  const pos = downloadButtonXY(winWidth);
  note(`下载按钮坐标(${pos.x},${pos.y}) 窗口宽 ${winWidth}`);

  // Downloads 基线(Chrome 原生下载直接落盘默认下载目录)
  const downloadsDir = downloadsPath();
  const before = listDir(downloadsDir);
  note(`Downloads 基线 ${before.length} 个文件 (${downloadsDir})`);

  const clicked = await clickDownloadButton(
    ctx,
    pos,
    typeof shot.capture_id === "string" ? shot.capture_id : undefined,
  );
  if (!clicked) {
    note("下载按钮点击未成功");
    return { found: true, success: false, reason: "download-click-failed", detail: "下载按钮点击未成功投递", steps };
  }
  note("下载按钮已点击,等待落盘");

  const downloaded = await waitForNewFile(downloadsDir, before, {
    sleep: ctx.sleep,
    now: ctx.now ?? (() => Date.now()),
  });
  if (downloaded === null) {
    note("等待落盘超时(未发现新文件)");
    return { found: true, success: false, reason: "download-no-file", detail: "等待新文件超时", steps };
  }
  note(`下载落盘: ${fileNameOf(downloaded)}`);

  // 搬移到后端工作目录(attachWorkDir)
  const outRoot = ensureAbsoluteDir(input.outDir);
  const filePath = moveIntoDir(downloaded, outRoot);
  note(`已搬移到 ${filePath}`);

  try {
    const validated = validateResumeFile(filePath);
    note(`校验通过(${validated.bytes} 字节, sha256=${validated.sha256.slice(0, 12)}...)`);
    return {
      found: true,
      success: true,
      file: filePath,
      fileName: fileNameOf(filePath),
      bytes: validated.bytes,
      sha256: validated.sha256,
      sourceOrigin: "ui-download",
      steps,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    note(`校验失败: ${detail}`);
    return { found: true, success: false, reason: "validate-failed", detail, steps };
  }
}

/** attach-fetch:三态输出(无附件/失败均正常返回,由后端留待处理) */
export async function runAttachFetchUi(ctx: UiContext, input: AttachInput): Promise<AttachOutcome> {
  return runAttachCore(ctx, input);
}

/** attach-download:任一业务失败抛错(契约:失败必须非零退出) */
export async function runAttachDownloadUi(ctx: UiContext, input: AttachInput): Promise<AttachOutcome> {
  const outcome = await runAttachCore(ctx, input);
  if (!outcome.success) {
    throw new CuaError(
      "failed",
      `附件下载失败(${outcome.reason ?? "unknown"}): ${outcome.detail ?? ""}`.trim(),
    );
  }
  return outcome;
}
