/**
 * attach-download 命令测试：全部使用 mock page 与 mock CDP session，
 * 不触达真实浏览器、不产生真实下载。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachDownload, attachDownloadCommand } from './attach-download.js';

// 缩短"等不到元素"路径的等待（waitForSelectorSafe 在调用时读取），测试不真等 15 秒
process.env.LIEPIN_SELECTOR_TIMEOUT_MS = '300';

const PDF = Buffer.concat([
  Buffer.from('%PDF-1.7\n'),
  Buffer.from('mock body bytes'),
  Buffer.from('\n%%EOF\n'),
]);

interface SessionApi {
  emit: (method: string, params: any) => Promise<void>;
}

/** mock CDP 会话：记录 send、可注册事件回调，并支持在 send 时回放下载事件 */
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

interface PageOptions {
  session: any;
  sessionStatus?: string;
  attachmentClicked?: boolean;
  downloadButtons?: number;
  rejectSelector?: string;
}

/** mock page：按 evaluate 函数源码中的选择器路由返回值，模拟三类 DOM 查询 */
function makePage(opts: PageOptions) {
  const evaluateSources: string[] = [];
  const waited: string[] = [];
  const page: any = {
    url: () => 'https://lpt.liepin.com/chat/im',
    goto: async () => {},
    mainFrame: () => ({}),
    evaluate: async (fn: any, ..._args: any[]) => {
      const src = String(fn);
      evaluateSources.push(src);
      // waitForSelectorSafe：按选择器实参判存在性（rejectSelector 指定"等不到"的元素）
      const argSelector = typeof _args[0] === 'string' ? (_args[0] as string) : undefined;
      if (argSelector && src.includes('Boolean(document.querySelector(')) {
        return argSelector !== opts.rejectSelector;
      }
      if (src.includes('im-ui-contact-list-item')) return opts.sessionStatus ?? 'clicked';
      if (src.includes('im-ui-send-attachment-card')) return opts.attachmentClicked ?? true;
      if (src.includes('im-ui-preview-modal-title-box')) return opts.downloadButtons ?? 1;
      return undefined;
    },
    target: () => ({ createCDPSession: async () => opts.session }),
    browser: () => ({ target: () => ({ createCDPSession: async () => opts.session }) }),
  };
  return { page, evaluateSources, waited };
}

function tempOutDir(): string {
  return mkdtempSync(join(tmpdir(), 'attach-download-'));
}

