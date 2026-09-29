/**
 * greet - 打招呼(UI 模式,W2)。
 *
 * 流程:简历详情页 → 识别是否已建立会话 → 点击「打招呼」入口 →(如出现职位选择弹窗则
 * 按 jobTitleHint 选择,选择不明确时不猜、直接失败)→ 等待成功证据 → 可选补发话术。
 *
 * 与 liepin-cli 的差异:全部动作走真实 UI(trusted 输入),不做任何直调接口;
 * 成功以页面证据为准(候选证据列表见 GREET_EVIDENCE,真机联调后可精调)。
 */

import { CuaError } from "../contract.js";
import { clickName, findAnyText, matchRef, takeSnapshot, waitForEvidence, waitForMatch, type NameMatcher, type UiContext } from "../cua/ui-actions.js";
import { ensureImPanel, navigateChecked, resumeDetailUrl, sendMessageIntoIm, waitResumePageReady } from "./common.js";

export interface GreetInput {
  /** 候选 resume_id(UI 模式不接受裸 user_id) */
  usercId: string;
  /** 关联猎聘职位 ID(审计用;UI 选择以 jobTitleHint 为准) */
  ejobId: string;
  /** 自定义话术(可空;非空时打招呼后补发) */
  message?: string;
  /** 职位选择弹窗中用于匹配的职位标题(可选;不明确时保守失败) */
  jobTitleHint?: string;
  /** true 时空证据不抛错(输出 unverified;仅联调期使用) */
  allowUnverified?: boolean;
}

export interface GreetOutcome {
  success: boolean;
  alreadyChatted: boolean;
  messageSent: boolean;
  evidence: string;
  steps: string[];
}

/** 打招呼入口候选(排除打开 IM 面板的按钮) */
export const GREET_BUTTON: NameMatcher = {
  names: ["打招呼", "立即沟通", "一键沟通", "发起沟通"],
  actions: ["click"],
  excludeNames: ["在线沟通", "继续沟通", "已打招呼"],
};

/** 已建立会话的标志(简历详情页上的"继续沟通/沟通中"入口) */
export const ALREADY_CHAT_MATCHER: NameMatcher = {
  names: ["继续沟通", "沟通中"],
  actions: ["click"],
};

/**
 * 打招呼成功证据候选。
 * 联调实测(2026-09-29):真实 UI 路径为推荐页/预览「立即沟通」→
 * 弹出「已向候选人发送消息」弹窗 + 按钮变为「继续沟通」。
 */
export const GREET_EVIDENCE = ["已向候选人发送消息", "继续沟通", "沟通中", "已打招呼", "打招呼成功", "已发起沟通", "沟通成功"];

/** 成功弹窗的关闭按钮(弹窗带超级聊聊推广,只点关闭、不点推广) */
export const GREET_DIALOG_DISMISS: NameMatcher = {
  names: ["关闭"],
  roles: ["button"],
};

/** 职位选择弹窗标志(出现任一即视为弹窗在场) */
export const JOB_DIALOG_MARKERS = ["选择职位", "选择沟通职位", "开聊职位", "请选择职位", "沟通职位"];

/** 弹窗确认按钮候选(保守集合:仅明确的确认语义) */
export const DIALOG_CONFIRM: NameMatcher = {
  names: ["确定", "确认", "开始沟通", "立即沟通"],
  actions: ["click"],
};

/** 处理打招呼后的职位选择弹窗;选择不明确时抛错(不猜测) */
async function resolveJobDialog(ctx: UiContext, jobTitleHint: string | undefined): Promise<boolean> {
  const snap = await takeSnapshot(ctx);
  if (findAnyText(snap, JOB_DIALOG_MARKERS) === null) {
    return false;
  }
  ctx.log("[职位弹窗] 检测到职位选择弹窗");

  if (jobTitleHint !== undefined && jobTitleHint.trim() !== "") {
    const option = await clickName(ctx, "职位弹窗", { names: [jobTitleHint.trim()], actions: ["click"] }, { timeoutMs: 5_000 });
    if (option === null) {
      throw new CuaError("failed", `职位选择弹窗中未找到标题包含「${jobTitleHint}」的选项;请核对 --jobTitle`);
    }
  } else {
    // 无提示时的保守策略:全页仅有一个"职位"字样可点候选才自动选择,否则列出现场信息要求补充提示
    const candidates = snap.refs.filter((r) => r.name !== null && r.name.includes("职位") && r.actions.includes("click"));
    if (candidates.length === 1) {
      const only = candidates[0];
      ctx.log(`[职位弹窗] 唯一职位候选「${only.name}」,自动选择`);
      await clickName(ctx, "职位弹窗", { names: [only.name ?? ""], actions: ["click"] }, { timeoutMs: 5_000 });
    } else {
      const listing = candidates.map((r) => r.name).join(" | ");
      throw new CuaError("failed", `职位选择弹窗存在 ${candidates.length} 个候选({${listing}}),无法确定目标职位;请传入 --jobTitle`);
    }
  }

  // 弹窗确认(如有)
  const confirm = await clickName(ctx, "弹窗确认", DIALOG_CONFIRM, { timeoutMs: 3_000 });
  if (confirm !== null) {
    ctx.log("[职位弹窗] 已确认");
  }
  return true;
}

