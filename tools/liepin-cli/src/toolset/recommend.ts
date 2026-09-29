/**
 * 猎聘推荐候选人命令
 */

import { Page } from 'puppeteer-core';
import { RECOMMEND_COLUMNS } from '../common/utils.js';
import { LIEPIN_LPT_API, lptFetch, navigateToLpt } from '../common/lpt-utils.js';

export interface RecommendOptions {
  jobTitle?: string;
  jobId?: string;
  page?: number;
  limit?: number;
}

function buildRecommendBody(ejobId: number | string, limit: number, operateKind: string = 'LOGIN'): string {
  const form = new URLSearchParams();
  form.set('lpRecommendQueryInputVo', JSON.stringify({
    pageSize: Math.min(Number(limit) || 20, 40),
    ejobId: Number(ejobId),
    siftConditionVo: {
      requireWorkYear: ['0'],
      requireDegree: ['000'],
      minSalary: 0,
      maxSalary: 0,
      schoolTag: ['0'],
      pcMinAge: '',
      pcMaxAge: '',
      graduateCodes: [],
      seekWill: ['000'],
      studentUsercHopeKinds: [],
      sex: '000',
      industries: ['000'],
      jobFrequency: '000',
    },
    queryKind: '5',
    operateKind,
  }));
  return form.toString();
}

function mapRecommendCandidate(item: any) {
  const resume = item.resume || {};
  const latestWork = resume.workExpList?.[0] || {};
  const want = resume.jobWant || {};

  return {
    name: resume.showName || '',
    title: want.wantTitle || latestWork.rwdsTitle || '',
    company: latestWork.rwdCompname || '',
    salary: want.wantSalary || '',
    experience: resume.workYearsShow || '',
    education: resume.eduLevelShow || '',
    city: want.wantDqName || resume.cityName || '',
    active_status: resume.activeStatus || '',
    talentId: resume.enresId || '',
    user_id: resume.enusercId || '',
    im_id: resume.imId || '',
    url: resume.url || '',
    job_id: String(item.job?.jobId || ''),
    job_title: item.job?.jobTitle || '',
  };
}

export async function recommend(page: Page, options: RecommendOptions): Promise<any[]> {
  const { jobId = '', limit = 20, page: pageNum = 1 } = options;
  if (!/^[1-9]\d*$/.test(jobId) || !Number.isSafeInteger(Number(jobId))) {
    throw new Error('必须显式提供有效的猎聘岗位 jobId，禁止使用默认职位');
  }
  if (Number(pageNum) !== 1) {
    throw new Error('推荐分页契约未验证，目前仅支持首批结果，不支持翻页');
  }
  if (options.jobTitle) {
    throw new Error('jobTitle 过滤尚未实现，请仅使用明确的 jobId');
  }
  if (!Number.isInteger(Number(limit)) || Number(limit) < 1 || Number(limit) > 40) {
    throw new Error('limit 必须为 1-40 的整数');
  }

  // 导航到推荐页面
  await navigateToLpt(page, '/recommend', 2);

  const initBody = new URLSearchParams({
    ejobId: jobId,
  });
  const init = await lptFetch(page, `${LIEPIN_LPT_API}/api/com.liepin.recruitbff.lpt.recommend.init`, {
    body: initBody.toString(),
  });

  if (init.flag !== 1) {
    throw new Error('获取推荐初始化失败，无法确认目标岗位');
  }

  const ejobId = jobId;
  if (String(init.data?.ejobId ?? '') !== jobId) {
    throw new Error('推荐初始化未确认目标岗位，职位不可用或关联未知；禁止回退默认职位');
  }

  const response = await lptFetch(
    page,
    `${LIEPIN_LPT_API}/api/com.liepin.recruitbff.lpt.recommend.get-recommend-resumes`,
    { body: buildRecommendBody(ejobId, limit) },
  );

  // 处理响应
  if (response.flag !== 1 || !Array.isArray(response.data?.list)) {
    throw new Error('获取推荐候选人失败：' + (response?.message || response?.msg || '未知错误'));
  }

  // 映射结果
  return response.data.list.slice(0, Number(limit)).map((item: any) => {
    const mapped = mapRecommendCandidate(item);
    if (mapped.job_id && mapped.job_id !== jobId) {
      throw new Error('推荐结果岗位与请求岗位冲突，拒绝该批结果');
    }
    return {
      ...mapped,
      requested_job_id: jobId,
      job_association: mapped.job_id ? 'matched' : 'unknown',
      pagination_status: 'unverified',
    };
  });
}

/** 推荐候选人命令定义 */
export const recommendCommand = {
  name: 'recommend',
  description: '查看推荐候选人',
  args: [
    { name: 'jobTitle', type: 'string', default: '', help: '不支持按名称筛选，非空值会报错' },
    { name: 'jobId', type: 'string', required: true, positional: true, help: '必填猎聘职位 ID，可使用 --jobId；不回退默认岗位' },
    { name: 'page', type: 'int', default: 1, help: '仅支持 1；平台分页契约未验证' },
    { name: 'limit', type: 'int', default: 20, help: '返回条数（1-40）' },
  ],
  columns: RECOMMEND_COLUMNS,
  func: recommend,
};
