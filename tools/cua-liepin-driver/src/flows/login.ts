/**
 * 登录流程(W5,UI 通道)。
 *
 * 语义对齐上游 liepin-cli login 命令:
 * - 复用优先:现有登录态有效 → 直接成功(`reused:true`),不重启浏览器;
 * - 未登录:浏览器窗口等待人工扫码,周期性 UI 探测登录态;
 * - 风控页(安全验证):提示人工处理并继续等待;
 * - 超时:`success:false`(后端据此置 NEED_SCAN)。
 *
 * 登录态判定不依赖内部接口(UI 通道约束):
 * - 工作台导航特征(人才推荐 + 职位管理)同时出现 → ok;
 * - URL 命中登录页(/login|/signin|/passport) → anonymous;
 * - 安全验证特征且无工作台导航 → risk;
 * - 其余保守判 anonymous(继续等待,失败安全)。
 */

import { CuaError } from "../contract.js";
import type { SnapshotResult } from "../cua/session.js";
import { takeSnapshot, type UiContext } from "../cua/ui-actions.js";

/** 猎聘招聘者端首页(登录落点) */
export const LOGIN_HOME_URL = "https://lpt.liepin.com/";

/** 探测间隔(扫码期间不宜高频;5s 与上游 liepin-cli 的探测节拍一致) */
export const LOGIN_PROBE_INTERVAL_MS = 5_000;

export type LoginState = "ok" | "anonymous" | "risk";

/** 页面级登录态判定(纯函数,便于单测) */
export function classifyLoginPage(pageUrl: string, texts: string[]): LoginState {
  const joined = texts.join("\n");
  if (/safe\.liepin\.com|captchaPage/i.test(pageUrl)) {
    return "risk";
  }
  if (/\/login|\/signin|\/passport/i.test(pageUrl)) {
    return "anonymous";
  }
  if (/(行为异常|安全验证|滑块验证)/.test(joined)) {
    // 风控页同样可能带"招聘"字样(上游教训),用工作台导航双特征排除误判
    if (!/(人才推荐[\s\S]*职位管理|职位管理[\s\S]*人才推荐)/.test(joined)) {
      return "risk";
    }
  }
  if (/人才推荐[\s\S]*职位管理|职位管理[\s\S]*人才推荐/.test(joined)) {
    return "ok";
  }
  return "anonymous";
}

/** 快照 → 登录态判定 */
export function classifyLoginSnapshot(snap: SnapshotResult): LoginState {
  const texts = snap.refs.filter((r) => r.name !== null).map((r) => r.name as string);
  return classifyLoginPage(snap.page.url, texts);
}

export interface LoginProbeResult {
  state: LoginState;
  pageUrl: string;
}

/** 导航首页并探测登录态(单次) */
export async function probeLoginState(ctx: UiContext): Promise<LoginProbeResult> {
  await ctx.client.requireOk("browser_navigate", {
    target_id: ctx.session.targetId,
    tab_id: ctx.session.activeTabId,
    url: LOGIN_HOME_URL,
  });
  await ctx.sleep(3_500);
  const snap = await takeSnapshot(ctx);
  return { state: classifyLoginSnapshot(snap), pageUrl: snap.page.url };
}

export interface LoginInput {
  timeoutMs: number;
  /** 强制走一遍重新登录(跳过复用快速路径) */
  force?: boolean;
}

export interface LoginOutcome {
  success: boolean;
  reused: boolean;
  message: string;
  state: LoginState;
  elapsed_ms: number;
}

/** 时钟接缝(ctx.now 用于测试虚拟时钟,与 ui-actions 一致) */
function nowOf(ctx: UiContext): number {
  return ctx.now !== undefined ? ctx.now() : Date.now();
}

/**
 * 执行登录:
 * 1) 首探;ok 且非 force → 复用成功;
 * 2) 否则轮询等待扫码(风控页提示人工过验证);
 * 3) 超时失败。
 */
export async function runLogin(ctx: UiContext, input: LoginInput): Promise<LoginOutcome> {
  const start = nowOf(ctx);
  const first = await probeLoginState(ctx);
  if (first.state === "ok" && input.force !== true) {
    ctx.log("✅ 登录态仍然有效,无需重新登录(浏览器未重启)");
    return {
      success: true,
      reused: true,
      message: "登录态仍然有效(复用现有会话,未重启浏览器)",
      state: "ok",
      elapsed_ms: Date.now() - start,
    };
  }
  if (first.state === "risk") {
    ctx.log("⚠️  猎聘弹出了安全验证(行为异常),请在浏览器窗口里完成滑块验证,这里会继续等待");
  }

  ctx.log("═══════════════════════════════════════════════");
  ctx.log("  请在浏览器中完成登录(扫码或账号密码)");
  ctx.log("  这是招聘者端 (lpt.liepin.com);登录成功后会自动检测");
  ctx.log("═══════════════════════════════════════════════");

  const deadline = start + input.timeoutMs;
  let state: LoginState = first.state;
  let riskNoticed = first.state === "risk";
  while (nowOf(ctx) < deadline) {
    await ctx.sleep(LOGIN_PROBE_INTERVAL_MS);
    const probe = await probeLoginState(ctx);
    state = probe.state;
    if (state === "ok") {
      ctx.log("✅ 登录成功!");
      return {
        success: true,
        reused: false,
        message: "登录成功",
        state: "ok",
        elapsed_ms: nowOf(ctx) - start,
      };
    }
    if (state === "risk" && !riskNoticed) {
      riskNoticed = true;
      ctx.log("⚠️  猎聘弹出了安全验证(行为异常),请在浏览器窗口里完成滑块验证,这里会继续等待");
    }
  }

  const message = state === "risk" || riskNoticed ? "卡在猎聘安全验证,登录未完成" : "登录超时";
  ctx.log(`❌ ${message}`);
  return { success: false, reused: false, message, state, elapsed_ms: nowOf(ctx) - start };
}

/** 便捷检查:当前是否已登录(供其他流程判定,不导航) */
export async function isLoggedIn(ctx: UiContext): Promise<boolean> {
  const snap = await takeSnapshot(ctx);
  return classifyLoginSnapshot(snap) === "ok";
}

/** 断言已登录;未登录抛 auth-expired(退出码 2) */
export async function assertLoggedIn(ctx: UiContext, checkpoint: string): Promise<void> {
  if (!(await isLoggedIn(ctx))) {
    throw new CuaError("auth-expired", `[${checkpoint}] 登录态失效(页面未呈现工作台导航)`);
  }
}
