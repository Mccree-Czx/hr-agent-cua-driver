import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as module from './resume.js';

function fakePage(vo: any, status = 200) {
  const requests: URLSearchParams[] = [];
  const page: any = {
    url: () => 'https://lpt.liepin.com/search',
    evaluate: async (_fn: any, ...args: any[]) => {
      if (!args.length) return 'https://lpt.liepin.com/search';
      requests.push(new URLSearchParams(args[1]));
      return { ok: status === 200, status, text: JSON.stringify({ flag: 1, data: { resumeDetailVo: vo } }) };
    },
  };
  return { page, requests };
}

const cases: [string, any, string, string][] = [
  ['硬件研发和高级硬件同类型', ['高级硬件工程师'], '硬件研发工程师', 'match'],
  ['HR总监与硬件不同', ['人力资源总监'], '硬件工程师', 'mismatch'],
  ['多个期望一个匹配', ['人力资源总监', '高级硬件工程师'], '硬件研发工程师', 'match'],
  ['多个明确期望均不匹配', ['人力资源总监', '招聘经理'], '硬件工程师', 'mismatch'],
  ['只有当前职位匹配仍不放行', ['人力资源总监'], '硬件工程师', 'mismatch'],
  ['缺失期望不使用当前职位', undefined, '硬件工程师', 'unknown'],
  ['空期望', [], '硬件工程师', 'unknown'],
  ['未映射工程师不能泛化放行', ['工程师'], '硬件工程师', 'unknown'],
  ['同业软件工程师仍为不同职能', ['软件工程师'], '硬件工程师', 'mismatch'],
  ['未知方向不能断言全部不匹配', ['招聘经理', '未映射方向'], '硬件工程师', 'unknown'],
  ['期望字段类型异常', '高级硬件工程师', '硬件工程师', 'unknown'],
  ['期望数组夹杂损坏数据', ['高级硬件工程师', 42], '硬件工程师', 'unknown'],
  ['空目标', ['高级硬件工程师'], '', 'unknown'],
];

for (const [name, titles, targetTitle, status] of cases) {
  test(`期望匹配：${name}`, async () => {
    const { page, requests } = fakePage({ baseInfo: { title: '硬件工程师' }, jobWant: { jobTitleNames: titles } });
    const result = await module.resume(page, { talentId: 'mock-resume', targetTitle } as any);
    assert.equal(result.expectation_match?.status, status);
    assert.equal(result.expectation_match?.can_continue_scoring, status === 'match');
    assert.equal(result.expectation_match?.can_send, false);
    assert.equal(result.expectation_evidence?.source, 'resumeDetailVo.jobWant.jobTitleNames');
    assert.equal(result.expectation_evidence?.category_status, 'unverified');
    assert.equal(JSON.parse(requests[0].get('pageParamVo')!).resIdEncode, 'mock-resume');
  });
}

test('保留多个原始期望，不将当前职位或未知分类字段充当分类证据', async () => {
  const { page } = fakePage({ baseInfo: { title: '硬件工程师' }, jobWant: { jobTitleNames: ['人力资源总监', '高级硬件工程师'], guessedCode: 'unverified' } });
  const result = await module.resume(page, { talentId: 'mock-resume' });
  assert.deepEqual(result.expectation_evidence?.entries, [{ title: '人力资源总监' }, { title: '高级硬件工程师' }]);
  assert.equal(result.want_title, '人力资源总监、高级硬件工程师');
  assert.equal(result.expectation_evidence?.category_status, 'unverified');
});

test('已核实的归一化分类与期望标题冲突时为unknown，不能被另一个匹配覆盖', () => {
  const match = (module as any).matchJobExpectations;
  assert.equal(typeof match, 'function');
  const result = match({
    source: 'resumeDetailVo.jobWant.jobTitleNames',
    entries: [
      { title: '高级硬件工程师', reviewedFamily: 'hr', categorySource: 'mock-reviewed-taxonomy' },
      { title: '硬件研发工程师' },
    ],
    malformed: false,
  }, { title: '硬件工程师' });
  assert.equal(result.status, 'unknown');
  assert.equal(result.can_send, false);
});

test('目标标题与已核实分类冲突也为unknown', () => {
  const match = (module as any).matchJobExpectations;
  assert.equal(typeof match, 'function');
  assert.equal(match({ source: 'resumeDetailVo.jobWant.jobTitleNames', entries: [{ title: '硬件工程师' }] },
    { title: '硬件工程师', reviewedFamily: 'hr', categorySource: 'mock-reviewed-taxonomy' }).status, 'unknown');
});

test('分类没有可追溯证据时不得单独产生匹配', () => {
  const match = (module as any).matchJobExpectations;
  assert.equal(typeof match, 'function');
  assert.equal(match({ source: 'resumeDetailVo.jobWant.jobTitleNames', entries: [{ title: '未映射职位', reviewedFamily: 'hardware' }] },
    { title: '硬件工程师' }).status, 'unknown');
});

test('错误来源的职位证据拒绝匹配', () => {
  const match = (module as any).matchJobExpectations;
  assert.equal(typeof match, 'function');
  assert.equal(match({ source: 'baseInfo.title', entries: [{ title: '硬件工程师' }] }, { title: '硬件工程师' }).status, 'unknown');
});

test('职能映射扩展:新四族同义匹配(与后端 JobMatchEvaluatorTest 对齐)', () => {
  const match = (module as any).matchJobExpectations;
  assert.equal(match({ source: 'resumeDetailVo.jobWant.jobTitleNames', entries: [{ title: '跨境电商运营' }] },
    { title: '资深亚马逊运营' }).status, 'match');
  assert.equal(match({ source: 'resumeDetailVo.jobWant.jobTitleNames', entries: [{ title: '渠道经理' }] },
    { title: '海外ToB渠道销售（出海品牌）' }).status, 'match');
  assert.equal(match({ source: 'resumeDetailVo.jobWant.jobTitleNames', entries: [{ title: '机械结构工程师' }] },
    { title: '高级结构工程师' }).status, 'match');
  assert.equal(match({ source: 'resumeDetailVo.jobWant.jobTitleNames', entries: [{ title: '工业/产品设计' }] },
    { title: '资深工业设计师' }).status, 'match');
});

test('职能映射扩展:跨族失配与边界项保持 unknown', () => {
  const match = (module as any).matchJobExpectations;
  assert.equal(match({ source: 'resumeDetailVo.jobWant.jobTitleNames', entries: [{ title: '跨境电商运营' }] },
    { title: '高级结构工程师' }).status, 'mismatch');
  assert.equal(match({ source: 'resumeDetailVo.jobWant.jobTitleNames', entries: [{ title: '机械工程师' }] },
    { title: '高级结构工程师' }).status, 'unknown');
  assert.equal(match({ source: 'resumeDetailVo.jobWant.jobTitleNames', entries: [{ title: '产品经理' }] },
    { title: '资深工业设计师' }).status, 'unknown');
});

test('简历权限不足不返回匹配', async () => {
  const { page } = fakePage({}, 403);
  await assert.rejects(module.resume(page, { talentId: 'mock' }), { name: 'AuthExpiredError' });
});
