/**
 * 删除职位流程(W5,UI 通道)。
 *
 * 已校准(2026-09-29 真机):
 * - 列表页:https://lpt.liepin.com/job/manager;
 * - 职位行 = 可点击职位名 link(点击进入 job/detail/preview?ejob_id=xxx,取 ID 已验证);
 * - 勾选:仅「全选」可定位(semantic 中列表区最后一个可点击 labeltext;UIA CheckBox label=全选);
 *   单行 checkbox 在 semantic 与 UIA 均无节点 → 多职位场景无法精确勾选单行;
 * - 勾选后批量条「刷新/结束」由 disabled(actions=[]) 变 enabled(actions 含 click);
 * - 上游语义:先"结束发布"再"删除";批量条无独立「删除」→ 删除入口疑在"已关闭"页签(待校准)。
 *
 * v1 边界(安全优先,防误伤):
 * - dry-run:只报告列表行数与 ref,不点击不映射;
 * - 非 dry-run:先穿透映射每行 ejob_id(点击行→读 URL→回列表),匹配 --job;
 *   仅当「目标职位 == 当前列表全部可见行」时才执行 全选→结束(否则拒绝,输出 need_manual);
 *   「删除」步骤未校准:执行后输出 deletion_pending=true(不谎报成功)。
 */

import { CuaError } from "../contract.js";
import { queryParam } from "../cua/extract.js";
import type { SnapshotRef, SnapshotResult } from "../cua/session.js";
import { clickRef } from "../cua/session.js";
import { matchRef, takeSnapshot, type NameMatcher, type UiContext } from "../cua/ui-actions.js";

/** 职位列表页 */
export const JOB_MANAGER_URL = "https://lpt.liepin.com/job/manager";

/** 顶部导航 link 白名单(与职位行 link 区分) */
const NAV_LINK_NAMES = [
  "人才推荐", "职位管理", "搜索人才", "沟通", "人才管理",
  "猎头服务", "提效服务", "问 Lily", "意向人选", "急聘置顶", "火爆刷",
];

/** 穿透映射上限(防御:异常页面结构导致行数爆炸) */
const MAX_ROWS = 30;

/** 目标行的匹配上限(超过则拒绝执行,防批量误伤) */
export const MAX_DELETE_TARGETS = 5;

/** 「结束」按钮(勾选后启用;actions 含 click 才算就绪) */
export const END_BUTTON_MATCHER: NameMatcher = {
  names: ["结束"],
  roles: ["button"],
  actions: ["click"],
  excludeNames: ["已结束"],
};

/** 「删除」按钮(2026-09-29 联调实测:待发布/草稿页签勾选后出现,可访问名 "delete 删除") */
export const DELETE_BUTTON_MATCHER: NameMatcher = {
  names: ["删除"],
  roles: ["button"],
  actions: ["click"],
};

/** 删除确认弹窗的确认按钮(实测同文案 "delete 删除";取最后一个可点删除按钮) */
export const DELETE_CONFIRM_TEXT_RE = /您确定要删除|确定要删除/;

/** 删除成功/空列表特征 */
export const DELETE_SUCCESS_RE = /(删除成功|操作成功|已删除)/;

/** 结束确认弹窗按钮候选(未完整校准;未命中则不点,报告人工) */
export const END_CONFIRM_MATCHER: NameMatcher = {
  names: ["确定", "确认", "确认结束", "结束职位"],
  roles: ["button"],
};

/** 成功/状态反馈文案 */
export const END_SUCCESS_RE = /(已结束|结束成功|操作成功|下线成功)/;

/** 从快照中识别职位行 link(过滤导航/分页) */
export function findJobRows(snap: SnapshotResult): SnapshotRef[] {
  return snap.refs.filter(
    (r) =>
      r.role === "link" &&
      r.name !== null &&
      r.name.length >= 4 &&
      r.name.length <= 40 &&
      (r.visibility === "in_viewport" || r.visibility === "near_viewport") &&
      !NAV_LINK_NAMES.some((n) => (r.name as string).includes(n)) &&
      !/^\d+\s*\/\s*\d+$/.test(r.name),
  );
}

