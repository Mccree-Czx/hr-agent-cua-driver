/**
 * 读类命令 CLI 处理器(W3):resume / recommend / search / chatlist / chatmsg / joblist。
 *
 * - 读操作始终执行导航与快照;`--dry-run` 仅抑制"点击穿透取 ID"环节;
 * - 页面 URL 未联调确认的命令(chatlist/chatmsg/search/joblist)必须显式传 `--url`;
 * - 输出 JSON 单对象于 stdout;--json 模式下步骤日志走 stderr。
 */

import type { DriverConfig } from "../config.js";
import { flagValue, type ParsedArgs } from "../cli/args.js";
import { extractJobRecords } from "../cua/extract.js";
import {
  runReadChatMsg,
  runReadList,
  runReadPageGeneric,
  runReadRecommend,
  type RawPageOutcome,
} from "../flows/read-pages.js";
import { runReadResume } from "../flows/read-resume.js";
import { withContext } from "./outbound.js";

function requireUrl(args: ParsedArgs, command: string, hint: string): string | null {
  const url = flagValue(args, "url");
  if (url === null || url.trim() === "") {
    console.error(`${command}: 必须传 --url <页面URL>(${hint};页面公式待登录联调确认,见 docs/superpowers/specs/2026-09-29-ui-extraction-contract.md)`);
    return null;
  }
  return url.trim();
}

function printRaw(outcome: RawPageOutcome): void {
  console.log(JSON.stringify(outcome));
}

/** resume <resume_id> [--json] */
export async function handleResume(cfg: DriverConfig, args: ParsedArgs): Promise<number> {
  const resumeId = args.positional[0] ?? "";
  if (resumeId === "") {
    console.error("resume:缺少 resume_id(位置参数)");
    return 1;
  }
  return withContext(cfg, args, async (ctx) => {
    const outcome = await runReadResume(ctx, { resumeId });
    console.log(JSON.stringify(outcome));
  });
}

/** recommend [--jobId <id>] [--url <页面>] [--capture-ids --ref <pN:M> ...] [--id-param resIdEncode] [--dry-run] [--json] */
export async function handleRecommend(cfg: DriverConfig, args: ParsedArgs): Promise<number> {
  const jobId = flagValue(args, "jobId") ?? undefined;
  const pageUrl = flagValue(args, "url") ?? undefined;
  const idParam = flagValue(args, "id-param") ?? undefined;
  const captureRefs = args.flags["capture-ids"] === true ? (args.multi.ref ?? []) : [];
  const dryRun = args.flags["dry-run"] === true;
  if (args.flags["capture-ids"] === true && captureRefs.length === 0) {
    console.error("recommend:--capture-ids 需要至少一个 --ref <pN:M>(联调期原语)");
    return 1;
  }
  return withContext(cfg, args, async (ctx) => {
    const outcome = await runReadRecommend(ctx, { jobId, pageUrl, captureRefs, idParam, dryRun });
    printRaw(outcome);
  });
}

/** search --url <页面> [--json] */
export async function handleSearch(cfg: DriverConfig, args: ParsedArgs): Promise<number> {
  const url = requireUrl(args, "search", "人才搜索页");
  if (url === null) {
    return 1;
  }
  return withContext(cfg, args, async (ctx) => {
    printRaw(await runReadPageGeneric(ctx, url, "搜索页"));
  });
}

/** chatlist --url <页面> [--json] */
export async function handleChatlist(cfg: DriverConfig, args: ParsedArgs): Promise<number> {
  const url = requireUrl(args, "chatlist", "沟通列表页;注意旧 /im 路由已被猎聘下线");
  if (url === null) {
    return 1;
  }
  return withContext(cfg, args, async (ctx) => {
    printRaw(await runReadPageGeneric(ctx, url, "沟通列表页"));
  });
}

/** chatmsg --url <会话页> [--imId <对方会话>] [--json] */
export async function handleChatMsg(cfg: DriverConfig, args: ParsedArgs): Promise<number> {
  const url = requireUrl(args, "chatmsg", "会话页(可直接打开某候选人的沟通页)");
  if (url === null) {
    return 1;
  }
  const imId = flagValue(args, "imId") ?? undefined;
  const dryRun = args.flags["dry-run"] === true;
  return withContext(cfg, args, async (ctx) => {
    printRaw(await runReadChatMsg(ctx, { pageUrl: url, imId, dryRun }));
  });
}

/**
 * joblist [--url <页面>] [--with-ids] [--capture-ids --ref <pN:M> ...] [--id-param ejob_id] [--dry-run] [--json]
 * 默认页 https://lpt.liepin.com/job/manager(2026-09-29 联调验证);
 * 穿透:点击职位行 → 详情页 URL 的 ejob_id 参数(已验证);
 * --with-ids: 自动逐行穿透并把 job_id 合并进 records(逐行点击约 6-8s/行,上限 20 行)。
 */
export async function handleJoblist(cfg: DriverConfig, args: ParsedArgs): Promise<number> {
  const url = (flagValue(args, "url") ?? "https://lpt.liepin.com/job/manager").trim();
  const idParam = flagValue(args, "id-param") ?? "ejob_id";
  const withIds = args.flags["with-ids"] === true;
  const captureRefs = args.flags["capture-ids"] === true ? (args.multi.ref ?? []) : [];
  const dryRun = args.flags["dry-run"] === true;
  if (args.flags["capture-ids"] === true && captureRefs.length === 0) {
    console.error("joblist:--capture-ids 需要至少一个 --ref <pN:M>(联调期原语)");
    return 1;
  }
  return withContext(cfg, args, async (ctx) => {
    printRaw(
      await runReadList(ctx, {
        pageUrl: url,
        captureRefs,
        idParam,
        dryRun,
        label: "职位列表页",
        recordsExtractor: (snap) => extractJobRecords(snap),
        autoCaptureRows: withIds,
      }),
    );
  });
}
