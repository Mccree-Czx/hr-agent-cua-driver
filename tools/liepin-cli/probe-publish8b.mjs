/**
 * 探测 8b:激活标签页(bringToFront)后再打开编辑页 —— 验证"标签页可见性检测"假设
 */
import { CdpBrowser } from './dist/browser/cdp_browser.js';
import fs from 'node:fs';

const OUT = `${process.cwd()}/publish-probe8b-output.txt`;
const lines = [];
const log = (s) => { console.log(String(s).slice(0, 250)); lines.push(String(s)); };

const cdp = new CdpBrowser();
const page = await cdp.launch();

// 激活标签页 + 浏览器窗口置前
try {
  await page.bringToFront();
  log('## bringToFront 已执行');
} catch (e) { log('bringToFront 失败: ' + e.message); }

const vis = await page.evaluate(() => document.visibilityState);
log('## 当前标签页 visibilityState: ' + vis);

// 监听保存请求
let savedPayload = null;
page.on('request', (req) => {
  const url = req.url();
  if (url.includes('save-ejob-draft') || url.includes('update-ejob') || url.includes('publish-ejob')) {
    savedPayload = { url, body: req.postData() || '' };
    log('!! 捕获保存请求: ' + url);
  }
});

await cdp.navigate('https://lpt.liepin.com/job/manager');
await new Promise((r) => setTimeout(r, 3000));
await page.bringToFront();
log('## 管理页 OK: ' + page.url());

await cdp.navigate('https://lpt.liepin.com/job/publish?ejobId=85027561&ejobActionType=edit');
await page.bringToFront();

// 等表单渲染
let ready = false;
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const st = await page.evaluate(() => ({ url: location.href, vis: document.visibilityState,
    val: document.querySelector('input[placeholder*="职位名称"], input[placeholder*="填写职位"]')?.value || null })).catch(() => ({ url: 'evaluate失败', vis: '', val: null }));
  if (i % 3 === 0 || st.val) log(`  [${(i+1)*2}s] url=${st.url.slice(0, 60)} vis=${st.vis} title="${st.val}"`);
  if (st.val) { ready = true; break; }
}

log(`\n## formReady=${ready}`);
if (ready) {
  // 检查表单是否完整加载(计数器)
  const info = await page.evaluate(() => ({
    inputs: document.querySelectorAll('input, textarea').length,
    selects: document.querySelectorAll('.ant-lpt-select').length,
    buttons: Array.from(document.querySelectorAll('button')).map(b => (b.textContent||'').trim()).filter(Boolean).slice(0, 20),
  }));
  log('## 表单概况: ' + JSON.stringify(info));

  // 点击保存
  const clicked = await page.evaluate(() => {
    const save = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === '保存');
    if (save) { save.click(); return true; }
    return false;
  });
  log('## 点击保存: ' + clicked);
  await new Promise((r) => setTimeout(r, 10000));

  if (savedPayload) {
    log('\n## ===== 捕获的保存请求 =====');
    const params = new URLSearchParams(savedPayload.body);
    const vo = params.get('ejobSaveInputVo');
    log('URL: ' + savedPayload.url);
    log('saveInfoExtVo: ' + params.get('saveInfoExtVo'));
    if (vo) {
      const obj = JSON.parse(vo);
      log('\n### ejobSaveInputVo 字段:');
      for (const [k, v] of Object.entries(obj)) {
        const vs = typeof v === 'string' && v.length > 50 ? v.slice(0, 50) + '...' : JSON.stringify(v);
        log(`  ${k}: ${vs}`);
      }
      log('字段总数: ' + Object.keys(obj).length);
    }
  } else {
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 800));
    log('## 未捕获保存请求,页面文本:\n' + bodyText);
  }
}

fs.writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log('\n>>> 输出: ' + OUT);
cdp.disconnect();
