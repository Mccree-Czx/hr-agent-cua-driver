/**
 * 发布职位流程(W5,UI 通道)。
 *
 * 已校准(2026-09-29 真机):
 * - 表单页:https://lpt.liepin.com/job/publish?ejobActionType=publish(URL 直达);
 * - 职位名称输入框 = 快照中首个「role=combobox + actions含type」节点(in_viewport 优先),
 *   browser_type(replace:true) 可写中文(实测:写入+清空复原均成功);
 * - 「保 存」/「发布职位」按钮 role=button(offscreen 可直接点击,实测触发表单校验);
 * - 保存触发校验反馈以页面文案呈现(实测:「请选择所属部门」)。
 *
 * 未完成校准(候选,v1 不支持填写,输出 unvalidated_fields 明示):
 * - 职位类别(三级联动)、职位描述(富文本)、薪资/经验/学历选择、城市/地址、提交后流程。
 *
 * v1 能力边界(诚实契约):
 * - 填职位名称 → 点击保存/发布 → 解析页面反馈;
 * - 校验未过 → status=validation_blocked + feedback(不谎报成功);
 * - 成功文案明文命中 → status=draft_saved / published。
 */

import { CuaError } from "../contract.js";
import type { SnapshotResult } from "../cua/session.js";
import { clickRef } from "../cua/session.js";
import { matchRef, takeSnapshot, type NameMatcher, type UiContext } from "../cua/ui-actions.js";
import { navigateChecked } from "./common.js";

/** 发布表单页(URL 直达,2026-09-29 验证) */
export const PUBLISH_FORM_URL = "https://lpt.liepin.com/job/publish?ejobActionType=publish";

/** 职位管理列表页(发布后落点/回跳) */
export const JOB_MANAGER_URL = "https://lpt.liepin.com/job/manager";

/** 保存草稿按钮(实测可访问名含全角空格:「保 存」) */
export const SAVE_BUTTON_MATCHER: NameMatcher = {
  names: ["保 存", "保存"],
  roles: ["button"],
};

/** 发布提交按钮 */
export const PUBLISH_BUTTON_MATCHER: NameMatcher = {
  names: ["发布职位"],
  roles: ["button"],
  excludeNames: ["plus"],
};

/** 校验未过提示特征(页面文案) */
export const VALIDATION_HINT_RE = /(请选择|请填|不能为空|必填|请输入)/;

/** 成功文案特征 */
export const SUCCESS_HINT_RE = /(保存成功|发布成功|已保存|已发布|草稿保存成功|操作成功)/;

/** 职位数据(jobpublish --data 契约,与上游 liepin-cli 同形) */
export interface PublishData {
  title: string;
  jobCategory: string;
  description: string;
  salaryMinK?: number;
  salaryMaxK?: number;
  salaryMonths?: number;
  workyearLow?: number;
  workyearHigh?: number;
  degree?: string;
  recruitCount?: number;
}

export type JobpublishStatus = "draft_saved" | "published" | "validation_blocked" | "dry_run" | "unknown";

export interface JobpublishOutcome {
  success: boolean;
  status: JobpublishStatus;
  title: string;
  feedback: string[];
  /** v1 无法填写、需后续校准的字段(data 中出现的非标题字段) */
  unvalidated_fields: string[];
  steps: string[];
}

/** 解析 --data JSON(必填:title/jobCategory/description) */
export function parsePublishData(raw: string): PublishData {
  if (raw === "") {
    throw new CuaError("failed", "缺少 --data(职位数据 JSON)");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CuaError("failed", "--data 不是合法 JSON");
  }
  const p = parsed as Partial<PublishData>;
  if (typeof p.title !== "string" || p.title.trim() === "") {
    throw new CuaError("failed", "data 缺少必填字段: title");
  }
  if (typeof p.jobCategory !== "string" || p.jobCategory.trim() === "") {
    throw new CuaError("failed", "data 缺少必填字段: jobCategory");
  }
  if (typeof p.description !== "string" || p.description.trim() === "") {
    throw new CuaError("failed", "data 缺少必填字段: description");
  }
  return p as PublishData;
}

/** 在快照中定位职位名称输入框:combobox + type 能力,in_viewport 优先 */
export function findTitleInput(snap: SnapshotResult): { ref: string } | null {
  const candidates = snap.refs.filter((r) => r.role === "combobox" && r.actions.includes("type"));
  const hit = candidates.find((r) => r.visibility === "in_viewport") ?? candidates[0];
  return hit !== undefined ? { ref: hit.ref } : null;
}

