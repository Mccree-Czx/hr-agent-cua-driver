/**
 * 读类通用页流程(W3):列表页原始抽取 + 点击穿透取 ID + 会话消息读取。
 *
 * 页面锚点与匹配器尚待登录联调校准(见 docs/superpowers/specs/2026-09-29-ui-extraction-contract.md);
 * 本层输出"原始文本行 + 状态标记",不做未经验证的字段级结构化断言。
 * 读类命令均为只读动作:导航/快照始终执行;`--dry-run` 仅抑制"点击穿透"。
 */

import { CuaError } from "../contract.js";
import {
  candidateRowIndexes,
  extractCandidateRecords,
  extractResumeNo,
  hasAttachmentHint,
  jobRowIndexes,
  queryParam,
  rawTextOf,
  textLinesOf,
} from "../cua/extract.js";
import { clickRef, type SnapshotRef, type SnapshotResult } from "../cua/session.js";
import { navigate, takeSnapshot, type UiContext } from "../cua/ui-actions.js";
import { checkPageState, navigateChecked } from "./common.js";

/** 点击穿透结果(卡片 → 详情 URL → ID 参数) */
export interface Capture {
  ref: string;
  url: string;
  id: string | null;
  /** id 来源:url=点击后 URL 参数;preview=预览层「简历编号」(非 dry-run 均有值) */
  id_source?: "url" | "preview";
};

export interface RawPageOutcome {
  page_url: string;
  count: number;
  lines: string[];
  extraction_status: "unvalidated" | "validated";
  captures: Capture[];
  /** 结构化记录(UI 抽取契约;按命令提供,缺省不输出) */
  records?: unknown[];
  attachment_hint?: boolean;
  steps: string[];
}

/**
 * 页面残缺指纹阈值(2026-09-30 真机:semantic_v2 快照间歇性只返回"导航壳",
 * 纯壳文本行约 21-23;正常应用页 ≥ 40)。低于阈值时重试。
 */
export const MIN_PAGE_LINES = 26;

/** 残缺重试上限(每轮=about:blank 清场→导航→快照) */
export const PAGE_RETRY_ATTEMPTS = 6;

/**
 * 打开页面并全文抽取(读操作)。
 * 2026-09-30 增内容充分性校验:文本行低于 {@link MIN_PAGE_LINES} 视为语义快照残缺;
 * **每轮(含第一轮)先导航 about:blank 清场再回目标页**——真机实验
 * (probe-waitfull)证实"清场前置+导航+快照"首个尝试即得完整快照(245 refs/95 named);
 * 仍不足则抛错(不向下游交付残缺数据)。
 */
export async function readPage(
  ctx: UiContext,
  url: string,
  settleMs = 3000,
): Promise<{ snap: SnapshotResult; lines: string[] }> {
  let last = 0;
  const minLines = ctx.minPageLines ?? MIN_PAGE_LINES;
  for (let attempt = 1; attempt <= PAGE_RETRY_ATTEMPTS; attempt++) {
    // 清场前置(每轮,含首轮):重置渲染/快照状态
    await navigate(ctx, "about:blank", 800);
    await navigate(ctx, url, settleMs);
    const snap = await takeSnapshot(ctx);
    checkPageState(snap);
    const lines = textLinesOf(snap);
    if (lines.length >= minLines) {
      return { snap, lines };
    }
    last = lines.length;
    ctx.log(`文本行仅 ${lines.length}(疑似语义快照残缺),清场重试 ${attempt}/${PAGE_RETRY_ATTEMPTS}`);
    // 2026-09-30 真机:长期复用的旧标签会持续残缺(新标签立即完整)→ 每轮失败后轮换标签
    if (ctx.rotateSession !== undefined) {
      await ctx.rotateSession();
    }
    if (attempt < PAGE_RETRY_ATTEMPTS) {
      await ctx.sleep(1_800);
    }
  }
  throw new CuaError(
    "failed",
    `页面内容不足(文本行 ${last} < ${minLines},已重试 ${PAGE_RETRY_ATTEMPTS} 次): ${url};` +
      "可能仍在加载或语义快照持续残缺,请查 cua-driver daemon 状态",
  );
}