/** 列表区「全选」勾选框(semantic:最后一个可点击 labeltext) */
export function findSelectAll(snap: SnapshotResult): SnapshotRef | null {
  const labels = snap.refs.filter((r) => r.role === "labeltext" && r.actions.includes("click"));
  return labels.length > 0 ? labels[labels.length - 1] : null;
}

export interface JobRowMapping {
  title: string;
  ejobId: string | null;
}

export interface JobdeleteInput {
  jobIds: string[];
  /** 二次确认闸:非 dry-run 必须显式开启(破坏性动作防护) */
  confirmDestructive: boolean;
}

export type JobdeleteStatus =
  | "dry_run"
  | "need_manual"
  | "not_found"
  | "ended_deletion_pending"
  | "ended"
  | "deleted"
  | "unknown";

export interface JobdeleteOutcome {
  success: boolean;
  status: JobdeleteStatus;
  deleted: string[];
  ended: string[];
  /** 已执行"结束"但"删除"入口未校准 → 明确未完成语义 */
  deletion_pending: boolean;
  mapping: JobRowMapping[];
  feedback: string[];
  steps: string[];
}

/** 页签切换(幂等:已在该页签时点击无害) */
export async function switchTab(ctx: UiContext, tabName: string): Promise<void> {
  const snap = await takeSnapshot(ctx);
  const tab = snap.refs.find((r) => r.name === tabName && r.actions.includes("click"));
  if (tab !== undefined) {
    await clickRef(ctx.client, ctx.session, tab.ref);
    await ctx.sleep(2_000);
  }
}

/**
 * 待发布页签的删除路径(2026-09-29 真机验证:全选 → 「delete 删除」→
 * 确认弹窗「您确定要删除?」→ 行消失即为成功)。
 */
async function deleteViaPendingTab(
  ctx: UiContext,
  mapping: JobRowMapping[],
  matched: JobRowMapping[],
  steps: string[],
): Promise<JobdeleteOutcome> {
  const fail = (status: JobdeleteStatus, message: string): JobdeleteOutcome => {
    steps.push(message);
    return {
      success: false,
      status,
      deleted: [],
      ended: [],
      deletion_pending: false,
      mapping,
      feedback: [],
      steps,
    };
  };

  if (mapping.length !== matched.length) {
    return fail(
      "need_manual",
      `目标 ${matched.length} 个 ≠ 列表 ${mapping.length} 行;单行勾选不可定位,拒绝全选以免误伤`,
    );
  }

  const snap2 = await takeSnapshot(ctx);
  const selectAll = findSelectAll(snap2);
  if (selectAll === null) {
    return fail("unknown", "未找到全选勾选框(页面结构可能变化)");
  }
  await clickRef(ctx.client, ctx.session, selectAll.ref);
  steps.push("已勾选(全选)");
  await ctx.sleep(1_200);

  const snap3 = await takeSnapshot(ctx);
  const delBtn = matchRef(snap3, DELETE_BUTTON_MATCHER);
  if (delBtn === null) {
    return fail("unknown", "勾选后「删除」按钮未就绪(disabled 或未出现)");
  }
  await clickRef(ctx.client, ctx.session, delBtn.ref);
  steps.push(`已点击「${delBtn.name ?? "删除"}」`);
  await ctx.sleep(1_800);

  // 确认弹窗(实测文本:删除职位会将对应职位下的应聘简历也一起删除,您确定要删除?)
  const snap4 = await takeSnapshot(ctx);
  const dialogText = snap4.refs.find((r) => r.name !== null && DELETE_CONFIRM_TEXT_RE.test(r.name));
  if (dialogText !== undefined) {
    const dels = snap4.refs.filter(
      (r) => r.role === "button" && r.name !== null && /删除/.test(r.name) && r.actions.includes("click"),
    );
    const confirm = dels[dels.length - 1];
    if (confirm === undefined) {
      return fail("unknown", "确认弹窗无删除按钮");
    }
    await clickRef(ctx.client, ctx.session, confirm.ref);
    steps.push("已点击确认弹窗「删除」");
  } else {
    steps.push("未发现确认弹窗(可能无弹窗直接删除)");
  }

  // 验证:成功文案或行消失
  const feedback: string[] = [];
  for (let i = 1; i <= 3; i++) {
    await ctx.sleep(1_800);
    const probe = await takeSnapshot(ctx);
    for (const r of probe.refs) {
      if (r.name !== null && r.name.length <= 40 && DELETE_SUCCESS_RE.test(r.name)) {
        feedback.push(r.name);
      }
    }
    const remains = probe.refs.some(
      (r) => r.role === "link" && r.name !== null && matched.some((m) => m.title === r.name),
    );
    if (feedback.length > 0 || !remains) {
      steps.push(`删除完成(行消失=${!remains},成功文案=${feedback.join("/") || "-"})`);
      return {
        success: true,
        status: "deleted",
        deleted: matched.map((m) => m.ejobId as string),
        ended: [],
        deletion_pending: false,
        mapping,
        feedback,
        steps,
      };
    }
  }
  return fail("unknown", "提交删除后未观察到行消失/成功反馈,请人工核对");
}

