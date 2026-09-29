/**
 * 探测 3:职位管理页 → 找到"编辑职位"入口 → 进入编辑表单 → 抓表单结构 + 保存接口
 * 不执行保存(只 dump DOM 与已有网络请求)
 * 用法:node probe-publish3.mjs
 * 输出:./publish-probe3-output.txt
 */
import { CdpBrowser } from './dist/browser/cdp_browser.js';
import fs from 'node:fs';

const OUT = `${process.cwd()}/publish-probe3-output.txt`;
const lines = [];
const log = (s) => {
  console.log(String(s).slice(0, 300));
  lines.push(String(s));
};

const cdp = new CdpBrowser();
const page = await cdp.launch();
log(`# 探测3 ${new Date().toISOString()}`);

const requests = [];
page.on('request', (req) => {
  const type = req.resourceType();
  if (type === 'xhr' || type === 'fetch') {
    const url = req.url();
    if (url.includes('api-lpt') || url.includes('api-dok')) {
      requests.push({ url, method: req.method(), body: (req.postData() || '').slice(0, 500) });
    }
  }
});

// 1. 打开职位管理页
await cdp.navigate('https://lpt.liepin.com/job/manager');
await new Promise((r) => setTimeout(r, 5000));
log(`\n## 职位管理页 URL: ${page.url()}`);

// 2. 找编辑入口
const editEntry = await page.evaluate(() => {
  // 找编辑按钮/链接:title 含"编辑",或 class 含 edit,或 href 带 publish/edit
  const candidates = [];
  document.querySelectorAll('a, button, span, div').forEach((el) => {
    const title = el.getAttribute?.('title') || '';
    const cls = (el.className || '').toString();
    const href = el.getAttribute?.('href') || '';
    if (
      title.includes('编辑') ||
      (cls.includes('edit') && el.tagName !== 'HTML') ||
      href.includes('publish') ||
      href.includes('edit')
    ) {
      candidates.push({
        tag: el.tagName,
        title,
        cls: cls.slice(0, 80),
        href: href.slice(0, 200),
        text: (el.textContent || '').trim().slice(0, 30),
      });
    }
  });
  return candidates.slice(0, 20);
});
log(`\n## 编辑入口候选:\n${JSON.stringify(editEntry, null, 2)}`);

// 3. 尝试点击第一个可见编辑按钮(带 title=编辑 的)
const clicked = await page.evaluate(() => {
  const els = Array.from(document.querySelectorAll('[title="编辑"], [class*="edit-icon"], [class*="editIcon"]'));
  if (els.length > 0) {
    const el = els[0];
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return { ok: true, tag: el.tagName, cls: (el.className || '').toString().slice(0, 80) };
  }
  return { ok: false };
});
log(`\n## 点击编辑: ${JSON.stringify(clicked)}`);

// 4. 等路由跳转
await new Promise((r) => setTimeout(r, 5000));
log(`\n## 点击后 URL: ${page.url()}`);

// 若仍在管理页,尝试直接构造编辑 URL 猜测(部分系统是 /job/publish?ejobId=xxx)
if (page.url().includes('/job/manager')) {
  // 从页面抓第一个职位的 jobId(链接或 data 属性)
  const jobId = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[href*="jobId"], a[href*="ejobId"], a[href*="job/"]'));
    for (const a of links) {
      const m = a.href.match(/(?:ejobId|jobId|job_id)=(\d+)/);
      if (m) return m[1];
    }
    // 页面上找纯数字链接(职位卡片)
    const all = Array.from(document.querySelectorAll('a'));
    for (const a of all) {
      const m = a.href.match(/ejobId%3D(\d+)|ejobId=(\d+)/);
      if (m) return m[1] || m[2];
    }
    return null;
  });
  log(`## 页面抓到的 jobId: ${jobId}`);
  if (jobId) {
    await cdp.navigate(`https://lpt.liepin.com/job/publish?ejobId=${jobId}&ejobActionType=edit`);
    await new Promise((r) => setTimeout(r, 6000));
    log(`## 编辑页 URL: ${page.url()}`);
  }
}

// 5. dump 编辑页表单结构(若已进入编辑/发布表单页)
if (page.url().includes('/job/publish')) {
  const domInfo = await page.evaluate(() => {
    const out = {};
    out.bodyText = document.body.innerText.slice(0, 1500);

    // 所有带值的输入控件(编辑页表单已预填)
    const inputs = Array.from(document.querySelectorAll('input, textarea'));
    out.inputs = inputs.slice(0, 40).map((el) => ({
      tag: el.tagName,
      cls: (el.className || '').toString().slice(0, 90),
      value: (el.value || '').slice(0, 60),
      placeholder: el.placeholder || '',
    }));

    // 选择器容器(已选中值的展示)
    const selectors = Array.from(document.querySelectorAll('.ant-lpt-select'));
    out.selects = selectors.slice(0, 15).map((el) => ({
      cls: (el.className || '').toString().slice(0, 100),
      text: (el.innerText || '').replace(/\n/g, '|').slice(0, 80),
    }));

    // 职位名称输入框的父容器(含隐藏字段?)
    const nameInput = document.querySelector('input[placeholder*="职位名称"], input[placeholder*="填写职位"]');
    if (nameInput) {
      let p = nameInput;
      for (let i = 0; i < 3; i++) p = p.parentElement;
      out.nameFormItem = p.outerHTML.slice(0, 1500);
    }
    return out;
  });
  log('\n## 编辑页 body 文本:\n' + domInfo.bodyText);
  log('\n## 编辑页输入控件:\n' + JSON.stringify(domInfo.inputs, null, 2));
  log('\n## 编辑页选择器:\n' + JSON.stringify(domInfo.selects, null, 2));
  log('\n## 职位名称表单项 DOM:\n' + (domInfo.nameFormItem || '(未找到)'));
}

// 6. 网络请求
log('\n## ===== 网络请求 =====');
for (const r of requests) {
  log(`\n[${r.method}] ${r.url}`);
  if (r.body) log(`  body: ${r.body}`);
}

fs.writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log(`\n>>> 输出: ${OUT}`);
cdp.disconnect();
