/**
 * 猎聘简历详情命令 - 招聘者端
 *
 * 走 LPT 接口 com.liepin.rresume.usere.pc.resume-view（抓包确认）：
 *   body: pageParamVo={"resIdEncode":"<简历ID>","sfrom":"R_SEARCH_CONDITION"}
 *   resp: data.resumeDetailVo { baseInfo, jobWant, eduExperiences[], workExperiences[], ... }
 * talentId 即 search 返回的 resume_id（resIdEncode）。
 */

import { Page } from 'puppeteer-core';
import { LIEPIN_LPT_API, lptFetch, navigateToLpt } from '../common/lpt-utils.js';

export interface ResumeOptions {
  talentId: string;
  targetTitle?: string;
}

export interface ExpectationEntry {
  title: string;
  // 仅供离线验证：人工核实并归一化的职能，不是猜测的平台字段或编码。
  reviewedFamily?: 'hardware' | 'hr' | 'software' | 'ecommerce-ops' | 'sales' | 'structure' | 'design';
  categorySource?: string;
}

export interface ExpectationEvidence {
  source: string;
  entries: ExpectationEntry[];
  malformed?: boolean;
  category_status?: 'unverified';
}

const EXPECTATION_SOURCE = 'resumeDetailVo.jobWant.jobTitleNames';
// 明确同义映射，不按“工程师”、行业或关键词包含关系泛化。
const KNOWN_FAMILIES = ['hardware', 'hr', 'software', 'ecommerce-ops', 'sales', 'structure', 'design'] as const;
const TITLE_FAMILIES = new Map<string, string>([
  ['硬件工程师', 'hardware'], ['硬件研发工程师', 'hardware'], ['高级硬件工程师', 'hardware'],
  ['高级硬件研发工程师', 'hardware'],
  ['人力资源总监', 'hr'], ['HR总监', 'hr'], ['招聘经理', 'hr'],
  ['软件工程师', 'software'],
  // 2026-09-28 晚职能映射扩展(与后端 JobMatchEvaluator 完全一致,解锁岗位 7-10)
  ['资深亚马逊运营', 'ecommerce-ops'], ['跨境电商运营', 'ecommerce-ops'], ['电商运营', 'ecommerce-ops'],
  ['运营经理/主管', 'ecommerce-ops'], ['运营专员', 'ecommerce-ops'], ['商家运营', 'ecommerce-ops'],
  ['品类运营', 'ecommerce-ops'], ['海外运营', 'ecommerce-ops'],
  ['海外ToB渠道销售（出海品牌）', 'sales'], ['渠道经理', 'sales'], ['海外销售', 'sales'],
  ['大客户销售', 'sales'], ['销售经理/主管', 'sales'], ['销售代表', 'sales'],
  ['外贸经理/主管', 'sales'], ['外贸专员/助理', 'sales'], ['区域销售经理/主管', 'sales'],
  ['销售总监', 'sales'], ['销售运营', 'sales'],
  ['高级结构工程师', 'structure'], ['机械结构工程师', 'structure'], ['家电/3C结构工程师', 'structure'],
  ['结构工程师', 'structure'],
  ['资深工业设计师', 'design'], ['工业/产品设计', 'design'], ['设计经理/主管', 'design'],
  ['设计总监', 'design'], ['汽车造型设计', 'design'], ['工业设计', 'design'], ['产品设计', 'design'],
]);

export function extractJobExpectations(vo: any): ExpectationEvidence {
  const titles = vo?.jobWant?.jobTitleNames;
  const validArray = Array.isArray(titles);
  return {
    source: EXPECTATION_SOURCE,
    entries: validArray ? titles.filter((title: unknown) => typeof title === 'string' && title.trim())
      .map((title: string) => ({ title })) : [],
    malformed: (titles != null && !validArray) || (validArray && titles.some((title: unknown) => typeof title !== 'string' || !title.trim())),
    category_status: 'unverified',
  };
}

