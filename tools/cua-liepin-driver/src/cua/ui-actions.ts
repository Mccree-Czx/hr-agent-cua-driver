/**
 * UI 动作基础层(W2):快照匹配器 + 等待/点击/键入/导航 的通用步骤。
 *
 * 供各业务流程(flows)复用的"代码驱动步骤机"原语:
 * - 一切动作前先取语义快照;动作后由调用方用新的快照验证(旧 ref 随新快照失效);
 * - `dry-run` 模式只定位不点击/不输入(用于登录后的三要素/流程预验证);
 * - 匹配器按候选名顺序优先,支持角色/动作/排除项约束。
 */

import type { DriverClient } from "./driver-client.js";
import { clickRef, snapshot, type BrowserSession, type SnapshotRef, type SnapshotResult } from "./session.js";

/** 业务流程上下文(测试可注入脚本化的 client/sleep/now) */
export interface UiContext {
  client: DriverClient;
  session: BrowserSession;
  dryRun: boolean;
  log: (msg: string) => void;
  sleep: (ms: number) => Promise<void>;
  /** 时钟接缝:测试注入虚拟时钟,避免真实等待超时 */
  now?: () => number;
  /** readPage 内容充分性阈值覆盖(测试用 0 关闭校验;缺省 MIN_PAGE_LINES) */
  minPageLines?: number;
  /** 会话标签轮换(旧标签连续残缺时;成功则 ctx.session 已更新/重新附加) */
  rotateSession?: () => Promise<boolean>;
}

/** 元素匹配器:names 按序优先(包含匹配);roles/actions 为限定;excludeNames 排除 */
export interface NameMatcher {
  names: string[];
  roles?: string[];
  actions?: string[];
  excludeNames?: string[];
}

/** 在快照中按匹配器定位元素(纯函数,便于单测) */
export function matchRef(snap: SnapshotResult, matcher: NameMatcher): SnapshotRef | null {
  for (const name of matcher.names) {
    const found = snap.refs.find(
      (r) =>
        r.name !== null &&
        r.name.includes(name) &&
        (matcher.roles === undefined || matcher.roles.includes(r.role)) &&
        (matcher.actions === undefined || matcher.actions.every((a) => r.actions.includes(a))) &&
        !(matcher.excludeNames ?? []).some((ex) => r.name !== null && r.name.includes(ex)),
    );
    if (found !== undefined) {
      return found;
    }
  }
  return null;
}

/** 快照中是否存在任一候选文本(证据检查用,返回命中的候选) */
export function findAnyText(snap: SnapshotResult, texts: string[]): string | null {
  for (const text of texts) {
    if (snap.refs.some((r) => r.name !== null && r.name.includes(text))) {
      return text;
    }
  }
  return null;
}

/** 取一张全页语义快照(并做页面级风控/登录态检查由调用方负责) */
export async function takeSnapshot(ctx: UiContext): Promise<SnapshotResult> {
  return snapshot(ctx.client, ctx.session);
}

/** 浏览器导航(settleMs 为导航后的静置等待) */
export async function navigate(ctx: UiContext, url: string, settleMs = 3000): Promise<void> {
  ctx.log(`导航 → ${url}`);
  if (ctx.dryRun) {
    return;
  }
  await ctx.client.requireOk("browser_navigate", {
    target_id: ctx.session.targetId,
    tab_id: ctx.session.activeTabId,
    url,
  });
  await ctx.sleep(settleMs);
}

export interface WaitOptions {
  timeoutMs?: number;
  pollMs?: number;
}

function nowOf(ctx: UiContext): number {
  return ctx.now !== undefined ? ctx.now() : Date.now();
}

/** 轮询快照直至匹配命中;超时返回 null(不抛错,由调用方决定语义) */
export async function waitForMatch(
  ctx: UiContext,
  matcher: NameMatcher,
  opts: WaitOptions = {},
): Promise<{ ref: SnapshotRef; snapshot: SnapshotResult } | null> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const pollMs = opts.pollMs ?? 1_500;
  const deadline = nowOf(ctx) + timeoutMs;
  for (;;) {
    const snap = await takeSnapshot(ctx);
    const ref = matchRef(snap, matcher);
    if (ref !== null) {
      return { ref, snapshot: snap };
    }
    if (nowOf(ctx) >= deadline) {
      return null;
    }
    await ctx.sleep(pollMs);
  }
}

/**
 * 定位并点击;未找到返回 null。
 * action 名称用于日志(step machine 可读性),不影响行为。
 */
export async function clickName(
  ctx: UiContext,
  action: string,
  matcher: NameMatcher,
  opts: WaitOptions = {},
): Promise<{ ref: SnapshotRef; snapshot: SnapshotResult } | null> {
  const found = await waitForMatch(ctx, matcher, opts);
  if (found === null) {
    return null;
  }
  ctx.log(`[${action}] 定位「${found.ref.name}」(${found.ref.ref})`);
  if (ctx.dryRun) {
    ctx.log(`[${action}] dry-run:不点击`);
    return found;
  }
  await clickRef(ctx.client, ctx.session, found.ref.ref);
  ctx.log(`[${action}] 已点击`);
  return found;
}

/** 定位并输入文本(replace=true 覆盖原内容);未找到返回 false */
export async function typeIntoName(
  ctx: UiContext,
  action: string,
  matcher: NameMatcher,
  text: string,
  opts: WaitOptions = {},
): Promise<boolean> {
  const found = await waitForMatch(ctx, matcher, opts);
  if (found === null) {
    return false;
  }
  ctx.log(`[${action}] 定位输入框「${found.ref.name ?? found.ref.role}」(${found.ref.ref})`);
  if (ctx.dryRun) {
    ctx.log(`[${action}] dry-run:不输入`);
    return true;
  }
  await ctx.client.requireOk("browser_type", {
    target_id: ctx.session.targetId,
    tab_id: ctx.session.activeTabId,
    ref: found.ref.ref,
    text,
    replace: true,
  });
  ctx.log(`[${action}] 已输入 ${text.length} 字`);
  return true;
}

/** 点击后等待成功证据出现(轮询全页快照查找候选文本) */
export async function waitForEvidence(
  ctx: UiContext,
  texts: string[],
  opts: WaitOptions = {},
): Promise<SnapshotResult | null> {
  const timeoutMs = opts.timeoutMs ?? 12_000;
  const pollMs = opts.pollMs ?? 1_500;
  const deadline = nowOf(ctx) + timeoutMs;
  for (;;) {
    const snap = await takeSnapshot(ctx);
    if (findAnyText(snap, texts) !== null) {
      return snap;
    }
    if (nowOf(ctx) >= deadline) {
      return null;
    }
    await ctx.sleep(pollMs);
  }
}
