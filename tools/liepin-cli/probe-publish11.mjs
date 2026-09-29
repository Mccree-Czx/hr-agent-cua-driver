/**
 * 探测 11:发布草稿「招聘主管」→ 验证正式上线
 */
import { CdpBrowser } from './dist/browser/cdp_browser.js';
import { LIEPIN_LPT_API, lptFetch, navigateToLpt } from './dist/common/lpt-utils.js';
import fs from 'node:fs';

const OUT = `${process.cwd()}/publish-probe11-output.txt`;
const lines = [];
const log = (s) => { console.log(String(s).slice(0, 350)); lines.push(String(s)); };

const cdp = new CdpBrowser();
const page = await cdp.launch();
await navigateToLpt(page, '/job/manager', 2);
log('## 管理页就绪');

// 发布草稿 85869361
try {
  const res = await lptFetch(
    page,
    `${LIEPIN_LPT_API}/api/com.liepin.job.b.ejoboperate.publish-draft-eJobs`,
    { body: 'ejobId=85869361' },
  );
  log('\n## ===== 发布草稿响应 =====');
  log(JSON.stringify(res, null, 2).slice(0, 1500));
} catch (e) {
  log('!! 发布异常: ' + e.message);
}

fs.writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log('\n>>> 输出: ' + OUT);
cdp.disconnect();
