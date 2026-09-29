/**
 * chatlist 命令测试：mock page，不触达真实浏览器。
 * 回归重点（2026-09-27）：平台对 pageSize>50 静默降级为默认 20，造成轮询会话盲区。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatlist } from './chatlist.js';

/** mock page：拦截 lptFetch 的请求体（4 实参 evaluate），返回 50 条会话 */
function fakePage() {
  const bodies: string[] = [];
  const page: any = {
    url: () => 'https://lpt.liepin.com/recommend',
    goto: async () => {},
    mainFrame: () => ({}),
    evaluate: async (_fn: any, ...args: any[]) => {
      if (args.length === 0) return 'me-im'; // readLptImId
      bodies.push(String(args[1]));
      const list = Array.from({ length: 50 }, (_, i) => ({
        oppositeImId: `im-${i}`,
        oppositeUserId: `u-${i}`,
        name: `候选人${i}`,
        lastPayload: '{}',
        direction: '1',
        latestMsgTime: Date.now() - i * 1000,
      }));
      return { ok: true, status: 200, text: JSON.stringify({ flag: 1, data: { list, hasMore: false, curPage: 0, pageSize: 50 } }) };
    },
  };
  return { page, bodies };
}

test('chatlist: limit>50 钳制为 50 请求（平台 >50 会静默降级为 20 的回归防护）', async () => {
  const { page, bodies } = fakePage();

  const items = await chatlist(page, { limit: 100 } as any);

  assert.ok(bodies[0].includes('pageSize=50'), `请求体应含 pageSize=50，实际: ${bodies[0]}`);
  assert.ok(!bodies[0].includes('pageSize=100'), '不得把 100 透传给平台（会被降级为 20）');
  assert.equal(items.length, 50, 'limit=100 时按生效上限返回 50 条');
});

test('chatlist: limit<=50 原样透传', async () => {
  const { page, bodies } = fakePage();

  const items = await chatlist(page, { limit: 30 } as any);

  assert.ok(bodies[0].includes('pageSize=30'), `请求体应含 pageSize=30，实际: ${bodies[0]}`);
  assert.equal(items.length, 30);
});
