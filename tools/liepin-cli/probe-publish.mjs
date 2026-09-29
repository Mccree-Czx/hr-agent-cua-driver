/**
 * 探测猎聘"发布职位"页:网络请求 + 关键 DOM 结构
 * 复用 CLI 的 CdpBrowser(含反检测导航 safeGoto)
 * 用法:node probe-publish.mjs
 * 输出:./publish-probe-output.txt
 */
import { CdpBrowser } from './dist/browser/cdp_browser.js';
import fs from 'node:fs';

const OUT = `${process.cwd()}/publish-probe-output.txt`;
const lines = [];
const log = (s) => {
  console.log(s);
  lines.push(s);
};

const cdp = new CdpBrowser();
const page = await cdp.launch();
log(`# 发布页探测 ${new Date().toISOString()}`);

const requests = [];
page.on('request', (req) => {
  const type = req.resourceType();
  if (type === 'xhr' || type === 'fetch') {
    const url = req.url();
    if (url.includes('liepin.com')) {
      requests.push({ url, method: req.method(), body: (req.postData() || '').slice(0, 600) });
    }
  }
});

log('\n## 通过 CLI 反检测导航打开发布页...');
await cdp.navigate('https://lpt.liepin.com/job/publish?ejobActionType=publish');
await new Promise((r) => setTimeout(r, 6000));

log(`## 页面标题: ${await page.title()}`);
log(`## 当前 URL: ${page.url()}`);

// 滚动触发懒加载
await page.evaluate(async () => {
  const total = Math.min(document.body.scrollHeight, 8000);
  for (let y = 0; y < total; y += 800) {
    window.scrollTo(0, y);
    await new Promise((r) => setTimeout(r, 250));
  }
  window.scrollTo(0, 0);
});
await new Promise((r) => setTimeout(r, 2000));

// ===== DOM 探测 =====
const domInfo = await page.evaluate(() => {
  const out = {};
  out.bodyTextHead = document.body.innerText.slice(0, 2500);

  const inputs = Array.from(document.querySelectorAll('input, textarea'));
  out.inputs = inputs.slice(0, 30).map((el) => ({
    tag: el.tagName,
    type: el.type || '',
    cls: (el.className || '').toString().slice(0, 100),
    placeholder: el.placeholder || '',
  }));

  const findLabel = (text) =>
    Array.from(document.querySelectorAll('div,span,label,p')).find(
      (el) => el.children.length === 0 && el.textContent.trim().replace(/\*/g, '') === text,
    );

  const grab = (text, max) => {
    const el = findLabel(text);
    if (!el) return '(未找到)';
    let p = el;
    for (let i = 0; i < 4 && p.parentElement; i++) {
      p = p.parentElement;
      if (p.outerHTML.length > 600) break;
    }
    return p.outerHTML.slice(0, max || 2000);
  };

  out.jobCategoryHtml = grab('职位类别');
  out.jobDescHtml = grab('职位描述', 2500);
  out.workAddressHtml = grab('工作地址');
  out.experienceHtml = grab('工作经验');
  out.educationHtml = grab('学历要求');
  out.salaryHtml = grab('薪资范围', 2500);

  // 下拉/弹层类名盘点(定位控件库)
  const classNames = new Set();
  document.querySelectorAll('[class*="select"], [class*="dropdown"], [class*="picker"]').forEach((el) => {
    (el.className || '').toString().split(/\s+/).forEach((c) => c && classNames.add(c));
  });
  out.controlClasses = Array.from(classNames).slice(0, 40);

  return out;
});

log('\n### body 文本前 2500 字:\n' + domInfo.bodyTextHead);
log('\n### 输入控件:\n' + JSON.stringify(domInfo.inputs, null, 2));
log('\n### 控件库类名:\n' + JSON.stringify(domInfo.controlClasses));
log('\n### 职位类别 DOM:\n' + domInfo.jobCategoryHtml);
log('\n### 职位描述 DOM:\n' + domInfo.jobDescHtml);
log('\n### 工作地址 DOM:\n' + domInfo.workAddressHtml);
log('\n### 工作经验 DOM:\n' + domInfo.experienceHtml);
log('\n### 学历要求 DOM:\n' + domInfo.educationHtml);
log('\n### 薪资范围 DOM:\n' + domInfo.salaryHtml);

// ===== 网络请求 dump =====
log('\n## ===== XHR/Fetch(api-lpt 相关) =====');
for (const r of requests) {
  log(`\n[${r.method}] ${r.url}`);
  if (r.body) log(`  body: ${r.body}`);
}

fs.writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log(`\n>>> 输出已保存: ${OUT}`);

cdp.disconnect();
