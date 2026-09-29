/**
 * 探测 9:payload 格式验证
 * A. update-ejob 原值回写(ejobActionType=update)——验证 ejobForm 结构即保存格式
 * B. save-ejob-draft 全字段草稿(去掉 ejobId 等编辑态字段)
 * 用法:node probe-publish9.mjs
 * 输出:./publish-probe9-output.txt
 */
import { CdpBrowser } from './dist/browser/cdp_browser.js';
import { LIEPIN_LPT_API, lptFetch, navigateToLpt } from './dist/common/lpt-utils.js';
import fs from 'node:fs';

const OUT = `${process.cwd()}/publish-probe9-output.txt`;
const lines = [];
const log = (s) => {
  console.log(String(s).slice(0, 350));
  lines.push(String(s));
};

const cdp = new CdpBrowser();
const page = await cdp.launch();
log(`# 探测9(payload 格式验证)${new Date().toISOString()}`);

await navigateToLpt(page, '/job/manager', 2);

// 取基准 ejobForm
const base = await lptFetch(
  page,
  `${LIEPIN_LPT_API}/api/com.liepin.kuafu.ejobmanage.pc.ejobinfo.query.get-ejob-modify-info`,
  { body: 'ejobId=85027561&ejobActionType=edit' },
);
const form = base?.data?.ejobForm;
if (!form) {
  log('!! 取基准失败');
  process.exit(1);
}
log(`## 基准 ejobForm 字段数: ${Object.keys(form).length}`);

// ===== A. update-ejob 原值回写 =====
const voA = { ...form };
const extA = JSON.stringify({
  operationStartTime: form.operationStartTime || '',
  ejobActionType: 'update',
  couponId: '',
  msgId: '',
});
const bodyA = new URLSearchParams();
bodyA.set('ejobSaveInputVo', JSON.stringify(voA));
bodyA.set('saveInfoExtVo', extA);

try {
  const resA = await lptFetch(
    page,
    `${LIEPIN_LPT_API}/api/com.liepin.kuafu.ejobmanage.pc.ejobinfomaintain.update-ejob`,
    { body: bodyA.toString() },
  );
  log('\n## ===== A. update-ejob 原值回写响应 =====');
  log(JSON.stringify(resA).slice(0, 1500));
} catch (e) {
  log('\n!! A 异常: ' + e.message);
}

await new Promise((r) => setTimeout(r, 2000));

// ===== B. save-ejob-draft 全字段草稿(去编辑态标识)=====
const voB = { ...form };
voB.ejobId = undefined;
voB.ejobStatus = undefined;
voB.ejobBatchId = undefined;
voB.urlPc = undefined;
voB.urlH5 = undefined;
voB.ejobAuditflag = undefined;
Object.keys(voB).forEach((k) => voB[k] === undefined && delete voB[k]);
// 草稿也改个标题以示区分?不改,先直接存
const bodyB = new URLSearchParams();
bodyB.set('ejobSaveInputVo', JSON.stringify(voB));
bodyB.set('saveInfoExtVo', JSON.stringify({
  operationStartTime: '',
  ejobActionType: 'publishdraft',
  couponId: '',
  msgId: '',
}));

try {
  const resB = await lptFetch(
    page,
    `${LIEPIN_LPT_API}/api/com.liepin.kuafu.ejobmanage.pc.ejobinfomaintain.save-ejob-draft`,
    { body: bodyB.toString() },
  );
  log('\n## ===== B. save-ejob-draft(全字段)响应 =====');
  log(JSON.stringify(resB).slice(0, 1500));
} catch (e) {
  log('\n!! B 异常: ' + e.message);
}

fs.writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log(`\n>>> 输出: ${OUT}`);
cdp.disconnect();
