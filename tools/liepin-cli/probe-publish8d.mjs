/**
 * 探测 8d:全事件诊断 —— 编辑页被清空的机制(framenavigated/console/pageerror)
 */
import { CdpBrowser } from './dist/browser/cdp_browser.js';
import fs from 'node:fs';

const OUT = `${process.cwd()}/publish-probe8d-output.txt`;
const lines = [];
const log = (s) => { console.log(String(s).slice(0, 300)); lines.push(String(s)); };

const cdp = new CdpBrowser();
const page = await cdp.launch();
const browser = cdp.getBrowser();

page.on('framenavigated', (frame) => {
  if (frame === page.mainFrame()) log(`[NAV] -> ${frame.url().slice(0, 120)}`);
});
page.on('console', (msg) => {
  const t = msg.text();
  if (/error|blank|安全|验证|auto|bot|webdriver|cdp/i.test(t)) log(`[CONSOLE:${msg.type()}] ${t.slice(0, 200)}`);
});
page.on('pageerror', (err) => log(`[PAGEERROR] ${String(err).slice(0, 300)}`));

// CLI 的浏览器上常驻的 tab 数
const tabs = await browser.pages();
log(`## 当前标签页数: ${tabs.length}`);
tabs.forEach((t, i) => log(`  tab${i}: ${t.url().slice(0, 80)}`));

// 用全新 tab 导航(排除旧 tab 状态干扰)
const fresh = await browser.newPage();
fresh.on('framenavigated', (frame) => {
  if (frame === fresh.mainFrame()) log(`[NAV:new] -> ${frame.url().slice(0, 120)}`);
});

log('\n## 用全新标签页导航到编辑页...');
try {
  await fresh.goto('https://lpt.liepin.com/job/publish?ejobId=85027561&ejobActionType=edit', { waitUntil: 'domcontentloaded', timeout: 30000 });
  log('## goto 返回: ' + fresh.url());
} catch (e) {
  log('## goto 异常: ' + e.message.slice(0, 120));
}

for (let i = 0; i < 10; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const st = await fresh.evaluate(() => ({
    url: location.href,
    htmlLen: document.documentElement.outerHTML.length,
    bodyLen: document.body ? document.body.innerText.length : -1,
  })).catch((e) => ({ url: 'eval失败:' + e.message.slice(0, 50), htmlLen: -1, bodyLen: -1 }));
  log(`  [${(i + 1) * 2}s] url=${st.url.slice(0, 70)} htmlLen=${st.htmlLen} bodyLen=${st.bodyLen}`);
}
await fresh.close();

fs.writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log('\n>>> 输出: ' + OUT);
cdp.disconnect();
