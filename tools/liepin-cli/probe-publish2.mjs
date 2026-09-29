/**
 * 探测 2:抓页面 JS bundle 清单 + 关键接口响应体(职位类别树),并从 bundle 里 grep 职位保存/发布 API
 * 用法:node probe-publish2.mjs
 * 输出:./publish-probe2-output.txt + ./bundle-downloads/
 */
import { CdpBrowser } from './dist/browser/cdp_browser.js';
import fs from 'node:fs';

const OUT = `${process.cwd()}/publish-probe2-output.txt`;
const BUNDLE_DIR = `${process.cwd()}/bundle-downloads`;
fs.mkdirSync(BUNDLE_DIR, { recursive: true });

const lines = [];
const log = (s) => {
  console.log(s.slice(0, 200));
  lines.push(s);
};

const cdp = new CdpBrowser();
const page = await cdp.launch();
log(`# 发布页探测2 ${new Date().toISOString()}`);

const scriptUrls = new Set();
const apiResponses = {};

page.on('response', async (res) => {
  const url = res.url();
  if (url.endsWith('.js') && url.includes('liepin')) {
    scriptUrls.add(url);
  }
  // 抓关键接口响应体
  if (
    url.includes('get-all-jobtitle') ||
    url.includes('get-all-industry') ||
    url.includes('jobconfig') ||
    url.includes('job-memory')
  ) {
    try {
      const text = await res.text();
      apiResponses[url] = text.slice(0, 6000);
    } catch {
      /* ignore */
    }
  }
});

await cdp.navigate('https://lpt.liepin.com/job/publish?ejobActionType=publish');
await new Promise((r) => setTimeout(r, 6000));

log(`## URL: ${page.url()}`);
log(`\n## JS bundle 数量: ${scriptUrls.size}`);
for (const u of scriptUrls) log(`  ${u}`);

log('\n## 关键接口响应:');
for (const [u, t] of Object.entries(apiResponses)) {
  log(`\n### ${u}\n${t}`);
}

// 下载发布相关的 JS bundle,本地 grep API 名
const targetBundles = Array.from(scriptUrls).filter(
  (u) => u.includes('job') || u.includes('publish') || u.includes('main') || u.includes('index'),
);
log(`\n## 下载候选 bundle ${targetBundles.length} 个...`);
let i = 0;
for (const u of targetBundles.slice(0, 15)) {
  i++;
  try {
    const text = await page.evaluate(async (url) => {
      const r = await fetch(url);
      return r.text();
    }, u);
    const name = `${BUNDLE_DIR}/bundle-${i}-${u.split('/').pop().split('?')[0]}`;
    fs.writeFileSync(name, text, 'utf8');
    log(`  保存 ${name} (${text.length} chars)`);
  } catch (e) {
    log(`  下载失败 ${u}: ${e.message}`);
  }
}

fs.writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log(`\n>>> 输出: ${OUT}`);
cdp.disconnect();
