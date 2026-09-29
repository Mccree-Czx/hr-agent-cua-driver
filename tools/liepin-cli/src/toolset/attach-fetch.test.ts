/**
 * attach-fetch 命令测试:全部 mock page 与 mock CDP session,
 * 不触达真实浏览器、不产生真实下载。覆盖:检测/下载/校验/来源防护/三态输出。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachFetch, attachFetchCommand, findAttachmentSign } from './attach-fetch.js';

const PDF = Buffer.concat([
  Buffer.from('%PDF-1.7\n'),
  Buffer.from('mock attachment bytes'),
  Buffer.from('\n%%EOF\n'),
]);

const SIGN = 'sign-test-abc';
const ATTACH_PATH = '/api/com.liepin.zhuque.resumeview.get-resume-attachment';
const CHAT_LIST_PATH = '/api/com.liepin.im.b.chat.chat-list';

/** 构造一条带附件卡片的候选人消息(payload 为 JSON 字符串,与真实接口一致) */
function attachMessage(sign: string, paramOverride?: string, sender = 'opp-im') {
  const param = paramOverride ?? JSON.stringify({ attachmentSign: sign, encodeAttachmentId: 'enc-1' });
  return {
    msgId: 'm-card',
    msgSendImId: sender,
    payload: JSON.stringify({
      ext: { extBody: { bizData: { bizType: '7', attachmentResume: { param } } } },
    }),
  };
}

function textMessage() {
  return { msgId: 'm-txt', payload: JSON.stringify({ bodies: [{ type: 'txt', msg: 'hi' }] }) };
}

interface SessionApi {
  emit: (method: string, params: any) => Promise<void>;
}

/** mock CDP 会话:记录 send、可注册事件回调,并支持在 send 时回放下载事件 */
function makeSession(onSend?: (method: string, params: any, api: SessionApi) => any) {
  const sends: Array<{ method: string; params: any }> = [];
  const handlers: Record<string, Array<(params: any) => any>> = {};
  const api: SessionApi = {
    emit: async (method, params) => {
      for (const h of handlers[method] || []) await h(params);
    },
  };
  const session: any = {
    send: async (method: string, params: any) => {
      sends.push({ method, params });
      const result = onSend ? await onSend(method, params, api) : undefined;
      return result === undefined ? {} : result;
    },
    on: (event: string, handler: (params: any) => any) => {
      (handlers[event] = handlers[event] || []).push(handler);
      return session;
    },
    detach: async () => {
      sends.push({ method: 'detach', params: {} });
    },
  };
  return { session, sends };
}

interface FetchResponses {
  chatList?: any;
  attachment?: any;
  triggerResult?: any;
}

/** mock page:按 lptFetch 的 url 实参分发;下载触发时回放事件并写文件 */
function makePage(resp: FetchResponses, opts: { session: any; pdf?: Buffer; outDir?: string; guid?: string; origin?: string }) {
  const lptCalls: Array<{ url: string; body: string; clientId?: string }> = [];
  let evalCount = 0;
  const page: any = {
    url: () => 'https://lpt.liepin.com/recommend',
    goto: async () => {},
    mainFrame: () => ({ client: { send: async () => {} } }),
    evaluate: async (_fn: any, ...args: any[]) => {
      evalCount++;
      if (args.length === 4) {
        const url = String(args[0]);
        const body = String(args[1] ?? '');
        lptCalls.push({ url, body, clientId: String(args[2]) });
        if (url.includes(CHAT_LIST_PATH)) {
          return { ok: true, status: 200, text: JSON.stringify(resp.chatList) };
        }
        if (url.includes(ATTACH_PATH)) {
          return { ok: true, status: 200, text: JSON.stringify(resp.attachment) };
        }
        return { ok: true, status: 200, text: JSON.stringify({ flag: 1, data: {} }) };
      }
      // readLptImId(无实参)
      if (args.length === 0) return 'own-im';
      return undefined;
    },
    target: () => ({ createCDPSession: async () => opts.session }),
    browser: () => ({ target: () => ({ createCDPSession: async () => opts.session }) }),
  };
  return { page, lptCalls };
}

function tempOutDir(): string {
  return mkdtempSync(join(tmpdir(), 'attach-fetch-'));
}

function okChatList(sign = SIGN) {
  return { flag: 1, data: { list: [textMessage(), attachMessage(sign)] } };
}

function okAttachment() {
  return { flag: 1, data: { accessPath: 'https://tdoss.liepin.com/att/abc.pdf?sig=x', fileName: '张三简历.pdf', fileExtension: 'pdf' } };
}