/** 点击穿透的可选策略 */
export interface ClickThroughOptions {
  /**
   * 点击被拒(stale/superseded)时重新快照并解析同序 refs 用于重试
   * (2026-09-30 真机:include_screenshot 下首次 click 常报 snapshot superseded,
   * 重新快照后同序 ref 即可点击成功)。
   */
  resolveRefs?: () => Promise<string[]>;
}

/**
 * 点击穿透取 ID:对给定 ref 逐个点击 → 快照读 URL → 解析 id 参数 → 返回列表页。
 * 成本约 6-10s/ref(见契约 §4);dryRun 时仅报告 ref,不点击。
 * stale/superseded 时经 options.resolveRefs 重新解析同序 ref 并重试(至多 2 次)。
 */
export async function captureIdsByClickThrough(
  ctx: UiContext,
  refs: string[],
  backUrl: string,
  idParam: string,
  dryRun: boolean,
  options: ClickThroughOptions = {},
): Promise<Capture[]> {
  const captures: Capture[] = [];
  for (let index = 0; index < refs.length; index++) {
    let ref = refs[index];
    if (dryRun) {
      captures.push({ ref, url: "", id: null });
      ctx.log(`[穿透] dry-run:跳过点击 ${ref}`);
      continue;
    }
    for (let attempt = 0; ; attempt++) {
      try {
        ctx.log(`[穿透] 点击 ${ref}${attempt > 0 ? `(stale 重试 ${attempt})` : ""}`);
        await clickRef(ctx.client, ctx.session, ref);
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // 2026-09-30:含 driver 底层"Frame with the given frameId is not found"(轮换后首次快照偶发)
        const stale = /stale|superseded|frameId is not found/i.test(msg);
        if (!stale || attempt >= 2 || options.resolveRefs === undefined) {
          throw err;
        }
        // 重新快照 → 同序 ref 重定位
        const fresh = await options.resolveRefs();
        const next = fresh[index];
        if (next === undefined) {
          throw err;
        }
        ref = next;
      }
    }
    await ctx.sleep(1_500);
    const snap = await takeSnapshot(ctx);
    const url = snap.page.url;
    let id = queryParam(url, idParam);
    let idSource: "url" | "preview" = "url";
    if (id === null) {
      // 2026-09-29 联调校准:推荐卡片/会话预览点击后 URL 不变(仅 #preview),
      // resIdEncode 在预览层「简历编号」字段(已验证可达 resume/detail)。
      const hit = extractResumeNo(snap);
      if (hit !== null) {
        id = hit.value;
        idSource = "preview";
      }
    }
    captures.push({ ref, url, id, id_source: idSource });
    ctx.log(`[穿透] ${ref} → ${id ?? "(未解析到 " + idParam + ")"} [${idSource}] @ ${url.slice(0, 120)}`);

    // 返回列表页(先清场:预览层(#preview)为独立 frame,直接回列表会残留损坏
    // → 下一次 get_browser_state 报 Frame not found — 2026-09-30 真机)
    await ctx.client.requireOk("browser_navigate", {
      target_id: ctx.session.targetId,
      tab_id: ctx.session.activeTabId,
      url: "about:blank",
    });
    await ctx.sleep(600);
    await ctx.client.requireOk("browser_navigate", {
      target_id: ctx.session.targetId,
      tab_id: ctx.session.activeTabId,
      url: backUrl,
    });
    await ctx.sleep(2_000);
  }
  return captures;
}

