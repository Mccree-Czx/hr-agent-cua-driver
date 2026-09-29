/**
 * 猎聘发布职位命令 - 招聘者端
 *
 * 真机验证路径(2026-09-25 实测成功,草稿→发布两步):
 *   1) POST .../ejobinfo.query.get-ejob-modify-info   读参考职位(取公司地址等默认值)
 *   2) POST .../ejobinfomaintain.save-ejob-draft      草稿提交(ejobActionType=publishdraft)→ 返回新 ejobId
 *   3) POST .../ejoboperate.publish-draft-eJobs       发布草稿(ejobId)→ 正式上线,返回正式 jobId
 *
 * 写模型(ejobSaveInputVo)为 35 字段精简集,与读模型(ejobForm)不同,关键差异:
 *   - 行业:detailIndustrys("000"=全部行业)
 *   - 地址:ejobAddressVoList 数组(ejobDq/ejobDqName/ejobAddress/houseNum/ejobCoordinate/subwayCodes/businessAreaCodes)
 *   - 招聘人数:detailRecruitCnt
 *   - 截止日期:recruitExpireDate(毫秒时间戳字符串)
 * 学历编码示例:040=本科。
 */

import { Page } from 'puppeteer-core';
import { LIEPIN_LPT_API, lptFetch, navigateToLpt } from '../common/lpt-utils.js';

export interface JobpublishOptions {
  /** 职位数据 JSON 字符串:'{"title":"招聘主管","jobCategory":"N000330","description":"...","salaryMinK":12,"salaryMaxK":18,"salaryMonths":13,"workyearLow":5,"workyearHigh":10,"degree":"040"}' */
  data: string;
  /** 参考职位 ejobId(取其公司地址等默认值;缺省自动取职位列表第一个) */
  job?: string;
  /** 只存草稿不发布 */
  draftOnly?: boolean;
}

interface PublishInput {
  title: string;
  jobCategory: string;
  description: string;
  salaryMinK?: number;
  salaryMaxK?: number;
  salaryMonths?: number;
  workyearLow?: number;
  workyearHigh?: number;
  degree?: string;
  recruitCount?: number;
}

function parseData(raw: string): PublishInput {
  if (!raw) {
    throw new Error('缺少 --data(职位数据 JSON)');
  }
  let p: PublishInput;
  try {
    p = JSON.parse(raw);
  } catch {
    throw new Error('--data 不是合法 JSON');
  }
  if (!p.title || !p.jobCategory || !p.description) {
    throw new Error('data 缺少必填字段: title / jobCategory / description');
  }
  return p;
}

async function pickReferenceJob(page: Page, jobId?: string): Promise<string> {
  if (jobId) return jobId;
  const form = new URLSearchParams();
  form.set(
    'requestVo',
    JSON.stringify({ keywordKind: '0', keyword: '', curPage: 0, pageSize: 10, jobListType: '0', shareFlag: '2' }),
  );
  const data = await lptFetch(page, `${LIEPIN_LPT_API}/api/com.liepin.recruitbff.lpt.jobmanage.list`, {
    body: form.toString(),
  });
  const jobs = data?.data?.ejobList || data?.data?.list || [];
  const first = jobs[0];
  const id = first?.ejobId || first?.jobId;
  if (!id) {
    throw new Error('没有可用参考职位(用于获取公司地址),请先在猎聘发布一个职位或传 --job');
  }
  return String(id);
}

