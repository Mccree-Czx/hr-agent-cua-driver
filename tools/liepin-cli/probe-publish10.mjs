/**
 * 探测 10:标准 payload(35字段精简集)→ 新职位草稿提交(招聘主管)
 */
import { CdpBrowser } from './dist/browser/cdp_browser.js';
import { LIEPIN_LPT_API, lptFetch, navigateToLpt } from './dist/common/lpt-utils.js';
import fs from 'node:fs';

const OUT = `${process.cwd()}/publish-probe10-output.txt`;
const lines = [];
const log = (s) => { console.log(String(s).slice(0, 350)); lines.push(String(s)); };

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
5、积极主动，执行力强，具备良好的服务意识与跨部门协作能力。

我们提供：
1、有竞争力的薪资 + 绩效奖金 + 年终奖金；
2、五险一金、带薪年假、节日福利、员工活动；
3、完善的培训体系与清晰的晋升通道（招聘主管 → HR 经理）；
4、稳定平台，团队氛围好，工作流程规范。`;

const cdp = new CdpBrowser();
const page = await cdp.launch();
await navigateToLpt(page, '/job/manager', 2);
log('## 管理页就绪');

// 标准 payload(新职位,无 ejobId)
const vo = {
  ejobType: '0',
  leaCreatetime: '',
  suggestAppear: false,
  suggestClick: false,
  detailIndustrys: '000',
  ejobTitle: '招聘主管',
  ejobJobtitle: 'N000330',
  detailDutyQualify: JD_TEXT,
  detailTags: '',
  jobSalaryLow: 12000,
  jobSalaryHigh: 18000,
  ejobSalaryMonth: 13,
  ejobSalarydiscuss: '0',
  detailDeptId: '',
  detailDept: '',
  detailWorkyearlow: 5,
  detailWorkyearhigh: 10,
  detailEdulevel: '040',
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
  ejobAddressVoList: [{
    ejobDq: '020010060',
    ejobDqName: '上海-虹口区',
    ejobAddress: '星荟中心2号办公楼',
    houseNum: '1505',
    ejobCoordinate: '121.486082,31.24584',
    subwayCodes: 'BV10039933,BV10039974,BV10039900',
    businessAreaCodes: '0200295',
  }],
  receiveEmailVoList: [],
  detailAbroadExp: [],
  detailRecruitCnt: 1,
  employmentType: '',
  recruitExpireDate: '1818691200000',
};

// 草稿提交
const body = new URLSearchParams();
body.set('ejobSaveInputVo', JSON.stringify(vo));
body.set('saveInfoExtVo', JSON.stringify({
  operationStartTime: '',
  ejobActionType: 'publishdraft',
  couponId: '',
  msgId: '',
}));

try {
  const res = await lptFetch(
    page,
    `${LIEPIN_LPT_API}/api/com.liepin.kuafu.ejobmanage.pc.ejobinfomaintain.save-ejob-draft`,
    { body: body.toString() },
  );
  log('\n## ===== 草稿提交响应 =====');
  log(JSON.stringify(res, null, 2).slice(0, 3000));
} catch (e) {
  log('\n!! 异常: ' + e.message);
}

fs.writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log('\n>>> 输出: ' + OUT);
cdp.disconnect();
