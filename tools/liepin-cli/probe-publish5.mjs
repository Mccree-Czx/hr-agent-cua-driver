/**
 * 探测 5:收集页面全部 JS chunk → Node 下载 → 提取职位保存/发布相关 API 名
 * 用法:node probe-publish5.mjs
 * 输出:./bundle-downloads/*.js + ./publish-probe5-output.txt
 */
import { CdpBrowser } from './dist/browser/cdp_browser.js';
import fs from 'node:fs';

const OUT = `${process.cwd()}/publish-probe5-output.txt`;
const BUNDLE_DIR = `${process.cwd()}/bundle-downloads`;
fs.mkdirSync(BUNDLE_DIR, { recursive: true });

const lines = [];
const log = (s) => {
  console.log(String(s).slice(0, 300));
  lines.push(String(s));
};

const cdp = new CdpBrowser();
const page = await cdp.launch();
log(`# 探测5 ${new Date().toISOString()}`);

const scriptUrls = new Set();
page.on('response', (res) => {
  const url = res.url().split('?')[0];
  if (url.endsWith('.js') && (url.includes('liepin') || url.includes('lietou'))) {
    scriptUrls.add(url);
  }
});

// 先到管理页(稳定入口),再去编辑页让相关 chunk 加载
await cdp.navigate('https://lpt.liepin.com/job/manager');
await new Promise((r) => setTimeout(r, 5000));
log(`## 管理页 URL: ${page.url()}, 已收集 JS: ${scriptUrls.size}`);

await cdp.navigate('https://lpt.liepin.com/job/publish?ejobId=85027561&ejobActionType=edit');
await new Promise((r) => setTimeout(r, 12000));
log(`## 编辑页 URL: ${page.url()}, 已收集 JS: ${scriptUrls.size}`);

log('\n## 收集到的 JS 文件:');
for (const u of scriptUrls) log(`  ${u}`);

// Node 端下载全部 JS(绕开页面跨域),grep 职位 API
log('\n## 下载并检索职位相关 API...');
const apiNames = new Set();
let downloaded = 0;

for (const u of scriptUrls) {
  try {
    const res = await fetch(u);
    if (!res.ok) continue;
    const text = await res.text();
    downloaded++;
    const fname = `${BUNDLE_DIR}/${u.split('/').pop().slice(0, 80)}`;
    fs.writeFileSync(fname, text, 'utf8');

    // 提取职位保存/发布相关 API 名
    const matches = text.match(/com\.liepin\.[A-Za-z0-9_.-]*/g) || [];
    for (const m of matches) {
      if (/ejob|job/i.test(m) && /save|submit|publish|add|create|edit|update|info|query/i.test(m)) {
        apiNames.add(m);
      }
    }
  } catch (e) {
    log(`  下载失败 ${u.split('/').pop()}: ${e.message.slice(0, 60)}`);
  }
}

log(`\n## 已下载 ${downloaded} 个 JS 文件`);
log('\n## ===== 职位相关候选 API 名 =====');
for (const n of Array.from(apiNames).sort()) {
  log(`  ${n}`);
}

fs.writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log(`\n>>> 输出: ${OUT}`);
cdp.disconnect();
