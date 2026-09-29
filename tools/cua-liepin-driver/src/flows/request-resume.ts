/**
 * request-resume - 索要简历(UI 模式,W2)。
 *
 * 背景:liepin-cli 时代经 CDP 合成点击(DOM click)实测为"死按钮"(无请求、无状态变化),
 * 遂改直调 askfor 接口;本流程用 trusted 真实输入返回真实按钮路径——
 * 死按钮能否被真实输入激活,正是 W0/W2 真机联调要回答的问题。
 *
 * 输出契约对齐后端(ResumeCollectService):
 *   {success, confirmed, message, resume_id, im_id, evidence, steps}
 * - success: 索要动作已被执行(点击送达且未被拒绝)
 * - confirmed: 观察到界面确认证据(按钮变"已索要"/成功提示);未观察到且未放行时抛错
 */

import { CuaError } from "../contract.js";
import { clickName, findAnyText, takeSnapshot, waitForEvidence, type NameMatcher, type UiContext } from "../cua/ui-actions.js";
import { ensureImPanel, navigateChecked, resumeDetailUrl, waitResumePageReady } from "./common.js";

export interface RequestResumeInput {
  /** 候选 resume_id */
  resumeId: string;
  /** 对方会话 im_id(仅输出留痕;UI 流程不依赖) */
  imId?: string;
  /** true 时空证据不抛错(confirmed=false;仅联调期使用) */
  allowUnverified?: boolean;
}

export interface RequestResumeOutcome {
  success: boolean;
  confirmed: boolean;
  message: string;
  resume_id: string;
  im_id: string;
  evidence: string;
  steps: string[];
}

/** 索要简历快捷按钮(IM 面板,文案「索要简历」;liepin-cli 侧选择器 .im-ui-action-button.action-resume) */
export const RESUME_ACTION_MATCHER: NameMatcher = {
  names: ["索要简历"],
  actions: ["click"],
  excludeNames: ["已索要", "索要成功"],
};

/** 已索要标志(先于点击检查,幂等短路) */
export const ALREADY_REQUESTED_TEXTS = ["已索要", "索要成功", "已请求", "索要简历成功"];

/** 确认弹窗标志(出现任一即视为弹窗在场;liepin-cli 确认文案观测为 确定|确认|立即索要 一类) */
export const CONFIRM_DIALOG_MARKERS = ["确认索要", "是否索要", "立即索要", "向候选人索要"];

/** 弹窗确认按钮候选(保守集合:仅明确确认语义;不含"发送",避免误点 IM 发送按钮) */
export const REQUEST_CONFIRM: NameMatcher = {
  names: ["确认", "确定", "立即索要"],
  actions: ["click"],
};

/** 执行索要简历(UI 模式) */
export async function runRequestResume(ctx: UiContext, input: RequestResumeInput): Promise<RequestResumeOutcome> {
  const steps: string[] = [];
  const note = (msg: string): void => {
    steps.push(msg);
    ctx.log(msg);
  };

  await navigateChecked(ctx, resumeDetailUrl(input.resumeId));
  note("已打开简历详情页");
  await waitResumePageReady(ctx);
  note("简历页就绪");

  await ensureImPanel(ctx);
  note("IM 面板已就绪");

  const preSnap = await takeSnapshot(ctx);
  const pre = findAnyText(preSnap, ALREADY_REQUESTED_TEXTS);
  if (pre !== null) {
    note(`已处于已索要状态(${pre}),幂等跳过`);
    return {
      success: true,
      confirmed: true,
      message: `已向候选人发出「索要简历」请求(先前已发出,证据:${pre})`,
      resume_id: input.resumeId,
      im_id: input.imId ?? "",
      evidence: pre,
      steps,
    };
  }

  const clicked = await clickName(ctx, "索要简历", RESUME_ACTION_MATCHER, { timeoutMs: 15_000 });
  if (clicked === null) {
    throw new CuaError("failed", "未找到「索要简历」快捷按钮;请确认会话已建立且 IM 面板结构未变(可先 --dry-run)");
  }
  note(`已点击「${clicked.ref.name}」`);

  if (ctx.dryRun) {
    note("dry-run:未真正索要");
    return {
      success: true,
      confirmed: false,
      message: "dry-run:已定位索要简历入口,未点击",
      resume_id: input.resumeId,
      im_id: input.imId ?? "",
      evidence: "dry-run",
      steps,
    };
  }

  // 二次确认弹窗(只有在弹窗标志在场时才点确认,避免误点页面其它按钮)
  await ctx.sleep(800);
  const afterClick = await takeSnapshot(ctx);
  if (findAnyText(afterClick, CONFIRM_DIALOG_MARKERS) !== null) {
    const confirm = await clickName(ctx, "确认索要", REQUEST_CONFIRM, { timeoutMs: 3_000 });
    note(confirm !== null ? "已点击确认弹窗" : "确认弹窗未见确认按钮(继续观察证据)");
  }

  // 证据:按钮变"已索要"/成功提示
  const ev = await waitForEvidence(ctx, ALREADY_REQUESTED_TEXTS, { timeoutMs: 12_000 });
  if (ev !== null) {
    const evidence = findAnyText(ev, ALREADY_REQUESTED_TEXTS) ?? "";
    note(`确认证据: ${evidence}`);
    return {
      success: true,
      confirmed: true,
      message: "已向候选人发出「索要简历」请求(UI 已确认)",
      resume_id: input.resumeId,
      im_id: input.imId ?? "",
      evidence,
      steps,
    };
  }
  if (input.allowUnverified === true) {
    note("未观察到确认证据(--allow-unverified 放行)");
    return {
      success: true,
      confirmed: false,
      message: "索要简历动作已执行,未观察到确认回显(UI)",
      resume_id: input.resumeId,
      im_id: input.imId ?? "",
      evidence: "unverified",
      steps,
    };
  }
  throw new CuaError("failed", "索要简历动作已执行但未观察到确认;确认界面结果后可传 --allow-unverified(联调期)");
}