/** 穿透映射:逐行点击 → 解析 ejob_id → 回列表(重拍快照取下一行 ref) */
export async function mapRowsToIds(ctx: UiContext): Promise<JobRowMapping[]> {
  const out: JobRowMapping[] = [];
  const first = await takeSnapshot(ctx);
  const total = Math.min(findJobRows(first).length, MAX_ROWS);
  if (total === 0) {
    return out;
  }
  let snap = first;
  for (let i = 0; i < total; i++) {
    const rows = findJobRows(snap);
    const row = rows[i];
    if (row === undefined) {
      break;
    }
    await clickRef(ctx.client, ctx.session, row.ref);
    await ctx.sleep(1_800);
    const after = await takeSnapshot(ctx);
    const ejobId = queryParam(after.page.url, "ejob_id");
    out.push({ title: row.name ?? "", ejobId });
    ctx.log(`[映射] ${row.name ?? "?"} → ejob_id=${ejobId ?? "(未解析)"}`);
    await ctx.client.requireOk("browser_navigate", {
      target_id: ctx.session.targetId,
      tab_id: ctx.session.activeTabId,
      url: JOB_MANAGER_URL,
    });
    await ctx.sleep(2_000);
    snap = await takeSnapshot(ctx);
  }
  return out;
}

/**
 * 执行删除流程(v1):
 * dry-run → 报告行数;非 dry-run → 映射 → 匹配 → 安全闸 → 全选 → 结束 → 确认 → 反馈。
 */
