/**
 * login 命令入口(W5):浏览器生命周期(缺窗口时自动启动)+ 登录态检测/等待。
 *
 * 后端契约(LoginService.doLogin):
 * - 输出含 "登录成功" 或 `"success": true` 视为成功;
 * - 失败(超时/风控卡住)置 NEED_SCAN,需人工重新扫码;
 * - 命令超时窗口 3 分钟(--timeout 默认 120s,略小于命令超时)。
 */

import { exitCodeOf, truncate } from "../contract.js";
import type { DriverConfig } from "../config.js";
import { DriverClient } from "../cua/driver-client.js";
import { ensureBrowserSession } from "../cua/session.js";
import type { UiContext } from "../cua/ui-actions.js";
import { runLogin } from "../flows/login.js";
import { flagValue, type ParsedArgs } from "../cli/args.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** login [--timeout <秒>] [--force] [--json] */
export async function handleLogin(cfg: DriverConfig, args: ParsedArgs): Promise<number> {
  const json = args.flags.json === true;
  const log = json ? (msg: string) => console.error(msg) : (msg: string) => console.log(msg);
  const timeoutSec = Number.parseInt(flagValue(args, "timeout") ?? "", 10) || 120;
  const force = args.flags.force === true || String(flagValue(args, "force")) === "true";

  const client = new DriverClient({ bin: cfg.bin, session: cfg.session, timeoutMs: cfg.callTimeoutMs });
  try {
    const session = await ensureBrowserSession(client, cfg, { launchIfMissing: true });
    log(`已附加窗口 pid=${session.window.pid} window=${session.window.windowId}`);
    const ctx: UiContext = { client, session, dryRun: false, log, sleep };
    const outcome = await runLogin(ctx, { timeoutMs: timeoutSec * 1_000, force });
    console.log(JSON.stringify(outcome));
    return outcome.success ? 0 : 1;
  } catch (err) {
    console.error(`错误: ${truncate(String(err instanceof Error ? err.message : err), 500)}`);
    return exitCodeOf(err);
  }
}
