/**
 * 探测 6:拉取"编辑职位"与"发布页"的真实数据模型(ejobSaveInputVo 字段结构)
 * 用法:node probe-publish6.mjs
 * 输出:./publish-probe6-output.txt
 */
import { CdpBrowser } from './dist/browser/cdp_browser.js';
import { LIEPIN_LPT_API, lptFetch, navigateToLpt } from './dist/common/lpt-utils.js';
import fs from 'node:fs';

const OUT = `${process.cwd()}/publish-probe6-output.txt`;
const lines = [];
const log = (s) => {
  console.log(String(s).slice(0, 300));
  lines.push(String(s));
};

const cdp = new CdpBrowser();
const page = await cdp.launch();
log(`# 探测6 ${new Date().toISOString()}`);

await navigateToLpt(page, '/job/manager', 2);
log('## 已在职位管理页');

// 1. 编辑职位数据模型
try {
  const editData = await lptFetch(
    page,
    `${LIEPIN_LPT_API}/api/com.liepin.kuafu.ejobmanage.pc.ejobinfo.query.get-ejob-modify-info`,
    { body: 'ejobId=85027561&ejobActionType=edit' },
  );
  log('\n## ===== get-ejob-modify-info 响应 =====');
  log(JSON.stringify(editData, null, 2).slice(0, 12000));
} catch (e) {
  log('get-ejob-modify-info 失败: ' + e.message);
}

// 2. 发布页数据模型(新职位默认数据)
try {
  const publishData = await lptFetch(
    page,
    `${LIEPIN_LPT_API}/api/com.liepin.kuafu.ejobmanage.pc.ejobinfo.query.get-ejob-publish-info`,
    { body: 'ejobActionType=publish' },
  );
  log('\n## ===== get-ejob-publish-info 响应 =====');
  log(JSON.stringify(publishData, null, 2).slice(0, 12000));
} catch (e) {
  log('get-ejob-publish-info 失败: ' + e.message);
}

// 3. 职位类别搜索接口(为类别匹配准备)
try {
  const jobtitle = await lptFetch(
    page,
    `${LIEPIN_LPT_API}/api/com.liepin.kuafu.ejobmanage.pc.check-jobtitle`,
    { body: 'jobTitle=%E6%8B%9B%E8%81%98%E4%B8%BB%E7%AE%A1' },
  );
  log('\n## ===== check-jobtitle(招聘主管)响应 =====');
  log(JSON.stringify(jobtitle, null, 2).slice(0, 3000));
} catch (e) {
  log('check-jobtitle 失败: ' + e.message);
}

fs.writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log(`\n>>> 输出: ${OUT}`);
cdp.disconnect();
