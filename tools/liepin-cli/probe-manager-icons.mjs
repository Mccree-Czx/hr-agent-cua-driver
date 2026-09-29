/**
 * 探测:职位管理页的操作图标(编辑/刷新等)坐标与属性
 */
import { CdpBrowser } from './dist/browser/cdp_browser.js';
import { setPageRuntime } from './dist/common/lpt-utils.js';
import fs from 'node:fs';

const OUT = `${process.cwd()}/probe-manager-icons.txt`;
const lines = [];
const log = (s) => { console.log(String(s).slice(0, 300)); lines.push(String(s)); };

const cdp = new CdpBrowser();
const page = await cdp.launch();
const browser = cdp.getBrowser();
const fresh = await browser.newPage();

await setPageRuntime(fresh, false);
await fresh.goto('https://lpt.liepin.com/job/manager', { waitUntil: 'networkidle2', timeout: 40000 });
await setPageRuntime(fresh, true);
await new Promise((r) => setTimeout(r, 6000));

log('## URL: ' + fresh.url());

const icons = await fresh.evaluate(() => {
  const out = [];
  // 所有可能是操作图标的元素:svg use、antlpticon、position 靠右的小按钮
  document.querySelectorAll('svg, i, span, a, div[class*="icon"], div[class*="Icon"], div[class*="operate"], div[class*="action"]').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || r.width > 60) return;
    const cls = (el.className || '').toString();
    const title = el.getAttribute('title') || el.getAttribute('aria-label') || '';
    // 只收上方职位卡片区的(前 700px 高度)
    if (r.top < 700 && r.left > 600) {
      out.push({ tag: el.tagName, cls: cls.slice(0, 70), title, x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), w: Math.round(r.width) });
    }
  });
  return out.slice(0, 40);
});
log('## 右上区域图标:');
icons.forEach((i) => log(`  ${i.tag} cls=${i.cls} title=${i.title} @(${i.x},${i.y}) w=${i.w}`));

// 也 dump 第一个职位卡片完整 HTML 结构(找编辑按钮容器)
const cardHtml = await fresh.evaluate(() => {
  const card = document.querySelector('[class*="jobCard"], [class*="job-card"], [class*="ejobCard"], [class*="card"]');
  return card ? card.outerHTML.slice(0, 6000) : '(未找到卡片)';
});
log('\n## 第一个卡片 HTML:\n' + cardHtml);

fs.writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log('\n>>> 输出: ' + OUT);
cdp.disconnect();