export interface RecommendInput {
  jobId?: string;
  /** 页面 URL 覆盖(联调期使用);缺省为已验证存在的推荐页 */
  pageUrl?: string;
  /** 点击穿透目标 ref(联调原语;列表页卡片 ref 匹配器待校准后自动化) */
  captureRefs: string[];
  /** 穿透后解析的 URL 参数名(默认 resIdEncode) */
  idParam?: string;
  dryRun: boolean;
  /** 自动逐卡穿透取 resume_id(recommend --with-ids;预览层「简历编号」回退通道) */
  withIds?: boolean;
}

/** 列表页通用抽取输入(recommend/joblist 复用) */
export interface ReadListInput {
  pageUrl: string;
  captureRefs: string[];
  idParam: string;
  dryRun: boolean;
  /** 日志称谓(如"推荐列表页"/"职位列表页") */
  label: string;
  /** 结构化 records 抽取器(joblist 等提供;2026-09-29 W6 适配起点) */
  recordsExtractor?: (snap: SnapshotResult) => unknown[];
  /** 自动逐行穿透取 ID 并合并进 records(joblist/recommend --with-ids;逐行点击成本高,显式开启) */
  autoCaptureRows?: boolean;
  /** 穿透行 ref 定位器(缺省=职位行 link;recommend 传候选人姓名节点) */
  autoCaptureRowRefs?: (snap: SnapshotResult) => string[];
  /** 合并进 records 的字段名(缺省 jobId;recommend 传 resume_id,与后端下游契约对齐) */
  autoCaptureField?: string;
}

/** 自动穿透行数上限(防御大列表耗时失控) */
export const AUTO_CAPTURE_LIMIT = 20;

/** 列表页通用抽取(+ 可选 ID 穿透;穿透含 URL 参数与预览层「简历编号」双通道) */
export async function runReadList(ctx: UiContext, input: ReadListInput): Promise<RawPageOutcome> {
  const steps: string[] = [];
  const { snap, lines } = await readPage(ctx, input.pageUrl);
  steps.push(`${input.label}文本行 ${lines.length}`);
  const captures = input.captureRefs.length > 0
    ? await captureIdsByClickThrough(ctx, input.captureRefs, input.pageUrl, input.idParam, input.dryRun)
    : [];
  if (captures.length > 0) {
    const hit = captures.filter((c) => c.id !== null).length;
    steps.push(`穿透 ${captures.length} 个,解析到 ID ${hit} 个`);
  }

  let records = input.recordsExtractor !== undefined ? input.recordsExtractor(snap) : undefined;

  // 自动逐行穿透:把行 ID 合并进 records(仅显式开启;dry-run 时仅报告不点击)
  if (input.autoCaptureRows === true && records !== undefined && records.length > 0) {
    const locate =
      input.autoCaptureRowRefs ??
      ((s: SnapshotResult) => jobRowIndexes(s.refs).map((i) => s.refs[i].ref));
    const rowRefs = locate(snap).slice(0, AUTO_CAPTURE_LIMIT);
    const autoCaptures = await captureIdsByClickThrough(ctx, rowRefs, input.pageUrl, input.idParam, input.dryRun, {
      // stale/superseded 重试:重新快照并按同序解析行 ref
      resolveRefs: async () => locate(await takeSnapshot(ctx)).slice(0, AUTO_CAPTURE_LIMIT),
    });
    const rows = records as Array<Record<string, unknown>>;
    const field = input.autoCaptureField ?? "jobId";
    autoCaptures.forEach((c, i) => {
      if (rows[i] !== undefined) {
        rows[i][field] = c.id;
      }
    });
    const hit = autoCaptures.filter((c) => c.id !== null).length;
    steps.push(`自动穿透 ${rowRefs.length} 行,解析到 ID ${hit} 个`);
  }

  if (records !== undefined) {
    steps.push(`结构化记录 ${records.length} 条`);
  }
  return {
    page_url: input.pageUrl,
    count: lines.length,
    lines,
    extraction_status: records !== undefined && records.length > 0 ? "validated" : "unvalidated",
    captures,
    records,
    steps,
  };
}

