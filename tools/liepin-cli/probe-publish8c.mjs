/**
 * 探测 8c:页面内导航(location.href)到编辑页 —— 绕开 CDP navigate 检测
 */
import { CdpBrowser } from './dist/browser/cdp_browser.js';
import fs from 'node:fs';

const OUT = `${process.cwd()}/publish-probe8c-output.txt`;
const lines = [];
const log = (s) => { console.log(String(s).slice(0, 250)); lines.push(String(s)); };

const cdp = new CdpBrowser();
const page = await cdp.launch();

let savedPayload = null;
page.on('request', (req) => {
  const url = req.url();
  if (url.includes('save-ejob-draft') || url.includes('update-ejob') || url.includes('publish-ejob')) {
    savedPayload = { url, body: req.postData() || '' };
    log('!! 捕获保存请求: ' + url);
  }
});

// 先到安全页
await cdp.navigate('https://lpt.liepin.com/job/manager');
await new Promise((r) => setTimeout(r, 3000));
log('## 管理页: ' + page.url());

// 页面内导航到编辑页
await page.evaluate(() => {
  location.href = 'https://lpt.liepin.com/job/publish?ejobId=85027561&ejobActionType=edit';
});
log('## 已触发页面内导航');

let ready = false;
for (let i = 0; i < 25; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const st = await page.evaluate(() => ({
    url: location.href,
    val: document.querySelector('input[placeholder*="职位名称"], input[placeholder*="填写职位"]')?.value || null,
  })).catch(() => ({ url: 'eval失败', val: null }));
  if (i % 4 === 0 || st.val) log(`  [${(i + 1) * 2}s] ${st.url.slice(0, 70)} title="${st.val}"`);
  if (st.val) { ready = true; break; }
}

log(`\n## formReady=${ready}`);
if (ready) {
  const info = await page.evaluate(() => ({
    inputs: document.querySelectorAll('input, textarea').length,
    buttons: Array.from(document.querySelectorAll('button')).map(b => (b.textContent || '').trim()).filter(Boolean).slice(0, 25),
  }));
  log('## 表单概况: ' + JSON.stringify(info));

  // 用真实鼠标事件点击保存按钮
  const box = await page.evaluate(() => {
    const save = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === '保存');
    if (!save) return null;
    const r = save.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  log('## 保存按钮位置: ' + JSON.stringify(box));
  if (box) {
    await page.mouse.click(box.x, box.y);  // CDP 真实鼠标事件
    log('## 已用鼠标事件点击保存');
    await new Promise((r) => setTimeout(r, 10000));
  }

  if (savedPayload) {
    log('\n## ===== 捕获的保存请求 =====');
    const params = new URLSearchParams(savedPayload.body);
    const vo = params.get('ejobSaveInputVo');
    log('URL: ' + savedPayload.url);
    log('saveInfoExtVo: ' + params.get('saveInfoExtVo'));
    if (vo) {
      const obj = JSON.parse(vo);
      log('\n### ejobSaveInputVo 字段(共 ' + Object.keys(obj).length + '):');
      for (const [k, v] of Object.entries(obj)) {
        const vs = typeof v === 'string' && v.length > 50 ? v.slice(0, 50) + '...' : JSON.stringify(v);
        log(`  ${k}: ${vs}`);
      }
    }
  } else {
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 1000));
    log('## 未捕获保存请求(可能校验未通过),页面文本:\n' + bodyText);
  }
}

fs.writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log('\n>>> 输出: ' + OUT);
cdp.disconnect();
