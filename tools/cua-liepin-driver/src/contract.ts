/**
 * 退出码与错误契约(与 liepin-cli 保持一致,编排层/后端依赖):
 *   0 成功;1 一般错误;2 登录态失效;3 风控/安全异常。
 *
 * 注意:底层 `cua-driver call` 对"结构化拒绝(refusal)"也返回 exit 0,
 * 因此本层负责把拒绝/异常翻译为上述契约语义。
 */

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_AUTH_EXPIRED = 2;
export const EXIT_RISK_CONTROL = 3;

export type ErrorKind = "failed" | "auth-expired" | "risk-control";

export class CuaError extends Error {
  constructor(
    public readonly kind: ErrorKind,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "CuaError";
  }

  get exitCode(): number {
    switch (this.kind) {
      case "auth-expired":
        return EXIT_AUTH_EXPIRED;
      case "risk-control":
        return EXIT_RISK_CONTROL;
      default:
        return EXIT_FAILED;
    }
  }
}

/** 任意异常 → 契约退出码 */
export function exitCodeOf(err: unknown): number {
  if (err instanceof CuaError) {
    return err.exitCode;
  }
  return EXIT_FAILED;
}

/** 输出截断(错误消息用,避免把整页 JSON 灌进日志/告警) */
export function truncate(s: string, max = 300): string {
  return s.length <= max ? s : s.slice(0, max) + "...";
}

/**
 * 风控/登录态特征扫描(与后端 LiepinCliExecutor 的双档语义一致,防误熔断):
 * - 结构性标记(captchaPage / safe.liepin.com):全路径扫描——不会出现在正常业务文本里;
 * - 软标记(行为异常 / 安全验证 等中文短语):仅失败/超时路径扫描——
 *   候选人简历里的"安全验证"曾致连续三轮误熔断(2026-09-28 治理),不得在成功路径扫描。
 */
const STRUCTURAL_RISK_MARKERS = ["captchaPage", "safe.liepin.com"];
const SOFT_RISK_MARKERS = ["行为异常", "安全验证", "滑块验证"];
const NOT_LOGGED_MARKERS = ["未登录", "请先登录", "登录已过期", "need login"];

/** 检查产物文本中的风控/登录态特征;风控优先。failed=true 时启用软标记扫描。 */
export function checkRiskMarkers(text: string, context: { failed?: boolean } = {}): void {
  const lowered = text.toLowerCase();
  for (const marker of STRUCTURAL_RISK_MARKERS) {
    if (lowered.includes(marker.toLowerCase())) {
      throw new CuaError("risk-control", `检测到风控拦截特征 [${marker}]`);
    }
  }
  if (context.failed === true) {
    for (const marker of SOFT_RISK_MARKERS) {
      if (lowered.includes(marker.toLowerCase())) {
        throw new CuaError("risk-control", `检测到风控拦截特征 [${marker}]`);
      }
    }
  }
  for (const marker of NOT_LOGGED_MARKERS) {
    if (lowered.includes(marker.toLowerCase())) {
      throw new CuaError("auth-expired", `检测到登录态失效特征 [${marker}]`);
    }
  }
}
