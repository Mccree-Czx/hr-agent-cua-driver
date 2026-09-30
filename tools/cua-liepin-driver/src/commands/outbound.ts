/**
 * 外发类命令 CLI 处理器(W2):greet / request-resume / send-message。
 *
 * 输出契约(后端 LiepinCommandService → JsonExtractor 依赖):
 * - stdout 末尾为单个 JSON 对象;--json 模式下步骤日志走 stderr,避免混入 JSON;
 * - 退出码:0 成功 / 1 失败 / 2 登录态失效 / 3 风控异常。
 */

import { exitCodeOf, truncate } from "../contract.js";
import type { DriverConfig } from "../config.js";
import { DriverClient } from "../cua/driver-client.js";
import { assertDesktopUnlocked, attachBrowserSession } from "../cua/session.js";
import type { UiContext } from "../cua/ui-actions.js";
import { ensureImPanel, navigateChecked, resumeDetailUrl, sendMessageIntoIm, waitResumePageReady } from "../flows/common.js";
import { runGreet } from "../flows/greet.js";
import { runRequestResume } from "../flows/request-resume.js";
import { flagValue, type ParsedArgs } from "../cli/args.js";

function isJson(args: ParsedArgs): boolean {
  return args.flags.json === true;
}

function makeLogger(json: boolean): (msg: string) => void {
  return json ? (msg) => console.error(msg) : (msg) => console.log(msg);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 建立 UI 上下文(附加/绑定猎聘 Chrome 窗口);读类命令处理复用 */
export async function withContext(
  cfg: DriverConfig,
  args: ParsedArgs,
  run: (ctx: UiContext) => Promise<void>,
): Promise<number> {
  const json = isJson(args);
  const log = makeLogger(json);
  const client = new DriverClient({ bin: cfg.bin, session: cfg.session, timeoutMs: cfg.callTimeoutMs });
  try {
    // 锁屏快速失败:持续部署场景下无人值守锁屏会导致渲染冻结/快照静默降级
    await assertDesktopUnlocked(client);
    const session = await attachBrowserSession(client, cfg);
    log(`已附加窗口 pid=${session.window.pid} window=${session.window.windowId}`);
    const ctx: UiContext = {
      client,
      session,
      dryRun: args.flags["dry-run"] === true,
      log,
      sleep,
      // 会话标签轮换(2026-09-30):旧标签会持续返回残缺快照,换新标签并重新附加
      rotateSession: async () => {
        const label = await client.rotateSession();
        if (label === null) {
          return false;
        }
        const fresh = await attachBrowserSession(client, cfg);
        ctx.session = fresh;
        log(`会话标签已轮换 → ${label}(重新附加窗口 pid=${fresh.window.pid})`);
        return true;
      },
    };
    await run(ctx);
    return 0;
  } catch (err) {
    console.error(`错误: ${truncate(String(err instanceof Error ? err.message : err), 500)}`);
    return exitCodeOf(err);
  }
}

/** greet <resume_id> --ejobId <id> [--jobTitle <标题>] [--message <话术>] [--dry-run] [--allow-unverified] [--json] */
export async function handleGreet(cfg: DriverConfig, args: ParsedArgs): Promise<number> {
  const usercId = args.positional[0] ?? "";
  if (usercId === "") {
    console.error("greet:缺少候选 resume_id(位置参数)");
    return 1;
  }
  const ejobId = flagValue(args, "ejobId") ?? flagValue(args, "jobId") ?? "";
  const jobTitle = flagValue(args, "jobTitle") ?? undefined;
  const message = flagValue(args, "message") ?? "";
  const allowUnverified = args.flags["allow-unverified"] === true;

  return withContext(cfg, args, async (ctx) => {
    if (ejobId === "") {
      ctx.log("[提示] 未传 --ejobId(UI 模式不用于选择职位,仅作审计字段)");
    }
    const outcome = await runGreet(ctx, { usercId, ejobId, message, jobTitleHint: jobTitle, allowUnverified });
    const payload = {
      success: outcome.success,
      message: outcome.alreadyChatted
        ? "已存在会话,跳过打招呼" + (outcome.messageSent ? ";话术已发送" : "")
        : "已发起沟通" + (outcome.messageSent ? "并发送自定义消息" : ""),
      usercId: "",
      resume_id: usercId,
      im_id: "",
      opened_new_chat: !outcome.alreadyChatted,
      ejobId,
      job_title: jobTitle ?? "",
      evidence: outcome.evidence,
      steps: outcome.steps,
    };
    console.log(JSON.stringify(payload));
  });
}

/** request-resume <resume_id> [--imId <对方会话>] [--dry-run] [--allow-unverified] [--json] */
export async function handleRequestResume(cfg: DriverConfig, args: ParsedArgs): Promise<number> {
  const resumeId = args.positional[0] ?? "";
  if (resumeId === "") {
    console.error("request-resume:缺少 resume_id(位置参数;不接受 im_id)");
    return 1;
  }
  const imId = flagValue(args, "imId") ?? "";
  const allowUnverified = args.flags["allow-unverified"] === true;

  return withContext(cfg, args, async (ctx) => {
    const outcome = await runRequestResume(ctx, { resumeId, imId, allowUnverified });
    console.log(JSON.stringify({
      success: outcome.success,
      confirmed: outcome.confirmed,
      message: outcome.message,
      name: "",
      resume_id: outcome.resume_id,
      im_id: outcome.im_id,
      evidence: outcome.evidence,
      steps: outcome.steps,
    }));
  });
}

/** send-message <resume_id> --text <消息> [--dry-run] [--json] */
export async function handleSendMessage(cfg: DriverConfig, args: ParsedArgs): Promise<number> {
  const resumeId = args.positional[0] ?? "";
  const text = flagValue(args, "text") ?? "";
  if (resumeId === "" || text === "") {
    console.error("send-message:需要 resume_id(位置参数)与 --text <消息>");
    return 1;
  }
  return withContext(cfg, args, async (ctx) => {
    await navigateChecked(ctx, resumeDetailUrl(resumeId));
    await waitResumePageReady(ctx);
    await ensureImPanel(ctx);
    const evidence = await sendMessageIntoIm(ctx, text);
    console.log(JSON.stringify({
      success: true,
      message_sent: evidence !== null,
      resume_id: resumeId,
      evidence: evidence ?? (ctx.dryRun ? "dry-run" : "unverified"),
    }));
  });
}
