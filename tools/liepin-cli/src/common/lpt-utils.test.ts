import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertLptPageAlive, clickSafe, RiskControlError, safeGoto, waitForSelectorSafe, withTimeout } from './lpt-utils.js';

const fakePage = (url: string) => ({ url: () => url }) as any;

test('assertLptPageAlive: about:blank 抛 RiskControlError（issue #17 安全脚本清空页面）', () => {
  assert.throws(
    () => assertLptPageAlive(fakePage('about:blank'), '请求完成'),
    (e: any) => e instanceof RiskControlError && /about:blank/.test(e.message),
  );
});

test('assertLptPageAlive: chrome-error 页同样视为不可继续', () => {
  assert.throws(
    () => assertLptPageAlive(fakePage('chrome-error://chromewebdata/'), '导航'),
    RiskControlError,
  );
});

test('assertLptPageAlive: 正常 LPT 页面不抛错', () => {
  assertLptPageAlive(fakePage('https://lpt.liepin.com/search'), '发起请求');
});

/** 记录调用顺序的假 Page：mainFrame().client.send + goto */
function recordingPage(opts: { gotoError?: Error } = {}) {
  const calls: string[] = [];
  const page: any = {
    mainFrame: () => ({ client: { send: async (m: string) => { calls.push(m); } } }),
    goto: async () => {
      calls.push('goto');
      if (opts.gotoError) throw opts.gotoError;
    },
  };
  return { page, calls };
}

test('safeGoto: 导航期间关闭 Runtime，加载完成后恢复', async () => {
  const { page, calls } = recordingPage();
  await safeGoto(page, 'https://lpt.liepin.com/job/manager');
  assert.deepEqual(calls, ['Runtime.disable', 'goto', 'Runtime.enable']);
});

test('safeGoto: goto 抛错也要恢复 Runtime', async () => {
  const { page, calls } = recordingPage({ gotoError: new Error('boom') });
  await assert.rejects(() => safeGoto(page, 'https://lpt.liepin.com/'), /boom/);
  assert.deepEqual(calls, ['Runtime.disable', 'goto', 'Runtime.enable']);
});

test('safeGoto: 显式传递 30s 导航超时(不允许无界挂起)', async () => {
  const options: any[] = [];
  const page: any = {
    mainFrame: () => ({ client: { send: async () => {} } }),
    goto: async (_url: string, opts: any) => { options.push(opts); },
  };
  await safeGoto(page, 'https://lpt.liepin.com/');
  assert.equal(options[0]?.timeout, 30000);
});

test('withTimeout: 按时完成时原样返回', async () => {
  assert.equal(await withTimeout(Promise.resolve(42), 1000, '测试'), 42);
});

test('withTimeout: 超期未完成时抛出带标签的诊断错误', async () => {
  await assert.rejects(
    () => withTimeout(new Promise(() => {}), 50, 'lptFetch 页内请求'),
    /lptFetch 页内请求 超时\(50ms\)/,
  );
});

test('withTimeout: 原始拒绝原样透传', async () => {
  await assert.rejects(() => withTimeout(Promise.reject(new Error('boom')), 1000, '测试'), /boom/);
});

test('safeGoto: 拿不到主会话（mock page）时退化为普通 goto', async () => {
  const calls: string[] = [];
  const page: any = { goto: async () => { calls.push('goto'); } };
  await safeGoto(page, 'https://lpt.liepin.com/');
  assert.deepEqual(calls, ['goto']);
});

test('waitForSelectorSafe: 轮询至命中（evaluate 不受后台页签 rAF 挂起影响）', async () => {
  let calls = 0;
  const page: any = {
    evaluate: async () => {
      calls += 1;
      return calls >= 3;
    },
  };
  await waitForSelectorSafe(page, '.x', { timeout: 2000, intervalMs: 5 });
  assert.equal(calls, 3);
});

test('waitForSelectorSafe: 超时抛出带选择器与时长的错误', async () => {
  const page: any = { evaluate: async () => false };
  await assert.rejects(
    () => waitForSelectorSafe(page, '.never', { timeout: 60, intervalMs: 10 }),
    /等待元素超时（60ms）: \.never/,
  );
});

test('waitForSelectorSafe: 单次查询报错不终止轮询，后续命中仍成功', async () => {
  let calls = 0;
  const page: any = {
    evaluate: async () => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
      return true;
    },
  };
  await waitForSelectorSafe(page, '.x', { timeout: 2000, intervalMs: 5 });
  assert.equal(calls, 2);
});

test('clickSafe: 元素存在时执行页面内点击', async () => {
  const seen: string[] = [];
  const page: any = {
    evaluate: async (_fn: unknown, sel: string) => {
      seen.push(sel);
      return true;
    },
  };
  await clickSafe(page, '.btn');
  assert.deepEqual(seen, ['.btn']);
});

test('clickSafe: 页面中不存在元素时报明确错误', async () => {
  const page: any = { evaluate: async () => false };
  await assert.rejects(
    () => clickSafe(page, '.missing'),
    /点击失败：页面中不存在元素 \.missing/,
  );
});