test('成功路径:检出附件→换地址→下载落盘→PDF校验;签名不进入输出', async () => {
  const outDir = tempOutDir();
  try {
    const guid = 'guid-pdf-0001';
    const origin = 'https://tdoss.liepin.com';
    const { session, sends } = makeSession(async (method, _params, api) => {
      if (method === 'Runtime.evaluate') {
        writeFileSync(join(outDir, guid), PDF);
        await api.emit('Browser.downloadWillBegin', { guid, url: `${origin}/att/abc.pdf` });
        await api.emit('Browser.downloadProgress', { guid, state: 'completed', receivedBytes: PDF.length, totalBytes: PDF.length });
        return { result: { value: 'opened' } };
      }
      return undefined;
    });
    const { page, lptCalls } = makePage({ chatList: okChatList(), attachment: okAttachment() }, { session, outDir, guid, origin });

    const result = await attachFetch(page, { imId: 'opp-im', outDir });

    assert.equal(result.success, true);
    assert.equal((result as any).bytes, PDF.length);
    assert.equal((result as any).sha256, createHash('sha256').update(PDF).digest('hex'));
    assert.equal((result as any).fileName, '张三简历.pdf');
    assert.equal((result as any).sourceOrigin, origin);
    assert.ok((result as any).file.endsWith(guid));
    // 签名只在进程内流转:不出现在输出
    assert.ok(!JSON.stringify(result).includes(SIGN), 'attachmentSign 不得出现在输出中');
    // 请求链路正确
    const chat = lptCalls.find((c) => c.url.includes(CHAT_LIST_PATH));
    assert.ok(chat && chat.body.includes('oppositeImId=opp-im'));
    const att = lptCalls.find((c) => c.url.includes(ATTACH_PATH));
    assert.ok(att && att.body.includes(`fileSign=${encodeURIComponent(SIGN)}`), 'fileSign 应使用 attachmentSign 值');
    // 下载行为:allowAndName → 结束后恢复 default
    const behaviors = sends.filter((s) => s.method === 'Browser.setDownloadBehavior').map((s) => s.params.behavior);
    assert.ok(behaviors.includes('allowAndName'));
    assert.equal(behaviors[behaviors.length - 1], 'default');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('无附件:返回 no-attachment,且不再请求换地址接口', async () => {
  const outDir = tempOutDir();
  try {
    const { session } = makeSession();
    const { page, lptCalls } = makePage(
      { chatList: { flag: 1, data: { list: [textMessage()] } } },
      { session, outDir },
    );

    const result = await attachFetch(page, { imId: 'opp-im', outDir });

    assert.deepEqual(result, { found: false, success: false, reason: 'no-attachment' });
    assert.ok(!lptCalls.some((c) => c.url.includes(ATTACH_PATH)), '不应请求换地址接口');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('bizType=7 但 param 非法 JSON:视为无附件(不猜)', async () => {
  const outDir = tempOutDir();
  try {
    const { session } = makeSession();
    const { page } = makePage(
      { chatList: { flag: 1, data: { list: [attachMessage(SIGN, 'not-json{')] } } },
      { session, outDir },
    );

    const result = await attachFetch(page, { imId: 'opp-im', outDir });
    assert.deepEqual(result, { found: false, success: false, reason: 'no-attachment' });
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('换地址接口 flag!=1:fetch-failed', async () => {
  const outDir = tempOutDir();
  try {
    const { session } = makeSession();
    const { page } = makePage(
      { chatList: okChatList(), attachment: { flag: 0, data: {} } },
      { session, outDir },
    );

    const result = await attachFetch(page, { imId: 'opp-im', outDir });
    assert.equal(result.found, true);
    assert.equal(result.success, false);
    assert.equal((result as any).reason, 'fetch-failed');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('下载完成但非 PDF:verify-failed', async () => {
  const outDir = tempOutDir();
  try {
    const guid = 'guid-bad-0001';
    const bad = Buffer.from('NOT-A-PDF');
    const { session } = makeSession(async (method, _params, api) => {
      if (method === 'Runtime.evaluate') {
        writeFileSync(join(outDir, guid), bad);
        await api.emit('Browser.downloadWillBegin', { guid, url: 'https://tdoss.liepin.com/bad.bin' });
        await api.emit('Browser.downloadProgress', { guid, state: 'completed', receivedBytes: bad.length, totalBytes: bad.length });
        return { result: { value: 'opened' } };
      }
      return undefined;
    });
    const { page } = makePage({ chatList: okChatList(), attachment: okAttachment() }, { session, outDir, guid });

    const result = await attachFetch(page, { imId: 'opp-im', outDir });
    assert.equal(result.success, false);
    assert.equal((result as any).reason, 'verify-failed');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('超过 maxBytes:取消下载并返回 download-failed', async () => {
  const outDir = tempOutDir();
  try {
    const maxBytes = 100;
    const { session, sends } = makeSession(async (method, _params, api) => {
      if (method === 'Runtime.evaluate') {
        await api.emit('Browser.downloadWillBegin', { guid: 'g-big', url: 'https://tdoss.liepin.com/big.pdf' });
        await api.emit('Browser.downloadProgress', { guid: 'g-big', state: 'inProgress', receivedBytes: maxBytes + 1, totalBytes: maxBytes + 1 });
        return { result: { value: 'opened' } };
      }
      return undefined;
    });
    const { page } = makePage({ chatList: okChatList(), attachment: okAttachment() }, { session, outDir });

    const result = await attachFetch(page, { imId: 'opp-im', outDir, maxBytes });
    assert.equal(result.success, false);
    assert.equal((result as any).reason, 'download-failed');
    assert.ok(sends.some((s) => s.method === 'Browser.cancelDownload' && s.params.guid === 'g-big'), '应取消超限下载');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('下载来源非 liepin 域:取消并返回 download-failed', async () => {
  const outDir = tempOutDir();
  try {
    const { session, sends } = makeSession(async (method, _params, api) => {
      if (method === 'Runtime.evaluate') {
        await api.emit('Browser.downloadWillBegin', { guid: 'g-evil', url: 'https://evil.example.com/steal.pdf' });
        return { result: { value: 'opened' } };
      }
      return undefined;
    });
    const { page } = makePage({ chatList: okChatList(), attachment: okAttachment() }, { session, outDir });

    const result = await attachFetch(page, { imId: 'opp-im', outDir });
    assert.equal(result.success, false);
    assert.equal((result as any).reason, 'download-failed');
    assert.ok(sends.some((s) => s.method === 'Browser.cancelDownload' && s.params.guid === 'g-evil'), '应取消非受信来源下载');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('弹窗被拦截(触发未生效):download-failed', async () => {
  const outDir = tempOutDir();
  try {
    const { session } = makeSession(async (method) => {
      if (method === 'Runtime.evaluate') {
        return { result: { value: null } }; // window.open 返回 null = 被拦截
      }
      return undefined;
    });
    const { page } = makePage({ chatList: okChatList(), attachment: okAttachment() }, { session, outDir });

    const result = await attachFetch(page, { imId: 'opp-im', outDir });
    assert.equal(result.success, false);
    assert.equal((result as any).reason, 'download-failed');
    assert.match((result as any).detail, /触发失败/);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('缺少 imId / out 直接报错(不触达页面)', async () => {
  const { session } = makeSession();
  const { page } = makePage({}, { session });
  await assert.rejects(attachFetch(page, { imId: '', outDir: 'x' } as any), /imId/);
  await assert.rejects(attachFetch(page, { imId: 'im', outDir: '' } as any), /out/);
});

test('findAttachmentSign:取最新一条 bizType=7 的签名;非 7/无 param 跳过', () => {
  const list = [
    attachMessage('newest-sign'),
    { msgId: 'm-2', msgSendImId: 'opp-im', payload: JSON.stringify({ ext: { extBody: { bizData: { bizType: '1' } } } }) },
    attachMessage('older-sign'),
  ];
  assert.equal(findAttachmentSign(list, 'opp-im'), 'newest-sign');
  assert.equal(findAttachmentSign([textMessage()], 'opp-im'), null);
});

test('findAttachmentSign:只认对方消息;我方带卡片的消息忽略(不把我方卡片当候选人简历)', () => {
  const mine = attachMessage('mine-sign', undefined, 'own-im');
  const theirs = attachMessage('opp-sign', undefined, 'opp-im');
  assert.equal(findAttachmentSign([mine], 'opp-im'), null);
  assert.equal(findAttachmentSign([mine, theirs], 'opp-im'), 'opp-sign');
});

test('命令注册:attach-fetch 参数与默认值', () => {
  assert.equal(attachFetchCommand.name, 'attach-fetch');
  const args: any[] = attachFetchCommand.args as any[];
  const imId = args.find((a) => a.name === 'imId');
  const out = args.find((a) => a.name === 'out');
  const maxBytes = args.find((a) => a.name === 'maxBytes');
  assert.equal(imId?.required, true);
  assert.equal(out?.required, true);
  assert.equal(maxBytes?.default, 20 * 1024 * 1024);
  assert.equal(typeof attachFetchCommand.func, 'function');
  assert.ok(attachFetchCommand.columns.length > 0);
});