/** 收集页面校验/成功反馈文案 */
export function collectFeedback(snap: SnapshotResult): { validation: string[]; success: string[] } {
  const validation = new Set<string>();
  const success = new Set<string>();
  for (const r of snap.refs) {
    if (r.name === null || r.name.length > 40) {
      continue;
    }
    if (VALIDATION_HINT_RE.test(r.name)) {
      validation.add(r.name);
    }
    if (SUCCESS_HINT_RE.test(r.name)) {
      success.add(r.name);
    }
  }
  return { validation: [...validation], success: [...success] };
}

export interface JobpublishInput {
  data: PublishData;
  /** 只存草稿不发布 */
  draftOnly: boolean;
}

/**
 * 执行发布流程(v1):
 * 1) 导航表单页 → 定位标题输入框;
 * 2) 写入标题;
 * 3) dry-run:到此为止返回 dry_run;
 * 4) 点击 保存/发布 → 连拍解析反馈;
 * 5) 校验提示 → validation_blocked;成功文案 → draft_saved/published;两者皆无 → unknown。
 */
export async function runJobpublish(ctx: UiContext, input: JobpublishInput): Promise<JobpublishOutcome> {
  const steps: string[] = [];
  const unvalidated: string[] = [];
  if (input.data.jobCategory !== "") {
    unvalidated.push("jobCategory(职位类别三级联动待校准)");
  }
  if (input.data.description !== "") {
    unvalidated.push("description(职位描述富文本待校准)");
  }
  for (const key of ["salaryMinK", "salaryMaxK", "salaryMonths", "workyearLow", "workyearHigh", "degree", "recruitCount"] as const) {
    if (input.data[key] !== undefined) {
      unvalidated.push(key);
    }
  }

  await navigateChecked(ctx, PUBLISH_FORM_URL);
  const snap = await takeSnapshot(ctx);
  const titleInput = findTitleInput(snap);
  if (titleInput === null) {
    throw new CuaError("failed", `未找到职位名称输入框(快照 ${snap.refs.length} 节点);页面结构可能变化`);
  }
  steps.push(`职位名称输入框 ${titleInput.ref}`);

  if (ctx.dryRun) {
    const saveBtn = matchRef(snap, SAVE_BUTTON_MATCHER);
    const publishBtn = matchRef(snap, PUBLISH_BUTTON_MATCHER);
    steps.push(`保存按钮 ${saveBtn?.ref ?? "(未找到)"};发布按钮 ${publishBtn?.ref ?? "(未找到)"}`);
    ctx.log("[jobpublish] dry-run:定位完成,不输入不提交");
    return {
      success: false,
      status: "dry_run",
      title: input.data.title,
      feedback: [],
      unvalidated_fields: unvalidated,
      steps,
    };
  }

  // 写入职位名称(browser_type replace:true,实测中文可用)
  await ctx.client.requireOk("browser_type", {
    target_id: ctx.session.targetId,
    tab_id: ctx.session.activeTabId,
    ref: titleInput.ref,
    text: input.data.title,
    replace: true,
  });
  ctx.log(`[jobpublish] 职位名称已写入(${input.data.title.length} 字)`);
  steps.push(`职位名称已写入`);
  await ctx.sleep(1_000);

  // 点击 保存/发布
  const snap2 = await takeSnapshot(ctx);
  const buttonMatcher = input.draftOnly ? SAVE_BUTTON_MATCHER : PUBLISH_BUTTON_MATCHER;
  const button = matchRef(snap2, buttonMatcher);
  if (button === null) {
    throw new CuaError(
      "failed",
      `未找到「${input.draftOnly ? "保存" : "发布职位"}」按钮;可用 --dry-run 先诊断`,
    );
  }
  await clickRef(ctx.client, ctx.session, button.ref);
  ctx.log(`[jobpublish] 已点击「${button.name}」`);
  steps.push(`已点击 ${button.name ?? ""}`);

  // 连拍解析反馈(3 次 × 2s)
  let lastValidation: string[] = [];
  for (let i = 1; i <= 3; i++) {
    await ctx.sleep(2_000);
    const probe = await takeSnapshot(ctx);
    const { validation, success } = collectFeedback(probe);
    if (success.length > 0) {
      steps.push(`成功文案: ${success.join(" / ")}`);
      return {
        success: true,
        status: input.draftOnly ? "draft_saved" : "published",
        title: input.data.title,
        feedback: success,
        unvalidated_fields: unvalidated,
        steps,
      };
    }
    if (validation.length > 0) {
      lastValidation = validation;
    }
  }

  if (lastValidation.length > 0) {
    steps.push(`校验未过: ${lastValidation.join(" / ")}`);
    return {
      success: false,
      status: "validation_blocked",
      title: input.data.title,
      feedback: lastValidation,
      unvalidated_fields: unvalidated,
      steps,
    };
  }
  steps.push("未观察到成功/校验反馈(待联调复核)");
  return {
    success: false,
    status: "unknown",
    title: input.data.title,
    feedback: [],
    unvalidated_fields: unvalidated,
    steps,
  };
}
