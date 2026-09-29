/**
 * 猎聘「索要手机号 / 索要简历」命令 - 招聘者端（issue #20）
 *
 * HR 的完整闭环是「打招呼 → 索要手机号 → 索要简历」，后两步以前只能人工点网页。
 * 这两个动作没有可直接调用的 BFF 接口：它们是 IM 会话输入框上方那排快捷按钮
 * （`span.im-ui-action-button.action-phone` / `.action-resume`），点击后由前端组合
 * 多个内部调用发出请求卡片。所以这里走 DOM 点击，而不是伪造接口请求。
 *
 * 会话必须已经存在——先 `liepin greet`，再调这两条命令，否则按钮不渲染。
 */

import { Page } from 'puppeteer-core';
import {
  LIEPIN_LPT_API,
  lptFetch,
  getResumeInfo,
  openResumeImPanel,
  readLptImId,
  waitForSelectorSafe,
  clickSafe,
} from '../common/lpt-utils.js';
import { sleepRandom } from '../common/utils.js';

export type RequestKind = 'phone' | 'resume';

export interface RequestOptions {
  resumeId: string;
  /** 对方会话 im_id（可选；后端从候选人快照注入——实测 resume-view 响应不含 im 字段） */
  imId?: string;
}

/** 按钮类名带语义后缀，直接作为选择器（issue #20 提供、猎聘招聘者端实测存在） */
const ACTION_SELECTOR: Record<RequestKind, string> = {
  phone: '.im-ui-action-button.action-phone',
  resume: '.im-ui-action-button.action-resume',
};

const ACTION_LABEL: Record<RequestKind, string> = {
  phone: '索要手机号',
  resume: '索要简历',
};

/** 选择器等待上限（毫秒）；LIEPIN_SELECTOR_TIMEOUT_MS 供测试注入短超时，避免真等超时路径 */
const selectorTimeoutMs = (): number => Number(process.env.LIEPIN_SELECTOR_TIMEOUT_MS || 15000);

/** 取会话里最新一条消息的 id，用来判断点击之后到底有没有发出去 */
async function latestMessageId(page: Page, oppositeImId: string): Promise<string> {
  if (!oppositeImId) return '';
  const imId = await readLptImId(page);
  if (!imId) return '';

  const body = `imUserType=2&imId=${encodeURIComponent(imId)}&imApp=1&oppositeImId=${encodeURIComponent(oppositeImId)}&maxMessageId=&pageSize=1`;
  const data = await lptFetch(page, `${LIEPIN_LPT_API}/api/com.liepin.im.b.chat.chat-list`, {
    body,
    clientId: '40342',
  });
  if (data.flag !== 1) return '';
  return String(data.data?.list?.[0]?.msgId || '');
}

/**
 * 点完按钮后可能弹二次确认框。只在真的出现了带确认字样的按钮时才点，
 * 没有就什么都不做——猜着点弹窗比不点更危险。
 */
async function confirmDialogIfPresent(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const visible = (el: Element): boolean => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const all = (root: ParentNode, sel: string): Element[] => Array.prototype.slice.call(root.querySelectorAll(sel));
    const dialog = all(document, '[role="dialog"], [class*="modal"][class*="im"], .ant-im-modal').find(visible);
    if (!dialog) return false;
    const btn = all(dialog, 'button, [class*="btn"]')
      .filter(visible)
      .find((el) => /^(确定|确认|发送|提交|立即索要|继续)$/.test((el.textContent || '').trim()));
    if (!btn) return false;
    (btn as HTMLElement).click();
    return true;
  });
}

/** 读按钮当前状态：点完常见的变化是变灰/变成「已索要」，可作为发送成功的旁证 */
async function readActionState(page: Page, selector: string): Promise<{ text: string; disabled: boolean }> {
  return page.evaluate((sel: string) => {
    const el = document.querySelector(sel);
    if (!el) return { text: '', disabled: false };
    const cls = el.className || '';
    return {
      text: (el.textContent || '').trim(),
      disabled: /disabled|disable|gray|grey/i.test(String(cls)) || el.getAttribute('aria-disabled') === 'true',
    };
  }, selector);
}

/**
 * 简历索要：直调平台 askfor 接口（2026-09-27 前端逆向 + 真机验证）。
 *
 * 平台 DOM 上 .action-resume 按钮的点击经实测无任何 API 请求、无状态变化（死按钮）；
 * 真正生效的接口是 com.liepin.im.b.askfor.send-askfor-request（bizType=3=简历）。
 * flag=1 即平台受理（作为确认依据）；会话侧新消息仅作旁证。
 */
