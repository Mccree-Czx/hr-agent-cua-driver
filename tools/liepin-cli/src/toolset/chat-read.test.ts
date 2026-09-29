import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatlist } from './chatlist.js';
import { chatmsg } from './chatmsg.js';

function fakePage(data: any, status = 200) {
  const requests: { url: string; body: URLSearchParams }[] = [];
  const page: any = {
    url: () => 'https://lpt.liepin.com/recommend',
    goto: async () => {},
    evaluate: async (_fn: any, ...args: any[]) => {
      if (!args.length) return 'self-mock';
      requests.push({ url: args[0], body: new URLSearchParams(args[1]) });
      return { ok: status === 200, status, text: JSON.stringify({ flag: 1, data }) };
    },
  };
  return { page, requests };
}

const filePayload = JSON.stringify({ bodies: [{ type: 'file', fileId: 'mock-file-1', filename: 'mock.pdf', size: 456,
  url: 'https://files.example.invalid/a?token=MOCK_TOKEN', token: 'MOCK_TOKEN', nested: { authorization: 'MOCK_AUTH' } }] });

test('聊天列表页码透传curPage，保留服务器分页元数据但不宣称穷尽', async () => {
  const { page, requests } = fakePage({ list: [{ oppositeImId: 'other-mock', oppositeUserId: 'user-mock', lastPayload: filePayload }], total: 75, curPage: 1 });
  const result: any = await chatlist(page, { page: 2, limit: 20, withMeta: true } as any);
  assert.equal(requests[0].body.get('curPage'), '1');
  assert.equal(requests[0].body.get('pageSize'), '20');
  assert.equal(result.pagination.response.total, 75);
  assert.equal(result.pagination.status, 'unverified');
  assert.equal(result.pagination.complete, false);
  assert.equal(result.items[0].im_id, 'other-mock');
  assert.equal(result.items[0].job_association, 'unknown');
  assert.equal(result.items[0].last_payload.bodies[0].fileId, 'mock-file-1');
  assert.ok(!JSON.stringify(result).includes('MOCK_TOKEN'));
});

test('消息游标原样编码，不当页码；消息ID、发送者、所有payload附件字段保留并脱敏', async () => {
  const { page, requests } = fakePage({ list: [{ msgId: 'm-2', msgTime: 1000, msgSendImId: 'other-mock', payload: filePayload, msgType: 'file' }], maxMessageId: 'server-cursor' });
  const result: any = await chatmsg(page, { oppositeImId: 'other-mock', maxMessageId: 'cursor&=1', withMeta: true } as any);
  assert.equal(requests[0].body.get('maxMessageId'), 'cursor&=1');
  assert.equal(requests[0].body.get('oppositeImId'), 'other-mock');
  assert.equal(result.items[0].message_id, 'm-2');
  assert.equal(result.items[0].sender_im_id, 'other-mock');
  assert.equal(result.items[0].payload.bodies[0].fileId, 'mock-file-1');
  assert.equal(result.items[0].payload.bodies[0].filename, 'mock.pdf');
  assert.equal(result.items[0].attachment_status, 'unverified');
  assert.equal(result.items[0].job_association, 'unknown');
  assert.equal(result.pagination.response.maxMessageId, 'server-cursor');
  assert.ok(!JSON.stringify(result).includes('MOCK_TOKEN'));
  assert.ok(!JSON.stringify(result).includes('MOCK_AUTH'));
  assert.ok(!JSON.stringify(result).includes('https://files'));
});

test('附件和命令卡片展示标签不被误判为损坏JSON', async () => {
  const { page } = fakePage({ list: [
    { msgId: 'file', payload: filePayload },
    { msgId: 'cmd', payload: JSON.stringify({ bodies: [{ type: 'cmd' }] }) },
  ] });
  const result = await chatmsg(page, { oppositeImId: 'other-mock' });
  assert.equal(result.find((item: any) => item.message_id === 'file').content, '[file]');
  assert.equal(result.find((item: any) => item.message_id === 'cmd').content, '[cmd]');
});