/** 推荐列表页抽取(+ 可选 ID 穿透 + 候选人 records) */
export async function runReadRecommend(ctx: UiContext, input: RecommendInput): Promise<RawPageOutcome> {
  const url = input.pageUrl ?? "https://lpt.liepin.com/recommend";
  const outcome = await runReadList(ctx, {
    pageUrl: url,
    captureRefs: input.captureRefs,
    idParam: input.idParam ?? "resIdEncode",
    dryRun: input.dryRun,
    label: "列表页",
    recordsExtractor: (snap) => extractCandidateRecords(snap),
    autoCaptureRows: input.withIds === true,
    autoCaptureRowRefs: (snap) => candidateRowIndexes(snap.refs).map((i) => snap.refs[i].ref),
    autoCaptureField: "resume_id",
  });
  if (input.jobId !== undefined && input.jobId !== "") {
    outcome.steps.unshift(`jobId=${input.jobId}(岗位上下文参数待联调确认,当前按页面默认呈现)`);
  }
  return outcome;
}

export interface SearchInput {
  /** 完整搜索页 URL(--url 优先;联调期可绕开关键词拼装直接给 URL) */
  pageUrl?: string;
  /** 搜索关键词(URL 公式待真机校准:当前按 /search?key=<keywords> 预实现) */
  keywords: string;
  withIds?: boolean;
  captureRefs: string[];
  idParam?: string;
  dryRun: boolean;
}

/**
 * 搜索页 records(2026-09-30 真机校准 v2):
 * 1) 打开 /search?key=<kw>(关键词由 key 参数预填入搜索框);
 * 2) 引导卡兜底:若出现"我知道了"则点掉(首次引导一次性);
 * 3) 点击"搜索"按钮提交(页面不会因 URL 自动执行搜索);
 * 4) 结果快照 → 候选人 records(与推荐页同构假设,待样本二次校准)。
 */
export async function runReadSearch(ctx: UiContext, input: SearchInput): Promise<RawPageOutcome> {
  const url = input.pageUrl ?? `https://lpt.liepin.com/search?key=${encodeURIComponent(input.keywords)}`;
  // 初始快照复用 readPage(自带内容充分性校验+清场重试,抵御语义快照间歇残缺)
  const first = await readPage(ctx, url);
  let snap = first.snap;

  // 引导卡兜底("AI 帮搜"首次引导 → 我知道了)
  const know = snap.refs.find((r) => r.name === "我知道了" && r.actions.includes("click"));
  if (know !== undefined) {
    ctx.log("关闭首次引导卡(我知道了)");
    await clickRef(ctx.client, ctx.session, know.ref);
    await ctx.sleep(1_500);
    snap = await takeSnapshot(ctx);
  }

  // 提交搜索:点"搜索"按钮(精确名;排除导航"搜索人才")
  let go = snap.refs.find((r) => r.name === "搜索" && (r.role === "button" || r.actions.includes("click")));
  if (go === undefined) {
    // 提交按钮未出现在快照中:清场重试一次
    ctx.log("搜索按钮未出现,清场重试");
    await navigate(ctx, "about:blank", 800);
    await ctx.sleep(1_800);
    const retry = await readPage(ctx, url);
    snap = retry.snap;
    go = snap.refs.find((r) => r.name === "搜索" && (r.role === "button" || r.actions.includes("click")));
  }
  if (go === undefined) {
    throw new CuaError("failed", "搜索页未找到提交按钮(页面结构可能变化,请重新校准)");
  }
  ctx.log(`提交搜索(关键词「${input.keywords}」)`);
  await clickRef(ctx.client, ctx.session, go.ref);
  await ctx.sleep(3_500);

  const result = await takeSnapshot(ctx);
  checkPageState(result);
  const lines = textLinesOf(result);
  const records = extractCandidateRecords(result);
  return {
    page_url: result.page.url,
    count: lines.length,
    lines,
    extraction_status: records.length > 0 ? "validated" : "unvalidated",
    captures: [],
    records,
    steps: [
      `搜索「${input.keywords}」已提交(引导卡${know !== undefined ? "已关闭" : "未出现"})`,
      `结果页文本行 ${lines.length}`,
      `结构化记录 ${records.length} 条`,
    ],
  };
}

