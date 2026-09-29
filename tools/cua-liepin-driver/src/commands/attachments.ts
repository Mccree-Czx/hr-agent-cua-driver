/**
 * 附件命令 CLI 处理器(W4):attach-fetch / attach-download。
 *
 * 参数对齐后端(LiepinCommandService):
 *   attach-fetch    --imId <对方会话> --out <目录> --json
 *   attach-download --imId <对方会话> --out <目录> --json
 * UI 模式额外要求 --url(im_id → 会话 URL 映射待联调确认;见抽取契约)。
 */

import type { DriverConfig } from "../config.js";
import { flagValue, type ParsedArgs } from "../cli/args.js";
import { runAttachDownloadUi, runAttachFetchUi, type AttachOutcome } from "../flows/attachments.js";
import { withContext } from "./outbound.js";

function readCommonArgs(args: ParsedArgs, command: string): { url: string; outDir: string } | null {
  const url = flagValue(args, "url");
  if (url === null || url.trim() === "") {
    console.error(`${command}: UI 模式必须传 --url <会话页>(im_id → URL 映射待联调确认,见 docs/superpowers/specs/2026-09-29-ui-extraction-contract.md)`);
    return null;
  }
  const outDir = flagValue(args, "out");
  if (outDir === null || outDir.trim() === "") {
    console.error(`${command}: 必须传 --out <绝对目录>(后端传 attachWorkDir())`);
    return null;
  }
  return { url: url.trim(), outDir: outDir.trim() };
}

function printOutcome(outcome: AttachOutcome, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ ...outcome, ...(extra ?? {}) }));
}

/** attach-fetch:三态输出,始终 exit 0(业务失败交给后端留待处理) */
export async function handleAttachFetch(cfg: DriverConfig, args: ParsedArgs): Promise<number> {
  const common = readCommonArgs(args, "attach-fetch");
  if (common === null) {
    return 1;
  }
  const imId = flagValue(args, "imId") ?? undefined;
  const dryRun = args.flags["dry-run"] === true;
  return withContext(cfg, args, async (ctx) => {
    const outcome = await runAttachFetchUi(ctx, { pageUrl: common.url, imId, outDir: common.outDir, dryRun });
    printOutcome(outcome);
  });
}

/** attach-download:任一失败抛错(非零退出);成功输出成功形态 */
export async function handleAttachDownload(cfg: DriverConfig, args: ParsedArgs): Promise<number> {
  const common = readCommonArgs(args, "attach-download");
  if (common === null) {
    return 1;
  }
  const imId = flagValue(args, "imId") ?? undefined;
  const dryRun = args.flags["dry-run"] === true;
  return withContext(cfg, args, async (ctx) => {
    const outcome = await runAttachDownloadUi(ctx, { pageUrl: common.url, imId, outDir: common.outDir, dryRun });
    printOutcome(outcome);
  });
}