test('展示文本保持字符串，JSON文本凭据和普通文本下载地址仍脱敏', async () => {
  for (const [text, expected] of [
    ['[面试] 请查看 https://files.example.invalid/a?token=MOCK_TOKEN', '[面试] 请查看 [redacted-url]'],
    ['{"token":"MOCK_TOKEN","note":"mock"}', '{"token":"[redacted]","note":"mock"}'],
  ]) {
    const payload = JSON.stringify({ bodies: [{ type: 'txt', msg: text }] });
    const messagePage = fakePage({ list: [{ msgId: 'text', payload }] });
    const messages = await chatmsg(messagePage.page, { oppositeImId: 'other-mock' });
    assert.equal(messages[0].content, expected);
    const contactPage = fakePage({ list: [{ lastPayload: payload }] });
    const contacts = await chatlist(contactPage.page, {});
    assert.equal(contacts[0].latest_msg, expected);
  }
});

test('结构化附件保留括号开头的文件名', async () => {
  const filename = '[测试样本]简历.pdf';
  const payload = JSON.stringify({ bodies: [{ type: 'file', fileId: 'mock-bracket', filename }] });
  const messages = await chatmsg(fakePage({ list: [{ msgId: 'bracket', payload }] }).page,
    { oppositeImId: 'other-mock' });
  const contacts = await chatlist(fakePage({ list: [{ lastPayload: payload }] }).page, {});
  assert.equal(messages[0].payload.bodies[0].filename, filename);
  assert.equal(contacts[0].last_payload.bodies[0].filename, filename);
});

test('结构化payload中的JSON文本脱敏后保持字符串类型', async () => {
  const msg = '{"note":"mock","token":"MOCK_TOKEN"}';
  const payload = JSON.stringify({ bodies: [{ type: 'txt', msg }] });
  const messages = await chatmsg(fakePage({ list: [{ msgId: 'nested', payload }] }).page,
    { oppositeImId: 'other-mock' });
  const contacts = await chatlist(fakePage({ list: [{ lastPayload: payload }] }).page, {});
  for (const body of [messages[0].payload.bodies[0], contacts[0].last_payload.bodies[0]]) {
    assert.equal(typeof body.msg, 'string');
    assert.deepEqual(JSON.parse(body.msg), { note: 'mock', token: '[redacted]' });
  }
});

test('完全重复消息按ID去重，同ID内容冲突保留证据，无ID不合并', async () => {
  const item = { msgId: 'm1', payload: JSON.stringify({ bodies: [{ type: 'txt', msg: 'mock' }] }) };
  const { page } = fakePage({ list: [item, item, { ...item, payload: filePayload }, { payload: '{}' }, { payload: '{}' }] });
  const result = await chatmsg(page, { oppositeImId: 'other-mock' });
  assert.equal(result.length, 4);
  assert.equal(result.filter((x: any) => x.message_id === 'm1').length, 2);
  assert.ok(result.filter((x: any) => x.message_id === 'm1').every((x: any) => x.duplicate_message_id));
});

test('缺失发送者/岗位/损坏payload为unknown而非猜测为对方或附件', async () => {
  const { page } = fakePage({ list: [{ msgId: 'm1', payload: 'not-json MOCK_TOKEN' }] });
  const result = await chatmsg(page, { oppositeImId: 'other-mock' });
  assert.equal(result[0].sender, '未知');
  assert.equal(result[0].job_association, 'unknown');
  assert.equal(result[0].payload_status, 'invalid');
  assert.equal(result[0].payload, null);
});

test('空页不推断附件/会话不存在，也不推断已查完', async () => {
  const { page } = fakePage({ list: [] });
  const result: any = await chatlist(page, { withMeta: true } as any);
  assert.deepEqual(result.items, []);
  assert.equal(result.pagination.complete, false);
});

for (const [name, run] of [
  ['列表非法页码', (page: any) => chatlist(page, { page: 0 } as any)],
  ['消息非法上限', (page: any) => chatmsg(page, { oppositeImId: 'mock', limit: 101 })],
] as const) {
  test(name, async () => {
    const { page, requests } = fakePage({ list: [] });
    await assert.rejects(run(page), /page|limit|页码|条数/);
    assert.equal(requests.length, 0);
  });
}

test('聊天权限不足不能伪装为没有消息', async () => {
  const { page } = fakePage({}, 403);
  await assert.rejects(chatmsg(page, { oppositeImId: 'mock' }), { name: 'AuthExpiredError' });
});

test('缺少list响应是契约错误，不作为正常空页', async () => {
  const { page } = fakePage({});
  await assert.rejects(chatlist(page, {}), /list|列表/);
});
