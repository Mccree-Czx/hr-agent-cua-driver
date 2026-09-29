/**
 * 探测 8f:对照实验 —— CDP 原生 Runtime.evaluate vs puppeteer page.evaluate 谁触发自爆
 */
import { CdpBrowser } from './dist/browser/cdp_browser.js';
import { setPageRuntime } from './dist/common/lpt-utils.js';
import fs from 'node:fs';

const OUT = `${process.cwd()}/publish-probe8f-output.txt`;
const lines = [];
const log = (s) => { console.log(String(s).slice(0, 250)); lines.push(String(s)); };

const cdp = new CdpBrowser();
const page = await cdp.launch();
const browser = cdp.getBrowser();
const fresh = await browser.newPage();

const EDIT_URL = 'https://lpt.liepin.com/job/publish?ejobId=85027561&ejobActionType=edit';

// 拿主会话(CLI 内部用的方式)
const client = fresh.mainFrame().client;

await setPageRuntime(fresh, false);
await fresh.goto(EDIT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
await new Promise((r) => setTimeout(r, 5000));
log('## 阶段1(仅导航,runtime off, 5s): ' + fresh.url().slice(0, 80));

// 阶段2:CDP 原生 Runtime.evaluate
await setPageRuntime(fresh, true);
await new Promise((r) => setTimeout(r, 1500));
const r1 = await client.send('Runtime.evaluate', { expression: 'document.querySelectorAll("input").length', returnByValue: true });
log('## 阶段2 CDP原生evaluate 结果: ' + JSON.stringify(r1.result?.value).slice(0, 60));
await new Promise((r) => setTimeout(r, 5000));
log('  [5s后] ' + fresh.url().slice(0, 80));

// 阶段3:puppeteer page.evaluate
try {
  const n = await fresh.evaluate(() => document.querySelectorAll('button').length);
  log('## 阶段3 puppeteer evaluate 结果: ' + n);
} catch (e) {
  log('## 阶段3 evaluate 异常: ' + e.message.slice(0, 100));
}
await new Promise((r) => setTimeout(r, 5000));
log('  [5s后] ' + fresh.url().slice(0, 80));

// 阶段4:再试一次 CDP 原生(若还活着)
try {
  const r3 = await client.send('Runtime.evaluate', { expression: '1+1', returnByValue: true });
  log('## 阶段4 CDP原生evaluate 结果: ' + r3.result?.value);
} catch (e) {
  log('## 阶段4 异常: ' + e.message.slice(0, 100));
}
await new Promise((r) => setTimeout(r, 5000));
log('  [5s后] ' + fresh.url().slice(0, 80));

await fresh.close().catch(() => {});
fs.writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log('\n>>> 输出: ' + OUT);
cdp.disconnect();
