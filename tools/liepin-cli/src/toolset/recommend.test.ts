import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recommend, recommendCommand } from './recommend.js';

// 只替代浏览器边界，不建立连接、不执行 evaluate 回调。
function fakePage(init: any, list: any[] = [], flag = 1) {
  const requests: { url: string; body: URLSearchParams }[] = [];
  const page: any = {
    url: () => 'https://lpt.liepin.com/recommend',
    goto: async () => {},
    evaluate: async (_fn: any, url: string, body: string) => {
      requests.push({ url, body: new URLSearchParams(body) });
      const data = url.endsWith('.init') ? { flag: 1, data: init } : { flag, msg: flag === 1 ? '' : '无权限', data: { list } };
      return { ok: true, status: 200, text: JSON.stringify(data) };
    },
  };
  return { page, requests };
}

for (const jobId of ['', '0', '-1', 'abc', '9007199254740993']) {
  test(`推荐拒绝缺失或非法岗位 ${jobId || '空'}，不回退默认岗位`, async () => {
    const { page, requests } = fakePage({ ejobId: 101, jobs: [{ jobId: 101 }] });
    await assert.rejects(recommend(page, { jobId }), /jobId|岗位|职位/);
    assert.equal(requests.length, 0);
  });
}

test('推荐未证实分页契约：第二页显式受限且不请求', async () => {
  const { page, requests } = fakePage({ ejobId: 101 });
  await assert.rejects(recommend(page, { jobId: '101', page: 2 }), /分页.*未验证|不支持.*分页/);
  assert.equal(requests.length, 0);
});

test('标题不能静默代替岗位ID或作为未实现的过滤器', async () => {
  const { page, requests } = fakePage({ ejobId: 101 });
  await assert.rejects(recommend(page, { jobId: '101', jobTitle: '硬件工程师' }), /jobTitle/);
  assert.equal(requests.length, 0);
});

for (const id of ['101', '202']) {
  test(`指定岗位 ${id} 精确透传，允许两岗位推荐同一人`, async () => {
    const { page, requests } = fakePage({ ejobId: Number(id) }, [{ resume: { enresId: 'same-mock-resume' }, job: { jobId: Number(id) } }]);
    const result = await recommend(page, { jobId: id });
    assert.equal(requests[0].body.get('ejobId'), id);
    const query = JSON.parse(requests[1].body.get('lpRecommendQueryInputVo')!);
    assert.equal(query.ejobId, Number(id));
    assert.equal(query.curPage, undefined);
    assert.equal(result[0].job_id, id);
    assert.equal(result[0].requested_job_id, id);
    assert.equal(result[0].job_association, 'matched');
    assert.equal(result[0].pagination_status, 'unverified');
  });
}

for (const init of [{ ejobId: 202 }, { jobs: [{ jobId: 101 }] }]) {
  test('初始化未确认目标岗位时拒绝继续请求', async () => {
    const { page, requests } = fakePage(init);
    await assert.rejects(recommend(page, { jobId: '101' }), /职位|岗位/);
    assert.equal(requests.length, 1);
  });
}

test('响应关联其他岗位时拒绝整批结果', async () => {
  const { page } = fakePage({ ejobId: 101 }, [{ job: { jobId: 202 } }]);
  await assert.rejects(recommend(page, { jobId: '101' }), /职位|岗位/);
});

test('无逐条岗位证据标为unknown，不用请求岗位冒充响应岗位', async () => {
  const { page } = fakePage({ ejobId: 101 }, [{ resume: { enresId: 'mock' } }]);
  const result = await recommend(page, { jobId: '101' });
  assert.equal(result[0].job_id, '');
  assert.equal(result[0].job_association, 'unknown');
});

test('推荐权限不足不当作空列表', async () => {
  const { page } = fakePage({ ejobId: 101 }, [], 0);
  await assert.rejects(recommend(page, { jobId: '101' }), /失败/);
});

test('CLI岗位ID为必填参数，在启动浏览器前检查缺失', () => {
  assert.equal((recommendCommand.args.find(a => a.name === 'jobId') as any)?.required, true);
});
