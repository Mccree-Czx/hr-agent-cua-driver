import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestPhone, requestResume, requestPhoneCommand, requestResumeCommand } from './request.js';
import { parsePayload } from './chatmsg.js';

// 缩短"等不到元素"路径的等待（waitForSelectorSafe 在调用时读取），测试不真等 15 秒
process.env.LIEPIN_SELECTOR_TIMEOUT_MS = '300';

const RESUME_VIEW = 'resume-view';
const CHAT_LIST = 'chat-list';

/**
 * 假 Page：按 lptFetch 的 url 实参分发响应，DOM 操作记在 calls 里。
 * lptFetch 的 evaluate 带 4 个实参，DOM 那些 evaluate 带 0~1 个，以此区分。
 */
function fakePage(opts: {
  actionMissing?: boolean;
  disabledBefore?: boolean;
  disabledAfter?: boolean;
  newMessage?: boolean;
  dialog?: boolean;
  askforFlag?: number;
  askforMsg?: string;
} = {}) {
  const calls: string[] = [];
  let clickedAction = false;

  const chatListResponse = (): string => {
    const msgId = opts.newMessage && clickedAction ? 'msg-2' : 'msg-1';
    return JSON.stringify({ flag: 1, data: { list: [{ msgId }] } });
  };

  const page: any = {
    url: () => 'https://lpt.liepin.com/resume/detail',
    goto: async () => {},
    mainFrame: () => ({ client: { send: async () => {} } }),
    evaluate: async (_fn: any, ...args: any[]) => {
      const src = String(_fn);
      // waitForSelectorSafe：按实参选择器判存在性（actionMissing 表示按钮未渲染）
      if (typeof args[0] === 'string' && src.includes('Boolean(document.querySelector(')) {
        return !(opts.actionMissing && String(args[0]).includes('action-'));
      }
      // clickSafe：页面内点击，按实际点击的按钮记账
      if (typeof args[0] === 'string' && src.includes('scrollIntoView')) {
        calls.push(`click:${args[0]}`);
        if (String(args[0]).includes('action-')) clickedAction = true;
        return true;
      }
      if (args.length === 4) {
        const url = String(args[0]);
        // 索要简历直调接口（2026-09-27 起）
        if (url.includes('askfor.send-askfor-request')) {
          calls.push(`askfor:${String(args[1])}`);
          if (opts.askforFlag !== undefined && opts.askforFlag !== 1) {
            return { ok: true, status: 200, text: JSON.stringify({ flag: opts.askforFlag, msg: opts.askforMsg || '' }) };
          }
          return { ok: true, status: 200, text: JSON.stringify({ flag: 1, data: {} }) };
        }
        if (url.includes(RESUME_VIEW)) {
          return {
            ok: true,
            status: 200,
            text: JSON.stringify({
              flag: 1,
              data: { resumeDetailVo: { encodeUsercId: 'u-1', imId: 'im-1', baseInfo: { name: '张三' } } },
            }),
          };
        }
        if (url.includes(CHAT_LIST)) return { ok: true, status: 200, text: chatListResponse() };
        return { ok: true, status: 200, text: JSON.stringify({ flag: 1, data: {} }) };
      }
      // readLptImId（无实参）
      if (args.length === 0) return 'me-im';
      // readActionState（选择器实参）
      const disabled = clickedAction ? opts.disabledAfter === true : opts.disabledBefore === true;
      return { text: '索要手机', disabled };
    },
  };

  // confirmDialogIfPresent 也是 0 实参的 evaluate，需要跟 readLptImId 区分：
  // 用调用顺序区分太脆弱，直接按返回值类型在被测代码里各取所需，这里统一给对象/字符串。
  const originalEvaluate = page.evaluate;
  page.evaluate = async (fn: any, ...args: any[]) => {
    const src = String(fn);
    if (src.includes('role="dialog"')) {
      calls.push('dialog-check');
      return opts.dialog === true;
    }
    return originalEvaluate(fn, ...args);
  };

  return { page, calls };
}

