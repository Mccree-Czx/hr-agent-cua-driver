/**
 * 探测 4:编辑页完整加载 → dump 表单结构 → 点击"保存" → 抓保存 API 与 payload
 * 用资深亚马逊运营(ejobId=85027561)编辑页,不做任何修改直接保存(原值回写,风险可控)
 * 用法:node probe-publish4.mjs
 * 输出:./publish-probe4-output.txt
 */
import { CdpBrowser } from './dist/browser/cdp_browser.js';
import fs from 'node:fs';

const OUT = `${process.cwd()}/publish-probe4-output.txt`;
const lines = [];
const log = (s) => {
  console.log(String(s).slice(0, 400));
  lines.push(String(s));
};

const cdp = new CdpBrowser();
const page = await cdp.launch();
log(`# 探测4 ${new Date().toISOString()}`);

const requests = [];
page.on('request', (req) => {
  const type = req.resourceType();
  if (type === 'xhr' || type === 'fetch') {
    const url = req.url();
    if (url.includes('api-lpt') && !url.includes('common.access') && !url.includes('unread-cnt')) {
      requests.push({ url, method: req.method(), body: (req.postData() || '').slice(0, 2000) });
    }
  }
});
const responses = [];
page.on('response', async (res) => {
  const url = res.url();
  if (url.includes('ejobmanage') || url.includes('ejobinfo') || url.includes('ejobedit')) {
    try {
      const t = await res.text();
      responses.push({ url, status: res.status(), body: t.slice(0, 3000) });
    } catch {}
  }
});

// 1. 打开编辑页
await cdp.navigate('https://lpt.liepin.com/job/publish?ejobId=85027561&ejobActionType=edit');
log('## 等待表单渲染...');
try {
  await page.waitForSelector('input', { timeout: 20000 });
} catch {
  log('!! input 未出现');
}
await new Promise((r) => setTimeout(r, 10000));

log(`## URL: ${page.url()}`);
log(`## 标题: ${await page.title()}`);

// 2. dump 表单结构
const domInfo = await page.evaluate(() => {
  const out = {};
  out.bodyText = document.body.innerText.slice(0, 2500);

  const inputs = Array.from(document.querySelectorAll('input, textarea'));
  out.inputs = inputs.slice(0, 45).map((el) => ({
    tag: el.tagName,
    type: el.type || '',
    cls: (el.className || '').toString().slice(0, 80),
    value: String(el.value || '').slice(0, 50),
    placeholder: el.placeholder || '',
  }));

  // 保存按钮查找
  const btns = Array.from(document.querySelectorAll('button'));
  out.buttons = btns.slice(0, 20).map((b) => ({
    text: (b.textContent || '').trim().slice(0, 20),
    cls: (b.className || '').toString().slice(0, 80),
  }));

  // 选择器已选中的值
  const selects = Array.from(document.querySelectorAll('.ant-lpt-select'));
  out.selects = selects.slice(0, 20).map((el) => ({
    text: (el.innerText || '').replace(/\s+/g, ' ').slice(0, 60),
  }));
  return out;
});
log('\n## body 文本:\n' + domInfo.bodyText);
log('\n## 输入控件:\n' + JSON.stringify(domInfo.inputs, null, 2));
log('\n## 按钮:\n' + JSON.stringify(domInfo.buttons, null, 2));
log('\n## 选择器:\n' + JSON.stringify(domInfo.selects, null, 2));

const reqCountBefore = requests.length;

// 3. 点击"保存"按钮
const saveClicked = await page.evaluate(() => {
  const btns = Array.from(document.querySelectorAll('button'));
  const save = btns.find((b) => (b.textContent || '').trim() === '保存') || btns.find((b) => (b.textContent || '').includes('保存'));
  if (save) {
    save.click();
    return { ok: true, text: (save.textContent || '').trim() };
  }
  return { ok: false, allButtons: btns.map((b) => (b.textContent || '').trim()).slice(0, 15) };
});
log(`\n## 点击保存: ${JSON.stringify(saveClicked)}`);
await new Promise((r) => setTimeout(r, 8000));

// 4. 保存后的新请求与响应
log('\n## ===== 点击保存后的请求 =====');
for (const r of requests.slice(reqCountBefore)) {
  log(`\n[${r.method}] ${r.url}`);
  if (r.body) log(`  body: ${r.body}`);
}

log('\n## ===== ejob 接口响应 =====');
for (const r of responses) {
  log(`\n### ${r.status} ${r.url}\n${r.body.slice(0, 1500)}`);
}

log('\n## ===== 全部请求(去重) =====');
const seen = new Set();
for (const r of requests) {
  if (seen.has(r.url)) continue;
  seen.add(r.url);
  log(`[${r.method}] ${r.url}${r.body ? `\n  body: ${r.body.slice(0, 300)}` : ''}`);
}

fs.writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log(`\n>>> 输出: ${OUT}`);
cdp.disconnect();