async function requestResumeViaApi(page: Page, resumeId: string, info: { name: string; imId: string }, explicitImId?: string): Promise<any> {
  // 实测 resume-view 响应不含任何 im 字段：im_id 优先取调用方注入（后端传候选人快照），其次退回响应值
  const oppositeImId = String(explicitImId || info.imId || '').trim();
  if (!oppositeImId) {
    throw new Error('缺少会话标识（im_id）：请先对候选人执行 greet 建立会话，或用 --imId 传入对方 im_id');
  }
  const before = await latestMessageId(page, oppositeImId);
  const res = await lptFetch(page, `${LIEPIN_LPT_API}/api/com.liepin.im.b.askfor.send-askfor-request`, {
    body: `oppositeImId=${encodeURIComponent(oppositeImId)}&bizType=3`,
    clientId: '40342',
  });
  if (res?.flag !== 1) {
    return {
      success: false,
      confirmed: false,
      message: `索要简历失败（平台未受理）：${res?.msg || res?.message || JSON.stringify(res || {}).slice(0, 200)}`,
      name: info.name,
      resume_id: resumeId,
      im_id: oppositeImId,
    };
  }
  await sleepRandom(1500, 2500);
  const after = await latestMessageId(page, oppositeImId);
  return {
    success: true,
    confirmed: true,
    message: '已向候选人发出「索要简历」请求（接口已受理）',
    name: info.name,
    resume_id: resumeId,
    im_id: oppositeImId,
    chat_message_added: Boolean(after) && after !== before,
  };
}

async function requestFromCandidate(page: Page, kind: RequestKind, options: RequestOptions): Promise<any> {
  const { resumeId } = options;
  if (!resumeId) {
    throw new Error('简历 ID（resume_id）不能为空');
  }

  const info = await getResumeInfo(page, resumeId);

  // 简历索要走直调接口（DOM 按钮经实测无效果）；手机号暂保留 DOM 路径
  if (kind === 'resume') {
    return requestResumeViaApi(page, resumeId, info, options.imId);
  }

  const before = await latestMessageId(page, info.imId);

  await openResumeImPanel(page, resumeId);

  const selector = ACTION_SELECTOR[kind];
  try {
    await waitForSelectorSafe(page, selector, { timeout: selectorTimeoutMs() });
  } catch {
    throw new Error(
      `会话里找不到「${ACTION_LABEL[kind]}」按钮（${selector}）。` +
        '通常是还没跟该候选人建立会话——先跑 liepin greet，或该职位当前不支持这个动作。',
    );
  }

  const stateBefore = await readActionState(page, selector);
  if (stateBefore.disabled) {
    return {
      success: false,
      message: `「${ACTION_LABEL[kind]}」按钮当前不可点（可能已经索要过或权益不足）`,
      name: info.name,
      resume_id: resumeId,
      im_id: info.imId,
      confirmed: false,
    };
  }

  await clickSafe(page, selector);
  await sleepRandom(1200, 2000);
  const dialogConfirmed = await confirmDialogIfPresent(page);
  if (dialogConfirmed) {
    await sleepRandom(1200, 2000);
  }

  const after = await latestMessageId(page, info.imId);
  const stateAfter = await readActionState(page, selector);
  // 会话里多了一条消息，或按钮变成不可点，都说明请求确实发出去了
  const confirmed = (Boolean(after) && after !== before) || (!stateBefore.disabled && stateAfter.disabled);

  return {
    success: true,
    message: confirmed
      ? `已向候选人发出「${ACTION_LABEL[kind]}」请求`
      : `已点击「${ACTION_LABEL[kind]}」，但未能确认请求已送达（会话无新消息、按钮状态也没变）`,
    name: info.name,
    resume_id: resumeId,
    im_id: info.imId,
    confirmed,
    dialog_confirmed: dialogConfirmed,
    button_text: stateAfter.text,
  };
}

export async function requestPhone(page: Page, options: RequestOptions): Promise<any> {
  return requestFromCandidate(page, 'phone', options);
}

export async function requestResume(page: Page, options: RequestOptions): Promise<any> {
  return requestFromCandidate(page, 'resume', options);
}

const REQUEST_ARGS = [
  {
    name: 'resumeId',
    type: 'string',
    required: true,
    positional: true,
    help: '候选人 resume_id（来自 search / recommend / talent）',
  },
  {
    name: 'imId',
    type: 'string',
    default: '',
    help: '对方会话 im_id（可选；后端注入候选人快照；不传时尝试从简历响应读取）',
  },
];

const REQUEST_COLUMNS = [
  { header: '结果', key: 'message', width: 60 },
];

/** 索要手机号命令定义 */
export const requestPhoneCommand = {
  name: 'request-phone',
  description: '向候选人索要手机号（需先 greet 建立会话）',
  args: REQUEST_ARGS,
  columns: REQUEST_COLUMNS,
  func: requestPhone,
};

/** 索要简历命令定义 */
export const requestResumeCommand = {
  name: 'request-resume',
  description: '向候选人索要简历（需先 greet 建立会话）',
  args: REQUEST_ARGS,
  columns: REQUEST_COLUMNS,
  func: requestResume,
};