export interface ChatMsgInput {
  /** 会话页 URL(缺省按 --name 模式固定 /chat/im) */
  pageUrl: string;
  imId?: string;
  /** UI 会话键:候选人名(替代 im_id;2026-09-29 真机:会话行可精确名定位) */
  name?: string;
  dryRun: boolean;
}

/**
 * 会话行定位(2026-09-29 type-send 真机验证):优先精确名 + statictext + click;
 * 回退包含匹配并排除"收到了 X 的简历"类含名文案。
 */
export function findConversationRow(refs: SnapshotRef[], name: string): SnapshotRef | null {
  const exact = refs.find((r) => r.name === name && r.role === "statictext" && r.actions.includes("click"));
  if (exact !== undefined) {
    return exact;
  }
  return (
    refs.find(
      (r) =>
        r.name !== null &&
        r.name.includes(name) &&
        r.actions.includes("click") &&
        !/(收到了|这是|简历。$)/.test(r.name),
    ) ?? null
  );
}

/** 会话消息页读取(--name 会话名键模式:导航会话页→点开会话→抽取消息文本) */
export async function runReadChatMsg(ctx: UiContext, input: ChatMsgInput): Promise<RawPageOutcome> {
  const steps: string[] = [];
  let lines: string[];

  if (input.name !== undefined && input.name !== "") {
    await navigateChecked(ctx, input.pageUrl);
    const snap = await takeSnapshot(ctx);
    const row = findConversationRow(snap.refs, input.name);
    if (row === null) {
      throw new CuaError("failed", `会话列表中未找到「${input.name}」(按名定位,可能未加载或名称不符)`);
    }
    steps.push(`会话行 ${row.ref}「${row.name ?? ""}」`);
    if (ctx.dryRun) {
      steps.push("dry-run:不点开会话");
    } else {
      await clickRef(ctx.client, ctx.session, row.ref);
      await ctx.sleep(2_000);
    }
    lines = textLinesOf(await takeSnapshot(ctx));
    steps.push(`会话消息文本行 ${lines.length}`);
  } else {
    const result = await readPage(ctx, input.pageUrl);
    lines = result.lines;
    steps.push(`会话页文本行 ${lines.length}`);
  }

  if (input.imId !== undefined && input.imId !== "") {
    steps.push(`im_id=${input.imId}(仅留痕;UI 按 --url 直达会话)`);
  }
  const attachment = hasAttachmentHint(lines);
  if (attachment) {
    steps.push("检测到附件卡片文案迹象(简历/附件)");
  }
  return {
    page_url: input.pageUrl,
    count: lines.length,
    lines,
    extraction_status: "unvalidated",
    captures: [],
    attachment_hint: attachment,
    steps,
  };
}

/** 其他列表页(chatlist/search/joblist)的原始抽取:URL 待联调确认,必须显式传入 */
export async function runReadPageGeneric(
  ctx: UiContext,
  pageUrl: string,
  label: string,
): Promise<RawPageOutcome> {
  const { lines } = await readPage(ctx, pageUrl);
  return {
    page_url: pageUrl,
    count: lines.length,
    lines,
    extraction_status: "unvalidated",
    captures: [],
    steps: [`${label} 文本行 ${lines.length}`],
  };
}

/** 原始文本(便于 CLI 直接打印诊断) */
export function rawTextOfSnapshot(snap: SnapshotResult): string {
  return rawTextOf(snap);
}
