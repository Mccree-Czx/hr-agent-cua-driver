/**
 * 管理类命令 CLI 处理器(W5):jobpublish / jobdelete。
 *
 * 退出码语义(后端 JdPublishService 依赖 stdout JSON 的 success 字段):
 * - jobpublish:dry-run → 0(诊断);成功 → 0;validation_blocked/unknown → 1;
 * - jobdelete:dry-run → 0(诊断);ended → 0;ended_deletion_pending → 1(明确未完成);
 *   not_found/need_manual/unknown → 1。
 */

import { exitCodeOf, truncate } from "../contract.js";
import type { DriverConfig } from "../config.js";
import { flagValue, type ParsedArgs } from "../cli/args.js";
import { parsePublishData, runJobpublish } from "../flows/jobpublish.js";
import { runJobdelete } from "../flows/jobdelete.js";
import { withContext } from "./outbound.js";

/** jobpublish --data <JSON> [--job <参考>] [--draft-only] [--dry-run] [--json] */
export async function handleJobpublish(cfg: DriverConfig, args: ParsedArgs): Promise<number> {
  const data = parsePublishData(flagValue(args, "data") ?? "");
  const draftOnly = args.flags["draft-only"] === true;
  const referenceJob = flagValue(args, "job") ?? "";
  if (referenceJob !== "") {
    console.error("jobpublish: UI 通道 v1 不使用 --job(参考职位地址复用待校准),参数被忽略");
  }

  let exitCode = 0;
  const ctxCode = await withContext(cfg, args, async (ctx) => {
    const outcome = await runJobpublish(ctx, { data, draftOnly });
    const message =
      outcome.status === "draft_saved"
        ? "草稿已保存(未发布)"
        : outcome.status === "published"
          ? "职位已发布"
          : outcome.status === "validation_blocked"
            ? `表单校验未通过(字段未填全): ${outcome.feedback.join("; ")}`
            : outcome.status === "dry_run"
              ? "dry-run:定位完成,未提交"
              : "未观察到成功反馈(待联调复核)";
    console.log(
      JSON.stringify({
        success: outcome.success,
        status: outcome.status,
        message,
        title: outcome.title,
        job_id: "",
        draft_id: "",
        feedback: outcome.feedback,
        unvalidated_fields: outcome.unvalidated_fields,
        steps: outcome.steps,
      }),
    );
    if (!outcome.success && outcome.status !== "dry_run") {
      exitCode = 1;
    }
  });
  return ctxCode !== 0 ? ctxCode : exitCode;
}

/** jobdelete --job <ejob_id[,id..]> [--confirm-destructive] [--dry-run] [--json] */
export async function handleJobdelete(cfg: DriverConfig, args: ParsedArgs): Promise<number> {
  const jobRaw = flagValue(args, "job") ?? "";
  const jobIds = jobRaw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (jobIds.length === 0) {
    console.error("jobdelete:缺少 --job(职位 ID,支持逗号分隔批量)");
    return 1;
  }
  const confirmDestructive = args.flags["confirm-destructive"] === true;

  let exitCode = 0;
  const ctxCode = await withContext(cfg, args, async (ctx) => {
    const outcome = await runJobdelete(ctx, { jobIds, confirmDestructive });
    const message =
      outcome.status === "dry_run"
        ? "dry-run:列表诊断完成,未执行任何破坏性动作"
        : outcome.status === "not_found"
          ? "未找到匹配的职位"
          : outcome.status === "need_manual"
            ? "需人工处理:无法安全精确定位目标行(详见 steps)"
            : outcome.status === "ended_deletion_pending"
              ? "已结束发布,但「删除」入口未校准(待 W5 续);猎聘职位仍存在"
              : outcome.status === "ended"
                ? `已删除 ${outcome.deleted.length} 个职位`
                : "结果不确定,请人工核对";
    console.log(
      JSON.stringify({
        success: outcome.success,
        status: outcome.status,
        message,
        deleted: outcome.deleted,
        ended: outcome.ended,
        deletion_pending: outcome.deletion_pending,
        mapping: outcome.mapping,
        feedback: outcome.feedback,
        steps: outcome.steps,
      }),
    );
    if (!outcome.success && outcome.status !== "dry_run") {
      exitCode = 1;
    }
  });
  return ctxCode !== 0 ? ctxCode : exitCode;
}
