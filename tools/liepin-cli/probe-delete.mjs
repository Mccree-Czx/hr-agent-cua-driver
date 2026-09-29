/**
 * 验证删除流程:end-ejobs(结束) → delete-ejobs(删除)
 */
import { CdpBrowser } from './dist/browser/cdp_browser.js';
import { LIEPIN_LPT_API, lptFetch, navigateToLpt } from './dist/common/lpt-utils.js';

const JOB_ID = process.argv[2] || '85869399';

const cdp = new CdpBrowser();
const page = await cdp.launch();
await navigateToLpt(page, '/job/manager', 2);
console.log('## 管理页就绪');

// 1. 结束发布
const endRes = await lptFetch(
  page,
  `${LIEPIN_LPT_API}/api/com.liepin.kuafu.ejobmanage.pc.ejobinfomaintain.end-ejobs`,
  { body: `ejobIdList=${encodeURIComponent(JSON.stringify([JOB_ID]))}` },
);
console.log('## end-ejobs 响应:', JSON.stringify(endRes));

await new Promise((r) => setTimeout(r, 3000));

// 2. 删除
const delRes = await lptFetch(
  page,
  `${LIEPIN_LPT_API}/api/com.liepin.kuafu.ejobmanage.pc.ejobinfomaintain.delete-ejobs`,
  { body: `ejobIdList=${encodeURIComponent(JSON.stringify([JOB_ID]))}` },
);
console.log('## delete-ejobs 响应:', JSON.stringify(delRes));

cdp.disconnect();
