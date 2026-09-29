/**
 * 业务流程公共层:页面导航检查、IM 面板打开、消息发送。
 *
 * 所有界面锚点来自 liepin-cli 的真机验证结论(2026-09-27 前后):
 * - 简历详情页:https://lpt.liepin.com/resume/detail?resIdEncode=<id>&sfrom=R_SEARCH_CONDITION
 * - IM 面板入口按钮:.xpath-open-im-btn(可访问名以"在线沟通/继续沟通"类文案呈现)
 * - 输入框 .im-ui-textarea / 发送按钮 .im-ui-basic-send-btn
 * - 索要简历快捷按钮 .im-ui-action-button.action-resume(文案「索要简历」)
 * 语义匹配使用候选名列表;真机联调时按实际快照调整候选集合。
 */

import { CuaError, checkRiskMarkers } from "../contract.js";
import { clickName, findAnyText, matchRef, navigate, takeSnapshot, typeIntoName, waitForEvidence, waitForMatch, type NameMatcher, type UiContext } from "../cua/ui-actions.js";
import type { SnapshotResult } from "../cua/session.js";

/** 简历详情页 URL(与 liepin-cli 的 openResumeImPanel 相同) */
export function resumeDetailUrl(resumeId: string): string {
  return `https://lpt.liepin.com/resume/detail?resIdEncode=${encodeURIComponent(resumeId)}&sfrom=R_SEARCH_CONDITION`;
}

/** 打开 IM 聊天面板的入口候选(简历详情页) */
export const IM_OPEN_MATCHER: NameMatcher = {
  names: ["在线沟通", "继续沟通", "发消息"],
  actions: ["click"],
};

/** IM 输入框候选(可编辑 textbox) */
export const IM_TEXTBOX_MATCHER: NameMatcher = {
  names: ["发送消息", "输入消息", "请输入", "输入内容", "消息"],
  roles: ["textbox"],
  actions: ["type"],
};

/**
 * IM 发送按钮候选。
 * 联调实测(2026-09-29):发送按钮在输入前为 disabled 且无 click action 属性,
 * 因此不得限定 actions(输入后变为可点)。
 */
export const IM_SEND_MATCHER: NameMatcher = {
  names: ["发送"],
  roles: ["button"],
  excludeNames: ["发送消息"],
};

/** 导航后的页面安全检查:风控页/登录页直接抛契约异常(退出码 2/3) */
export async function navigateChecked(ctx: UiContext, url: string, settleMs = 3000): Promise<void> {
  await navigate(ctx, url, settleMs);
  if (ctx.dryRun) {
    return;
  }
  const snap = await takeSnapshot(ctx);
  checkPageState(snap);
}

/** 快照页面状态检查:URL 结构标记 + 登录页判定 */
export function checkPageState(snap: SnapshotResult): void {
  checkRiskMarkers(snap.page.url, { failed: false });
  if (/\/login(\b|\?|$)/i.test(snap.page.url)) {
    throw new CuaError("auth-expired", `页面跳转到登录页(登录态失效): ${snap.page.url}`);
  }
}

/** 等待简历详情页就绪(出现沟通入口或简历正文标志) */
export async function waitResumePageReady(ctx: UiContext): Promise<SnapshotResult> {
  const matcher: NameMatcher = {
    names: ["在线沟通", "继续沟通", "打招呼", "立即沟通", "工作经历", "求职意向"],
  };
  const found = await waitForMatch(ctx, matcher, { timeoutMs: 20_000 });
  if (found === null) {
    throw new CuaError("failed", "简历详情页未就绪(未找到沟通入口/简历正文标志);请确认登录态与页面结构");
  }
  checkPageState(found.snapshot);
  return found.snapshot;
}

/** 打开 IM 面板(幂等:输入框已在时直接返回) */
export async function ensureImPanel(ctx: UiContext): Promise<void> {
  const existing = matchRef(await takeSnapshot(ctx), IM_TEXTBOX_MATCHER);
  if (existing !== null) {
    ctx.log("[IM] 面板已打开");
    return;
  }
  const clicked = await clickName(ctx, "IM", IM_OPEN_MATCHER, { timeoutMs: 20_000 });
  if (clicked === null) {
    throw new CuaError("failed", "未找到 IM 聊天入口(在线沟通/继续沟通);请确认候选人会话存在");
  }
  const ready = await waitForMatch(ctx, IM_TEXTBOX_MATCHER, { timeoutMs: 15_000 });
  if (ready === null) {
    if (ctx.dryRun) {
      ctx.log("[IM] dry-run:未等到输入框就绪");
      return;
    }
    throw new CuaError("failed", "IM 面板未就绪(输入框未出现)");
  }
}

/**
 * 在已打开的 IM 面板中输入并发送消息,等待回显证据。
 * 返回证据文本;未观察到证据返回 null(由调用方决定严格性)。
 */
export async function sendMessageIntoIm(ctx: UiContext, text: string): Promise<string | null> {
  const typed = await typeIntoName(ctx, "话术", IM_TEXTBOX_MATCHER, text);
  if (!typed) {
    throw new CuaError("failed", "IM 输入框未找到,消息未发送");
  }
  if (ctx.dryRun) {
    ctx.log("[话术] dry-run:跳过发送");
    return null;
  }
  const sent = await clickName(ctx, "发送", IM_SEND_MATCHER, { timeoutMs: 8_000 });
  if (sent === null) {
    throw new CuaError("failed", "发送按钮未找到,消息未发送");
  }
  // 回显证据:消息文本前 12 字出现在页面任意位置
  const probe = text.slice(0, Math.min(12, text.length));
  const snap = await waitForEvidence(ctx, [probe], { timeoutMs: 12_000 });
  if (snap === null) {
    return null;
  }
  return findAnyText(snap, [probe]);
}