export async function runJobdelete(ctx: UiContext, input: JobdeleteInput): Promise<JobdeleteOutcome> {
  const steps: string[] = [];
  const failed = (status: JobdeleteStatus, message: string): JobdeleteOutcome => {
    steps.push(message);
    return {
      success: false,
      status,
      deleted: [],
      ended: [],
      deletion_pending: false,
      mapping: [],
      feedback: [],
      steps,
    };
  };

  if (input.jobIds.length === 0) {
    throw new CuaError("failed", "缺少 --job(职位 ID,支持逗号分隔)");
  }
  if (input.jobIds.length > MAX_DELETE_TARGETS) {
    return failed("need_manual", `目标数 ${input.jobIds.length} 超过单次上限 ${MAX_DELETE_TARGETS},拒绝执行`);
  }

  await ctx.client.requireOk("browser_navigate", {
    target_id: ctx.session.targetId,
    tab_id: ctx.session.activeTabId,
    url: JOB_MANAGER_URL,
  });
  await ctx.sleep(3_000);

  const snap = await takeSnapshot(ctx);
  const rows = findJobRows(snap);
  steps.push(`列表行 ${rows.length} 个`);

  if (ctx.dryRun || !input.confirmDestructive) {
    if (!ctx.dryRun && !input.confirmDestructive) {
      steps.push("未提供 --confirm-destructive:破坏性动作被安全闸拦截(dry-run 报告模式)");
    }
    return {
      success: false,
      status: "dry_run",
      deleted: [],
      ended: [],
      deletion_pending: false,
      mapping: rows.map((r) => ({ title: r.name ?? "", ejobId: null })),
      feedback: [],
      steps,
    };
  }

  // 穿透映射 ejob_id(先"招聘中"页签)
  let mapping = await mapRowsToIds(ctx);
  let matched = mapping.filter((m) => m.ejobId !== null && input.jobIds.includes(m.ejobId));
  steps.push(`[招聘中] 映射 ${mapping.length} 行,匹配目标 ${matched.length} 个`);

  // 未匹配 → 切"待发布"重试(2026-09-29 联调:审核中/待发布职位在此页签,勾选后直接有"删除")
  if (matched.length === 0) {
    await switchTab(ctx, "待发布");
    mapping = await mapRowsToIds(ctx);
    matched = mapping.filter((m) => m.ejobId !== null && input.jobIds.includes(m.ejobId));
    steps.push(`[待发布] 映射 ${mapping.length} 行,匹配目标 ${matched.length} 个`);
    if (matched.length > 0) {
      return await deleteViaPendingTab(ctx, mapping, matched, steps);
    }
  }

  if (matched.length === 0) {
    return { ...failed("not_found", `未找到匹配 --job 的职位(目标 ${input.jobIds.join(",")})`), mapping };
  }

  // 安全闸:仅当目标=全部可见行时才允许全选(单行 checkbox 不可定位,全选会选中所有行)
  if (mapping.length !== matched.length) {
    return {
      ...failed(
        "need_manual",
        `目标 ${matched.length} 个 ≠ 列表 ${mapping.length} 行;单行勾选不可定位,拒绝全选以免误伤其他职位`,
      ),
      mapping,
    };
  }

  // 全选 → 结束
  const snap2 = await takeSnapshot(ctx);
  const selectAll = findSelectAll(snap2);
  if (selectAll === null) {
    return { ...failed("unknown", "未找到全选勾选框(页面结构可能变化)"), mapping };
  }
  await clickRef(ctx.client, ctx.session, selectAll.ref);
  steps.push("已勾选(全选)");
  await ctx.sleep(1_200);

  const snap3 = await takeSnapshot(ctx);
  const endBtn = matchRef(snap3, END_BUTTON_MATCHER);
  if (endBtn === null) {
    return { ...failed("unknown", "勾选后「结束」按钮未就绪(disabled 或未出现)"), mapping };
  }
  await clickRef(ctx.client, ctx.session, endBtn.ref);
  steps.push(`已点击「${endBtn.name ?? "结束"}」`);
  await ctx.sleep(2_000);

  // 确认弹窗(未完整校准:命中才点)
  const snap4 = await takeSnapshot(ctx);
  const confirm = matchRef(snap4, END_CONFIRM_MATCHER);
  if (confirm !== null) {
    await clickRef(ctx.client, ctx.session, confirm.ref);
    steps.push(`已点击确认「${confirm.name ?? ""}」`);
  } else {
    steps.push("未发现确认弹窗按钮(候选:确定/确认),未点击");
  }

  // 连拍核实
  const feedback: string[] = [];
  for (let i = 1; i <= 3; i++) {
    await ctx.sleep(2_000);
    const probe = await takeSnapshot(ctx);
    for (const r of probe.refs) {
      if (r.name !== null && r.name.length <= 40 && END_SUCCESS_RE.test(r.name)) {
        feedback.push(r.name);
      }
    }
    if (feedback.length > 0) {
      break;
    }
  }

  if (feedback.length === 0) {
    return {
      ...failed("unknown", "未观察到结束成功反馈(可能仍在确认弹窗或结构变化);请人工核对"),
      mapping,
    };
  }

  steps.push("已结束发布;「删除」入口未校准(疑在\"已关闭\"页签),输出 deletion_pending");
  return {
    success: false,
    status: "ended_deletion_pending",
    deleted: [],
    ended: matched.map((m) => m.ejobId as string),
    deletion_pending: true,
    mapping,
    feedback,
    steps,
  };
}
