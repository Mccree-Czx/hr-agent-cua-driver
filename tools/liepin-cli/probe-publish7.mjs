/**
 * 探测 7:构造「招聘主管」草稿 payload → save-ejob-draft 试提交(草稿不公开,安全)
 * 以资深亚马逊运营为骨架改写;用服务端反馈迭代字段
 * 用法:node probe-publish7.mjs
 * 输出:./publish-probe7-output.txt
 */
import { CdpBrowser } from './dist/browser/cdp_browser.js';
import { LIEPIN_LPT_API, lptFetch, navigateToLpt } from './dist/common/lpt-utils.js';
import fs from 'node:fs';

const OUT = `${process.cwd()}/publish-probe7-output.txt`;
const lines = [];
const log = (s) => {
  console.log(String(s).slice(0, 400));
  lines.push(String(s));
};

const JD_TEXT = `岗位职责：
1、根据公司及各部门用人需求，执行招聘计划，保障岗位及时到岗；
2、负责全流程招聘工作：岗位发布、筛选、邀约、背景调查、录用；
3、跟进招聘数据，定期输出招聘报表，分析到岗率等指标；
4、对接业务部门，清晰理解岗位需求，提升人岗匹配度与面试体验；
5、负责人才库搭建与维护，主动挖掘优质候选人，做好人才储备；
6、协助完成入离职手续、员工信息更新等基础人事工作。

任职要求：
1、本科及以上学历，5-10年招聘/人事相关工作经验，消费电子、制造业优先；
2、熟悉招聘全流程与各类招聘渠道，有独立完成岗位招聘交付的能力；
3、沟通表达流畅，逻辑清晰，抗压能力强，结果导向；
4、熟练使用 Excel 做数据统计，工作细致、责任心强；
5、积极主动，执行力强，具备良好的服务意识与跨部门协作能力。`;

const cdp = new CdpBrowser();
const page = await cdp.launch();
log(`# 探测7(草稿试提交)${new Date().toISOString()}`);

await navigateToLpt(page, '/job/manager', 2);
log('## 已在职位管理页');

// 1. 取基准 ejobForm
const base = await lptFetch(
  page,
  `${LIEPIN_LPT_API}/api/com.liepin.kuafu.ejobmanage.pc.ejobinfo.query.get-ejob-modify-info`,
  { body: 'ejobId=85027561&ejobActionType=edit' },
);
const form = base?.data?.ejobForm;
if (!form) {
  log('!! 取基准数据失败: ' + JSON.stringify(base).slice(0, 300));
  process.exit(1);
}

// 2. 构造「招聘主管」新职位草稿
const draft = { ...form };
delete draft.ejobId;              // 新职位:无 ejobId
delete draft.ejobStatus;          // 编辑态字段
delete draft.ejobBatchId;
delete draft.urlPc;
delete draft.urlH5;
delete draft.matchedNameList;
delete draft.matchedCodeList;
delete draft.operationStartTime;

draft.ejobTitle = '招聘主管';
draft.ejobJobtitle = 'N000330';   // 招聘经理/主管
draft.ejobJobtitleName = '招聘经理/主管';
draft.detailDutyQualify = JD_TEXT;
draft.jobSalaryLow = 12000;
draft.jobSalaryHigh = 18000;
draft.ejobSalaryMonth = 13;
draft.detailWorkyearlow = 5;
draft.detailWorkyearhigh = 10;
draft.detailDept = '';
delete draft.detailDeptId;
draft.ejobSalarydiscuss = '0';
draft.salary_discuss_payment_status = 0;

log('\n## 草稿 payload 字段数: ' + Object.keys(draft).length);

// 3. 提交草稿
const form3 = new URLSearchParams();
form3.set('ejobSaveInputVo', JSON.stringify(draft));
form3.set('saveInfoExtVo', JSON.stringify({ operationStartTime: '', ejobActionType: 'draft', couponId: '', msgId: '' }));

try {
  const res = await lptFetch(
    page,
    `${LIEPIN_LPT_API}/api/com.liepin.kuafu.ejobmanage.pc.ejobinfomaintain.save-ejob-draft`,
    { body: form3.toString() },
  );
  log('\n## ===== save-ejob-draft 响应 =====');
  log(JSON.stringify(res, null, 2).slice(0, 5000));
} catch (e) {
  log('\n!! save-ejob-draft 异常: ' + e.message);
}

fs.writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log(`\n>>> 输出: ${OUT}`);
cdp.disconnect();