test('成功路径：输出 file/bytes/sha256/sourceOrigin，并恢复默认下载行为', async () => {
  const outDir = tempOutDir();
  try {
    const guid = 'abcdef1234567890';
    const { session, sends } = makeSession(async (method, _params, api) => {
      if (method === 'Runtime.evaluate') {
        writeFileSync(join(outDir, guid), PDF);
        await api.emit('Browser.downloadWillBegin', {
          guid,
          url: 'https://tdoss.liepin.com/attach/abc.pdf',
        });
        await api.emit('Browser.downloadProgress', {
          guid,
          state: 'completed',
          receivedBytes: PDF.length,
          totalBytes: PDF.length,
        });
        return { result: { value: 'clicked' } };
      }
      return undefined;
    });
    const { page } = makePage({ session });

    const result = await attachDownload(page, { imId: 'im-target', outDir });

    assert.equal(result.success, true);
    assert.equal(result.bytes, PDF.length);
    assert.equal(result.sha256, createHash('sha256').update(PDF).digest('hex'));
    assert.equal(result.sourceOrigin, 'https://tdoss.liepin.com');
    assert.ok(result.file.endsWith(guid));

    const behaviors = sends
      .filter((s) => s.method === 'Browser.setDownloadBehavior')
      .map((s) => s.params.behavior);
    assert.ok(behaviors.includes('allowAndName'), '应设置 allowAndName');
    assert.equal(behaviors[behaviors.length - 1], 'default', '结束时应恢复默认下载行为');
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('会话未找到：报错且不点击、不进入后续步骤', async () => {
  const outDir = tempOutDir();
  try {
    const { session } = makeSession();
    const { page, evaluateSources, waited } = makePage({ session, sessionStatus: 'none' });
    await assert.rejects(attachDownload(page, { imId: 'im-x', outDir }), /会话不存在/);
    assert.equal(evaluateSources.length, 1);
    assert.equal(waited.length, 0);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('多个会话项匹配同一 imId：报错（歧义不猜）', async () => {
  const outDir = tempOutDir();
  try {
    const { session } = makeSession();
    const { page, evaluateSources, waited } = makePage({ session, sessionStatus: 'multiple' });
    await assert.rejects(attachDownload(page, { imId: 'im-x', outDir }), /不唯一|歧义/);
    assert.equal(evaluateSources.length, 1);
    assert.equal(waited.length, 0);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('缺少 imId / out 直接报错（不触达页面）', async () => {
  const { session } = makeSession();
  const { page, evaluateSources } = makePage({ session });
  await assert.rejects(attachDownload(page, { imId: '', outDir: 'x' } as any), /imId/);
  await assert.rejects(attachDownload(page, { imId: 'im', outDir: '' } as any), /out/);
  assert.equal(evaluateSources.length, 0);
});

test('无附件卡片（等待超时）：报错', async () => {
  const outDir = tempOutDir();
  try {
    const { session } = makeSession();
    const { page } = makePage({ session, rejectSelector: '.im-ui-send-attachment-card' });
    await assert.rejects(attachDownload(page, { imId: 'im', outDir }), /附件卡片/);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('有卡片但无「附件简历」入口：报错（不任选）', async () => {
  const outDir = tempOutDir();
  try {
    const { session } = makeSession();
    const { page } = makePage({ session, attachmentClicked: false });
    await assert.rejects(attachDownload(page, { imId: 'im', outDir }), /附件简历/);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('预览弹窗未出现（等待超时）：报错', async () => {
  const outDir = tempOutDir();
  try {
    const { session } = makeSession();
    const { page } = makePage({ session, rejectSelector: '.im-ui-preview-modal-title-box' });
    await assert.rejects(attachDownload(page, { imId: 'im', outDir }), /预览弹窗/);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('无下载按钮：报错；下载按钮不唯一：报错（不任选）', async () => {
  const outDir = tempOutDir();
  try {
    const zero = makePage({ session: makeSession().session, downloadButtons: 0 });
    await assert.rejects(attachDownload(zero.page, { imId: 'im', outDir }), /下载按钮/);

    const many = makePage({ session: makeSession().session, downloadButtons: 2 });
    await assert.rejects(attachDownload(many.page, { imId: 'im', outDir }), /不唯一/);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('下载事件来源非受信：cancel 并报错', async () => {
  const outDir = tempOutDir();
  try {
    const { session, sends } = makeSession(async (method, _params, api) => {
      if (method === 'Runtime.evaluate') {
        await api.emit('Browser.downloadWillBegin', {
          guid: 'g-evil',
          url: 'https://evil.example.com/steal.pdf',
        });
        return { result: { value: 'clicked' } };
      }
      return undefined;
    });
    const { page } = makePage({ session });
    await assert.rejects(attachDownload(page, { imId: 'im', outDir }), /来源|取消/);
    assert.ok(
      sends.some((s) => s.method === 'Browser.cancelDownload' && s.params.guid === 'g-evil'),
      '应取消非受信来源下载',
    );
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('进度超过 maxBytes：cancel 并报错', async () => {
  const outDir = tempOutDir();
  try {
    const maxBytes = 100;
    const { session, sends } = makeSession(async (method, _params, api) => {
      if (method === 'Runtime.evaluate') {
        await api.emit('Browser.downloadWillBegin', {
          guid: 'g-big',
          url: 'https://wow.liepin.com/attach/big.pdf',
        });
        await api.emit('Browser.downloadProgress', {
          guid: 'g-big',
          state: 'inProgress',
          receivedBytes: maxBytes + 1,
          totalBytes: maxBytes + 1,
        });
        return { result: { value: 'clicked' } };
      }
      return undefined;
    });
    const { page } = makePage({ session });
    await assert.rejects(attachDownload(page, { imId: 'im', outDir, maxBytes }), /上限|超过/);
    assert.ok(
      sends.some((s) => s.method === 'Browser.cancelDownload' && s.params.guid === 'g-big'),
      '应取消超限下载',
    );
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('下载完成但文件无 %PDF- 签名：失败', async () => {
  const outDir = tempOutDir();
  try {
    const guid = 'not-a-pdf-0001';
    const bad = Buffer.from('NOT-A-PDF-CONTENT');
    const { session } = makeSession(async (method, _params, api) => {
      if (method === 'Runtime.evaluate') {
        writeFileSync(join(outDir, guid), bad);
        await api.emit('Browser.downloadWillBegin', {
          guid,
          url: 'https://tdoss.liepin.com/attach/bad.bin',
        });
        await api.emit('Browser.downloadProgress', {
          guid,
          state: 'completed',
          receivedBytes: bad.length,
          totalBytes: bad.length,
        });
        return { result: { value: 'clicked' } };
      }
      return undefined;
    });
    const { page } = makePage({ session });
    await assert.rejects(attachDownload(page, { imId: 'im', outDir }), /PDF/);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('命令注册：attach-download 参数与默认值', () => {
  assert.equal(attachDownloadCommand.name, 'attach-download');
  assert.equal(typeof attachDownloadCommand.description, 'string');
  const args: any[] = attachDownloadCommand.args as any[];
  const imId = args.find((a) => a.name === 'imId');
  const out = args.find((a) => a.name === 'out');
  const maxBytes = args.find((a) => a.name === 'maxBytes');
  assert.equal(imId?.required, true);
  assert.equal(out?.required, true);
  assert.equal(maxBytes?.default, 20 * 1024 * 1024);
  assert.equal(typeof attachDownloadCommand.func, 'function');
  assert.ok(attachDownloadCommand.columns.length > 0);
});
