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

import { CuaError } from "../contract.js";
import { clickRef, type SnapshotResult } from "../cua/session.js";
import {
  ensureAbsoluteDir,
  fileNameOf,
  listDir,
  validateResumeFile,
  waitForNewFile,
} from "../cua/download.js";
import { takeSnapshot, type UiContext } from "../cua/ui-actions.js";
import { checkPageState, navigateChecked } from "./common.js";
import { findConversationRow } from "./read-pages.js";

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

/** 附件卡片候选:文件名样式优先,其次"简历/附件"文案的可点击节点 */
export function findAttachmentRef(snap: SnapshotResult): { ref: string; name: string } | null {
  const fileish = snap.refs.find(
    (r) => r.name !== null && /\.(pdf|docx?|doc)\b/i.test(r.name) && r.actions.includes("click"),
  );
  if (fileish !== null && fileish !== undefined) {
    return { ref: fileish.ref, name: fileish.name as string };
  }
  const hint = snap.refs.find(
    (r) => r.name !== null && /简历|附件/.test(r.name) && r.actions.includes("click"),
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

/** 附件检出+下载核心(返回三态;不抛业务失败,仅契约异常上抛) */
export async function runAttachCore(ctx: UiContext, input: AttachInput): Promise<AttachOutcome> {
  const steps: string[] = [];
  const note = (msg: string): void => {
    steps.push(msg);
    ctx.log(msg);
  };

  if (input.name !== undefined && input.name !== "") {
    // UI 会话名键模式(2026-09-30):导航会话页 → 按名点开会话 → 再检出附件
    const listUrl = input.pageUrl !== undefined && input.pageUrl !== ""
      ? input.pageUrl
      : "https://lpt.liepin.com/chat/im";
    await navigateChecked(ctx, listUrl);
    const listSnap = await takeSnapshot(ctx);
    const row = findConversationRow(listSnap.refs, input.name);
    if (row === null) {
      throw new CuaError("failed", `会话列表中未找到「${input.name}」(附件检出按名定位失败)`);
    }
    note(`会话行 ${row.ref}「${row.name ?? ""}」`);
    if (!input.dryRun) {
      await clickRef(ctx.client, ctx.session, row.ref);
      await ctx.sleep(2_000);
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

  const target = findAttachmentRef(snap);
  if (target === null) {
    note("未检出附件卡片");
    return { found: false, success: false, reason: "no-attachment", steps };
  }
  note(`检出附件卡片「${target.name}」(${target.ref})`);

  if (input.dryRun) {
    return { found: true, success: false, reason: "dry-run", detail: `target=${target.ref}`, steps };
  }

  const outRoot = ensureAbsoluteDir(input.outDir);
  note(`下载目录: ${outRoot}`);
  const before = listDir(outRoot);
  note(`目录基线 ${before.length} 个文件`);

  const result = await ctx.client.callTool("browser_download", {
    target_id: ctx.session.targetId,
    tab_id: ctx.session.activeTabId,
    ref: target.ref,
    destination_root: outRoot,
  });
  if (result.status === "refused") {
    note(`browser_download 被拒绝(${result.refusalCode})`);
    return {
      found: true,
      success: false,
      reason: "download-refused",
      detail: `${result.refusalCode}: ${result.refusalMessage ?? ""}`.trim(),
      steps,
    };
  }
  note("下载已触发,等待落盘");

  const filePath = await waitForNewFile(outRoot, before, {
    sleep: ctx.sleep,
    now: ctx.now ?? (() => Date.now()),
  });
  if (filePath === null) {
    note("等待落盘超时(未发现新文件)");
    return { found: true, success: false, reason: "download-no-file", detail: "等待新文件超时", steps };
  }
  note(`新文件: ${fileNameOf(filePath)}`);

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