/** 第一阶段验证工具：不接入评分/发送流程，匹配不等于可外发。 */
export function matchJobExpectations(evidence: ExpectationEvidence, target: ExpectationEntry) {
  const result = (status: 'match' | 'mismatch' | 'unknown', reason: string) => ({
    status, reason, can_continue_scoring: status === 'match', can_send: false,
    mapping_version: 'explicit-title-alias-v2',
  });
  if (evidence?.source !== EXPECTATION_SOURCE || evidence.malformed || !Array.isArray(evidence.entries) || !evidence.entries.length) {
    return result('unknown', '缺少可靠的求职期望或字段格式异常');
  }
  const classify = (entry: ExpectationEntry) => {
    const alias = TITLE_FAMILIES.get(typeof entry?.title === 'string' ? entry.title.trim() : '');
    const category = entry?.reviewedFamily;
    if (category && (!entry.categorySource?.trim() || !KNOWN_FAMILIES.includes(category))) {
      return { family: undefined, conflict: true };
    }
    return { family: category || alias, conflict: Boolean(category && alias && category !== alias) };
  };
  const wanted = classify(target);
  const entries = evidence.entries.map(classify);
  if (wanted.conflict || entries.some(entry => entry.conflict)) {
    return result('unknown', '职能分类证据缺失或与明确职位映射冲突');
  }
  if (!wanted.family) return result('unknown', '目标岗位职能尚无可靠映射');
  if (entries.some(entry => entry.family === wanted.family)) {
    return result('match', '至少一个明确期望方向同职能；级别、管理职责及岗位门槛仍需评分');
  }
  if (entries.some(entry => !entry.family)) return result('unknown', '存在无法确定职能的期望方向');
  return result('mismatch', '所有明确期望方向均与目标岗位不同职能');
}

function joinLines(items: any[], fmt: (it: any) => string): string {
  return (items || []).map(fmt).filter(Boolean).join('\n');
}

export async function resume(page: Page, options: ResumeOptions): Promise<any> {
  const { talentId } = options;

  if (!talentId) {
    throw new Error('简历 ID（resIdEncode）不能为空');
  }

  // 在 LPT 搜索页下发起请求（带正确 cookie / referer）
  const currentUrl = await page.evaluate(() => window.location.href);
  if (!String(currentUrl).includes('lpt.liepin.com')) {
    await navigateToLpt(page, '/search', 2);
  }

  const form = new URLSearchParams();
  form.set('pageParamVo', JSON.stringify({
    resIdEncode: talentId,
    sfrom: 'R_SEARCH_CONDITION',
  }));

  const data = await lptFetch(
    page,
    `${LIEPIN_LPT_API}/api/com.liepin.rresume.usere.pc.resume-view`,
    { body: form.toString() },
  );

  if (data.flag !== 1) {
    throw new Error(`获取简历失败: ${data.msg || data.message || JSON.stringify(data).slice(0, 200)}`);
  }

  const vo = data.data?.resumeDetailVo;
  if (!vo) {
    throw new Error('获取简历失败: 响应缺少 resumeDetailVo（可能简历 ID 无效或无查看权限）');
  }

  const base = vo.baseInfo || {};
  const want = vo.jobWant || {};
  const expectationEvidence = extractJobExpectations(vo);

  return {
    expectation_evidence: expectationEvidence,
    expectation_match: matchJobExpectations(expectationEvidence, { title: options.targetTitle || '' }),
    name: base.name || '',
    title: base.title || '',
    sex: base.sexName || '',
    age: base.age ? `${base.age}岁` : '',
    city: base.dqName || '',
    experience: base.workYearsDescr || '',
    education: vo.eduExperiences?.[0]?.degreeName || '',
    current_company: base.company || '',
    industry: base.industryName || '',
    work_status: base.workStatusName || '',
    online_status: vo.onlineDesc || '',
    want_salary: want.salaryShow || base.salaryShow || '',
    want_city: (want.dqNames || []).join('、'),
    want_title: expectationEvidence.entries.map(entry => entry.title).join('、'),
    want_industry: (want.industryNames || []).join('、'),
    self_descr: vo.selfDescr || '',
    skills: (vo.credentialNames || []).join('、'),
    languages: joinLines(vo.languages, (l: any) => l.nameShow || ''),
    work_history: joinLines(vo.workExperiences, (w: any) =>
      (`${w.timespan || ''} ${w.compName || ''} / ${w.jobTitleName || w.title || ''}`.trim()
        + (w.duty ? `\n${w.duty}` : ''))),
    education_history: joinLines(vo.eduExperiences, (e: any) =>
      `${e.eduTimeSpan || ''} ${e.school || ''} / ${e.special || ''} / ${e.degreeName || ''}`.trim()),
    resume_id: String(vo.resId || talentId),
    user_id: String(vo.encodeUsercId || ''),
  };
}

/** 简历命令定义 */
export const resumeCommand = {
  name: 'resume',
  description: '查看简历详情（招聘者端，传 search 返回的 resume_id）',
  args: [
    { name: 'talentId', type: 'string', required: true, positional: true, help: '简历 ID（resIdEncode，来自 search 结果）' },
    { name: 'targetTitle', type: 'string', default: '', help: '只读验证期望职能的目标职位名称，不触发评分或外发' },
  ],
  columns: [
    { header: '字段', key: 'field', width: 15 },
    { header: '内容', key: 'value', width: 80 },
  ],
  func: resume,
};
