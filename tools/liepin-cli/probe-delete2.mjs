import { CdpBrowser } from './dist/browser/cdp_browser.js';
import { LIEPIN_LPT_API, lptFetch, navigateToLpt } from './dist/common/lpt-utils.js';
const cdp = new CdpBrowser();
const page = await cdp.launch();
await navigateToLpt(page, '/job/manager', 2);
// 测 end + delete 对不存在职位的反应
const body = `ejobIdList=${encodeURIComponent(JSON.stringify(['85869415']))}`;
const end = await lptFetch(page, `${LIEPIN_LPT_API}/api/com.liepin.kuafu.ejobmanage.pc.ejobinfomaintain.end-ejobs`, { body });
console.log('end-ejobs:', JSON.stringify(end));
const del = await lptFetch(page, `${LIEPIN_LPT_API}/api/com.liepin.kuafu.ejobmanage.pc.ejobinfomaintain.delete-ejobs`, { body });
console.log('delete-ejobs:', JSON.stringify(del));
cdp.disconnect();
