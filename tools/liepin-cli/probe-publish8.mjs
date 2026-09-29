/**
 * 探测 8:编辑页真实加载 → 点击"保存" → 抓前端生成的完整 ejobSaveInputVo(标准 payload 样例)
 * 用资深亚马逊运营(ejobId=85027561),不改任何字段,原值保存
 * 用法:node probe-publish8.mjs
 * 输出:./publish-probe8-output.txt
 */
import { CdpBrowser } from './dist/browser/cdp_browser.js';
import fs from 'node:fs';

const OUT = `${process.cwd()}/publish-probe8-output.txt`;
const lines = [];
const log = (s) => {
  console.log(String(s).slice(0, 300));
  lines.push(String(s));
};

const cdp = new CdpBrowser();
const page = await cdp.launch();
log(`# 探测8 ${new Date().toISOString()}`);

// 监听保存请求的完整 body
let savedPayload = null;
page.on('request', (req) => {
  const url = req.url();
  if (url.includes('save-ejob-draft') || url.includes('update-ejob') || url.includes('publish-ejob')) {
    savedPayload = { url, body: req.postData() || '' };
    log(`\n!! 捕获保存请求: ${url}\n body长度: ${(req.postData() || '').length}`);
  }
});

// 1. 先访问管理页(稳定入口)
await cdp.navigate('https://lpt.liepin.com/job/manager');
await new Promise((r) => setTimeout(r, 4000));
log(`## 管理页: ${page.url()}`);

// 2. 打开编辑页
await cdp.navigate('https://lpt.liepin.com/job/publish?ejobId=85027561&ejobActionType=edit');
log('## 等待表单渲染...');
let formReady = false;
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const val = await page.evaluate(() => {
    const input = document.querySelector('input[placeholder*="职位名称"], input[placeholder*="填写职位"]');
    return input ? input.value : null;
  });
  if (val) {
    formReady = true;
    log(`## 表单已就绪(第 ${i + 1} 次检查), 职位名称="${val}"`);
    break;
  }
}
log(`## URL: ${page.url()}, formReady=${formReady}`);

if (!formReady) {
  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 500));
  log('!! 表单未加载, body 前 500 字:\n' + bodyText);
  fs.writeFileSync(OUT, lines.join('\n'), 'utf8');
  cdp.disconnect();
  process.exit(0);
}

// 3. dump 保存按钮位置
const btnInfo = await page.evaluate(() => {
  const btns = Array.from(document.querySelectorAll('button'));
  return btns.map((b) => ({
    text: (b.textContent || '').trim().slice(0, 15),
    cls: (b.className || '').toString().slice(0, 60),
  }));
});
log('\n## 页面按钮:\n' + JSON.stringify(btnInfo));

// 4. 点击"保存"按钮(原生 click)
const clicked = await page.evaluate(() => {
  const btns = Array.from(document.querySelectorAll('button'));
  const save = btns.find((b) => (b.textContent || '').trim() === '保存');
  if (save) {
    save.click();
    return true;
  }
  return false;
});
log(`\n## 点击保存按钮: ${clicked}`);
await new Promise((r) => setTimeout(r, 8000));

// 5. 输出捕获的 payload
if (savedPayload) {
  log('\n## ===== 捕获的保存请求(标准 payload) =====');
  log('URL: ' + savedPayload.url);
  // body 是 url-encoded,展开 ejobSaveInputVo
  const params = new URLSearchParams(savedPayload.body);
  const ejobSaveInputVo = params.get('ejobSaveInputVo');
  const saveInfoExtVo = params.get('saveInfoExtVo');
  log('\n### saveInfoExtVo:\n' + saveInfoExtVo);
  if (ejobSaveInputVo) {
    log('\n### ejobSaveInputVo(完整,字段逐个列出):');
    try {
      const obj = JSON.parse(ejobSaveInputVo);
      for (const [k, v] of Object.entries(obj)) {
        const vs = typeof v === 'string' && v.length > 60 ? v.slice(0, 60) + '...' : JSON.stringify(v);
        log(`  ${k}: ${vs}`);
      }
      log(`\n  字段总数: ${Object.keys(obj).length}`);
    } catch (e) {
      log('  解析失败: ' + e.message);
      log(ejobSaveInputVo.slice(0, 3000));
    }
  } else {
    log('\n### 原始 body:\n' + savedPayload.body.slice(0, 3000));
  }
} else {
  log('\n## 未捕获到保存请求(可能页面提示校验失败未提交)');
  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 1200));
  log('## 页面文本:\n' + bodyText);
}

fs.writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log(`\n>>> 输出: ${OUT}`);
cdp.disconnect();