export async function jobpublish(page: Page, options: JobpublishOptions): Promise<any> {
  const input = parseData(options.data);

  await navigateToLpt(page, '/job/manager', 2);

  // 1. 参考职位 → 公司地址
  const refJobId = await pickReferenceJob(page, options.job);
  const modify = await lptFetch(
    page,
    `${LIEPIN_LPT_API}/api/com.liepin.kuafu.ejobmanage.pc.ejobinfo.query.get-ejob-modify-info`,
    { body: `ejobId=${refJobId}&ejobActionType=edit` },
  );
  const form = modify?.data?.ejobForm;
  if (!form) {
    throw new Error(`读取参考职位 ${refJobId} 失败: ${JSON.stringify(modify).slice(0, 200)}`);
  }
  const addressVo = {
    ejobDq: form.ejobDq || '',
    ejobDqName: form.ejobDqName || '',
    ejobAddress: form.ejobAddress || '',
    houseNum: form.houseNum || '',
    ejobCoordinate: form.ejobCoordinate || '',
    subwayCodes: form.subwayCodes || '',
    businessAreaCodes: form.businessAreaCodes || '',
  };
  if (!addressVo.ejobDq || !addressVo.ejobCoordinate) {
    throw new Error('参考职位缺少有效地址信息,无法复用公司地址');
  }

  // 2. 构造写模型 payload(35 字段精简集)
  const vo = {
    ejobType: '0',
    leaCreatetime: '',
    suggestAppear: false,
    suggestClick: false,
    detailIndustrys: '000',
    ejobTitle: input.title,
    ejobJobtitle: input.jobCategory,
    detailDutyQualify: input.description,
    detailTags: '',
    jobSalaryLow: (input.salaryMinK ?? 0) * 1000,
    jobSalaryHigh: (input.salaryMaxK ?? 0) * 1000,
    ejobSalaryMonth: input.salaryMonths ?? 13,
    ejobSalarydiscuss: '0',
    detailDeptId: '',
    detailDept: '',
    detailWorkyearlow: input.workyearLow ?? 0,
    detailWorkyearhigh: input.workyearHigh ?? 99,
    detailEdulevel: input.degree || '040',
    detailEdulevelTz: '0',
    detailLanguage: '1',
    detailLanguageOther: 0,
    ejobFilterapplyflag: '0',
    shareUsereIds: '',
    ejobPrivacyreq: '0',
    ejobAgreementFlag: '1',
    ejobStudentApplyFlag: '2',
    letName: '',
    letId: '',
    ejobAddressVoList: [addressVo],
    receiveEmailVoList: [],
    detailAbroadExp: [],
    detailRecruitCnt: input.recruitCount || 1,
    employmentType: '',
    recruitExpireDate: String(Date.now() + 365 * 24 * 3600 * 1000),
  };

  // 3. 草稿提交
  const draftBody = new URLSearchParams();
  draftBody.set('ejobSaveInputVo', JSON.stringify(vo));
  draftBody.set(
    'saveInfoExtVo',
    JSON.stringify({ operationStartTime: '', ejobActionType: 'publishdraft', couponId: '', msgId: '' }),
  );
  const draftRes = await lptFetch(
    page,
    `${LIEPIN_LPT_API}/api/com.liepin.kuafu.ejobmanage.pc.ejobinfomaintain.save-ejob-draft`,
    { body: draftBody.toString() },
  );
  if (draftRes.flag !== 1) {
    throw new Error('草稿保存失败: ' + (draftRes.msg || JSON.stringify(draftRes).slice(0, 200)));
  }
  const draftId = draftRes.data;

  if (options.draftOnly) {
    return { success: true, draft_id: String(draftId), title: input.title, message: '草稿已保存(未发布)' };
  }

  // 4. 发布草稿
  const pubRes = await lptFetch(
    page,
    `${LIEPIN_LPT_API}/api/com.liepin.job.b.ejoboperate.publish-draft-eJobs`,
    { body: `ejobId=${draftId}` },
  );
  if (pubRes.flag !== 1) {
    throw new Error(
      `发布失败(草稿 ${draftId} 已保留): ` + (pubRes.msg || JSON.stringify(pubRes).slice(0, 200)),
    );
  }
  const jobId = pubRes.data?.ejobIdList?.[0] || draftId;
  return {
    success: true,
    job_id: String(jobId),
    draft_id: String(draftId),
    title: input.title,
    message: '职位已发布',
  };
}

/** 发布职位命令定义 */
export const jobpublishCommand = {
  name: 'jobpublish',
  description: '发布职位到猎聘(草稿→正式上线;地址复用参考职位)',
  args: [
    { name: 'data', type: 'string', default: '', help: '职位数据 JSON(必填),如 \'{"title":"招聘主管","jobCategory":"N000330","description":"...","salaryMinK":12,"salaryMaxK":18,"salaryMonths":13,"workyearLow":5,"workyearHigh":10,"degree":"040"}\'' },
    { name: 'job', type: 'string', default: '', help: '参考职位 ejobId(取公司地址;缺省自动取职位列表第一个)' },
    { name: 'draft-only', type: 'boolean', default: false, help: '只存草稿不发布' },
  ],
  columns: [
    { header: '结果', key: 'message', width: 30 },
    { header: '职位ID', key: 'job_id', width: 15 },
  ],
  func: jobpublish,
};
