/**
 * 读类通用页流程(W3):列表页原始抽取 + 点击穿透取 ID + 会话消息读取。
 *
 * 页面锚点与匹配器尚待登录联调校准(见 docs/superpowers/specs/2026-09-29-ui-extraction-contract.md);
 * 本层输出"原始文本行 + 状态标记",不做未经验证的字段级结构化断言。
 * 读类命令均为只读动作:导航/快照始终执行;`--dry-run` 仅抑制"点击穿透"。
 */

import { CuaError } from "../contract.js";
import { hasAttachmentHint, queryParam, rawTextOf, textLinesOf } from "../cua/extract.js";
import { clickRef, type SnapshotResult } from "../cua/session.js";
import { takeSnapshot, type UiContext } from "../cua/ui-actions.js";
import { checkPageState, navigateChecked } from "./common.js";

/** 点击穿透结果(卡片 → 详情 URL → ID 参数) */
export interface Capture {
  ref: string;
  url: string;
  id: string | null;
};

export interface RawPageOutcome {
  page_url: string;
  count: number;
  lines: string[];
  extraction_status: "unvalidated";
  captures: Capture[];
  attachment_hint?: boolean;
  steps: string[];
}

/** 打开页面并全文抽取(读操作;页面未就绪即抛错) */
export async function readPage(
  ctx: UiContext,
  url: string,
  settleMs = 3000,
): Promise<{ snap: SnapshotResult; lines: string[] }> {
  await navigateChecked(ctx, url, settleMs);
  const snap = await takeSnapshot(ctx);
  checkPageState(snap);
  const lines = textLinesOf(snap);
  if (lines.length === 0) {
    throw new CuaError("failed", `页面无可见文本(${snap.page.url});可能仍在加载或页面结构变化`);
  }
  return { snap, lines };
}

/**
 * 点击穿透取 ID:对给定 ref 逐个点击 → 快照读 URL → 解析 id 参数 → 返回列表页。
 * 成本约 6-10s/ref(见契约 §4);dryRun 时仅报告 ref,不点击。
 */
export async function captureIdsByClickThrough(
  ctx: UiContext,
  refs: string[],
  backUrl: string,
  idParam: string,
  dryRun: boolean,
): Promise<Capture[]> {
  const captures: Capture[] = [];
  for (const ref of refs) {
    if (dryRun) {
      captures.push({ ref, url: "", id: null });
      ctx.log(`[穿透] dry-run:跳过点击 ${ref}`);
      continue;
    }
    ctx.log(`[穿透] 点击 ${ref}`);
    await clickRef(ctx.client, ctx.session, ref);
    await ctx.sleep(1_500);
    const snap = await takeSnapshot(ctx);
    const url = snap.page.url;
    const id = queryParam(url, idParam);
    captures.push({ ref, url, id });
    ctx.log(`[穿透] ${ref} → ${id ?? "(未解析到 " + idParam + ")"} @ ${url.slice(0, 120)}`);

    // 返回列表页(点击可能导致导航;refs 已在本次穿透中消费完,无需保留)
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
}

/** 推荐列表页抽取(+ 可选 ID 穿透) */
export async function runReadRecommend(ctx: UiContext, input: RecommendInput): Promise<RawPageOutcome> {
  const steps: string[] = [];
  const url = input.pageUrl ?? "https://lpt.liepin.com/recommend";
  if (input.jobId !== undefined && input.jobId !== "") {
    steps.push(`jobId=${input.jobId}(岗位上下文参数待联调确认,当前按页面默认呈现)`);
  }
  const { lines } = await readPage(ctx, url);
  steps.push(`列表页文本行 ${lines.length}`);

  const captures = input.captureRefs.length > 0
    ? await captureIdsByClickThrough(ctx, input.captureRefs, url, input.idParam ?? "resIdEncode", input.dryRun)
    : [];
  if (captures.length > 0) {
    const hit = captures.filter((c) => c.id !== null).length;
    steps.push(`穿透 ${captures.length} 个,解析到 ID ${hit} 个`);
  }
  return { page_url: url, count: lines.length, lines, extraction_status: "unvalidated", captures, steps };
}

export interface ChatMsgInput {
  /** 会话页 URL(联调期必填:会话页 URL 公式待确认) */
  pageUrl: string;
  imId?: string;
  dryRun: boolean;
}

/** 会话消息页读取(发送方启发式与消息结构待联调) */
export async function runReadChatMsg(ctx: UiContext, input: ChatMsgInput): Promise<RawPageOutcome> {
  const steps: string[] = [];
  const { lines } = await readPage(ctx, input.pageUrl);
  steps.push(`会话页文本行 ${lines.length}`);
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