test('request-phone: 点的是「索要手机」按钮，并按会话新消息确认送达', async () => {
  const { page, calls } = fakePage({ newMessage: true });

  const res = await requestPhone(page, { resumeId: 'r-1' });

  assert.equal(res.success, true);
  assert.equal(res.confirmed, true);
  assert.equal(res.name, '张三');
  assert.ok(calls.includes('click:.im-ui-action-button.action-phone'));
});

test('request-resume: 直调 askfor 接口(oppositeImId+bizType=3),不再点 DOM 按钮', async () => {
  const { page, calls } = fakePage({ newMessage: true });

  const res = await requestResume(page, { resumeId: 'r-1' });

  assert.equal(res.success, true);
  assert.equal(res.confirmed, true);
  assert.ok(calls.includes('askfor:oppositeImId=im-1&bizType=3'), '应按契约调用 askfor 接口');
  assert.ok(!calls.some((c) => c.includes('action-resume')), '不应再依赖 DOM 按钮');
});

test('request-resume: options.imId 优先(resume-view 无 im 字段时由后端注入)', async () => {
  const { page, calls } = fakePage({ newMessage: true });

  const res = await requestResume(page, { resumeId: 'r-1', imId: 'im-injected' });

  assert.equal(res.success, true);
  assert.ok(calls.includes('askfor:oppositeImId=im-injected&bizType=3'), '应使用注入的 imId');
});

test('request-resume: 平台未受理(flag=0)时不谎称成功,携带原因', async () => {
  const { page } = fakePage({ askforFlag: 0, askforMsg: '今日索要次数已用完' });

  const res = await requestResume(page, { resumeId: 'r-1' });

  assert.equal(res.success, false);
  assert.equal(res.confirmed, false);
  assert.match(res.message, /今日索要次数已用完/);
});

test('会话里没多出消息、按钮也没变灰时，不谎称已送达', async () => {
  const { page } = fakePage({ newMessage: false });

  const res = await requestPhone(page, { resumeId: 'r-1' });

  assert.equal(res.confirmed, false);
  assert.match(res.message, /未能确认/);
});

test('按钮变灰同样算送达（部分场景不会落新消息）', async () => {
  const { page } = fakePage({ newMessage: false, disabledBefore: false, disabledAfter: true });

  const res = await requestPhone(page, { resumeId: 'r-1' });

  assert.equal(res.confirmed, true);
});

test('按钮一开始就不可点：直接返回失败，不做任何点击', async () => {
  const { page, calls } = fakePage({ disabledBefore: true, disabledAfter: true });

  const res = await requestPhone(page, { resumeId: 'r-1' });

  assert.equal(res.success, false);
  assert.match(res.message, /不可点/);
  assert.ok(!calls.some(c => c.startsWith('click:.im-ui-action-button')));
});

test('会话不存在（按钮没渲染）时报错指向 greet，不静默成功', async () => {
  const { page } = fakePage({ actionMissing: true });

  await assert.rejects(() => requestPhone(page, { resumeId: 'r-1' }), /greet/);
});

test('空 resume_id 直接报错', async () => {
  const { page } = fakePage();
  await assert.rejects(() => requestPhone(page, { resumeId: '' }), /不能为空/);
});

test('命令定义：名字与必需参数符合 CLI 契约', () => {
  for (const cmd of [requestPhoneCommand, requestResumeCommand]) {
    assert.match(cmd.name, /^request-(phone|resume)$/);
    const arg = cmd.args[0];
    assert.equal(arg.required, true);
    assert.equal(arg.positional, true);
  }
});

test('chatmsg: 卡片消息里的手机号明文抽出来，不再只显示 [类型]', () => {
  const card = JSON.stringify({ bodies: [{ type: 'cmd', action: 'phone', ext: { phone: '13800138000' } }] });
  assert.equal(parsePayload(card), '[cmd] 13800138000');
});

test('chatmsg: 普通文本消息原样返回', () => {
  const txt = JSON.stringify({ bodies: [{ type: 'txt', msg: '您好，方便聊聊吗' }] });
  assert.equal(parsePayload(txt), '您好，方便聊聊吗');
});

test('chatmsg: 卡片里没有号码时保持原来的 [类型]', () => {
  const card = JSON.stringify({ bodies: [{ type: 'img', url: 'https://x/y.png' }] });
  assert.equal(parsePayload(card), '[img]');
});