/** 执行打招呼(UI 模式) */
export async function runGreet(ctx: UiContext, input: GreetInput): Promise<GreetOutcome> {
  const steps: string[] = [];
  const note = (msg: string): void => {
    steps.push(msg);
    ctx.log(msg);
  };

  if (/^[a-f0-9]{32}$/i.test(input.usercId)) {
    throw new CuaError("failed", "UI 模式需要 resume_id:裸 user_id 无法定位简历页,请在调用方传入 resume_id");
  }

  await navigateChecked(ctx, resumeDetailUrl(input.usercId));
  note("已打开简历详情页");
  const pageSnap = await waitResumePageReady(ctx);
  note("简历页就绪");

  const alreadyChatted = matchRef(pageSnap, ALREADY_CHAT_MATCHER) !== null;
  let evidence = "";
  if (alreadyChatted) {
    note("已存在会话(继续沟通/沟通中),跳过打招呼");
  } else {
    const clicked = await clickName(ctx, "打招呼", GREET_BUTTON, { timeoutMs: 15_000 });
    if (clicked === null) {
      throw new CuaError("failed", "未找到「打招呼/立即沟通」入口;请核对简历页结构(可先 --dry-run 查看步骤日志)");
    }
    note(`已点击打招呼入口「${clicked.ref.name}」`);

    if (!ctx.dryRun) {
      await ctx.sleep(1_500);
      const hadDialog = await resolveJobDialog(ctx, input.jobTitleHint);
      if (hadDialog) {
        note("职位弹窗已处理");
      }
      const ev = await waitForEvidence(ctx, GREET_EVIDENCE, { timeoutMs: 15_000 });
      if (ev !== null) {
        evidence = findAnyText(ev, GREET_EVIDENCE) ?? "";
        note(`成功证据: ${evidence}`);
        // 联调实测:成功弹窗「已向候选人发送消息」会遮挡后续操作,顺手关闭(仅点关闭,不碰推广按钮)
        if (evidence === "已向候选人发送消息") {
          const dismissed = await clickName(ctx, "关闭成功弹窗", GREET_DIALOG_DISMISS, { timeoutMs: 2_500 });
          if (dismissed !== null) {
            note("已关闭成功提示弹窗");
          }
        }
      } else if (input.allowUnverified !== true) {
        throw new CuaError("failed", "打招呼动作已执行,但未观察到成功证据;确认界面变化后可传 --allow-unverified(联调期)");
      } else {
        evidence = "unverified";
        note("未观察到证据(--allow-unverified 放行)");
      }
    } else {
      evidence = "dry-run";
    }
  }

  let messageSent = false;
  const message = input.message?.trim() ?? "";
  if (message !== "") {
    if (!ctx.dryRun && !alreadyChatted && evidence === "unverified") {
      // 未确认打招呼结果时不再擅自补发消息,避免会话不存在导致误发
      note("打招呼未确认,跳过话术补发");
    } else {
      await ensureImPanel(ctx);
      note("IM 面板已就绪");
      const evidence2 = await sendMessageIntoIm(ctx, message);
      if (evidence2 !== null) {
        messageSent = true;
        note(`话术回显证据: ${evidence2}`);
      } else if (ctx.dryRun) {
        note("dry-run:话术未发送");
      } else if (input.allowUnverified === true) {
        note("话术未观察到回显(--allow-unverified 放行)");
      } else {
        throw new CuaError("failed", "话术已输入但未观察到回显;确认发送结果后可传 --allow-unverified(联调期)");
      }
    }
  }

  return {
    success: true,
    alreadyChatted,
    messageSent,
    evidence,
    steps,
  };
}
