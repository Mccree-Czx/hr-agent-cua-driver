/**
 * 探测 8g:页面存活状态下 dump 编辑页实际内容
 */
import { CdpBrowser } from './dist/browser/cdp_browser.js';
import fs from 'node:fs';

const OUT = `${process.cwd()}/publish-probe8g-output.txt`;
const lines = [];
const log = (s) => { console.log(String(s).slice(0, 300)); lines.push(String(s)); };

const cdp = new CdpBrowser();
const page = await cdp.launch();
const browser = cdp.getBrowser();

const tabs = await browser.pages();
log('## 现有标签页: ' + tabs.length);
tabs.forEach((t, i) => log(`  tab${i}: ${t.url().slice(0, 60)}`));

// 复用已有 edit tab 或者新开
let fresh = tabs.find((t) => t.url().includes('job/publish'));
if (!fresh) {
  fresh = await browser.newPage();
  await fresh.goto('https://lpt.liepin.com/job/publish?ejobId=85027561&ejobActionType=edit', { waitUntil: 'domcontentloaded', timeout: 30000 });
}
log('## 使用标签页: ' + fresh.url().slice(0, 80));

// 等 12 秒让 React 渲染
await new Promise((r) => setTimeout(r, 12000));

const info = await fresh.evaluate(() => {
  return {
    title: document.title,
    url: location.href,
    bodyText: document.body ? document.body.innerText.slice(0, 900) : '(无body)',
    inputs: document.querySelectorAll('input,textarea').length,
    buttons: Array.from(document.querySelectorAll('button')).map((b) => (b.textContent || '').trim()).filter(Boolean).slice(0, 25),
    iframes: Array.from(document.querySelectorAll('iframe')).map((f) => f.src.slice(0, 80)),
    reactRootChildren: document.querySelector('#root')?.children?.length ?? -1,
    htmlLen: document.documentElement.outerHTML.length,
  };
});
log('\n## title: ' + info.title);
log('## url: ' + info.url);
log('## htmlLen: ' + info.htmlLen + ', reactRootChildren: ' + info.reactRootChildren);
log('## inputs: ' + info.inputs);
log('## buttons: ' + JSON.stringify(info.buttons));
log('## iframes: ' + JSON.stringify(info.iframes));
log('\n## body 文本:\n' + info.bodyText);

fs.writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log('\n>>> 输出: ' + OUT);
cdp.disconnect();
