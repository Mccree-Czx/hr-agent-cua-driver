import { CdpBrowser } from './dist/browser/cdp_browser.js';
const cdp = new CdpBrowser();
const page = await cdp.launch();
for (const url of ['https://www.baidu.com', 'https://www.liepin.com', 'https://lpt.liepin.com']) {
  try {
    const resp = await page.goto(url, { timeout: 15000, waitUntil: 'domcontentloaded' });
    console.log(url, '->', resp?.status(), page.url().slice(0, 60));
  } catch (e) {
    console.log(url, '-> FAIL:', e.message.slice(0, 80));
  }
}
cdp.disconnect();
