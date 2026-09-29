/**
 * 探测 8h:正确姿势打开编辑页(新tab + Runtime关闭导航)→ dump 表单 → 抓保存请求
 */
import { CdpBrowser } from './dist/browser/cdp_browser.js';
import { setPageRuntime } from './dist/common/lpt-utils.js';
import fs from 'node:fs';

const OUT = `${process.cwd()}/publish-probe8h-output.txt`;
const lines = [];
const log = (s) => { console.log(String(s).slice(0, 300)); lines.push(String(s)); };

const cdp = new CdpBrowser();
const page = await cdp.launch();
const browser = cdp.getBrowser();
const fresh = await browser.newPage();

let savedPayload = null;
fresh.on('request', (req) => {
  const url = req.url();
  if (url.includes('save-ejob-draft') || url.includes('update-ejob') || url.includes('publish-ejob')) {
    savedPayload = { url, body: req.postData() || '' };
    log('!! 捕获保存请求: ' + url);
  }
});

// 正确姿势:Runtime off → goto → on
await setPageRuntime(fresh, false);
await fresh.goto('https://lpt.liepin.com/job/publish?ejobId=85027561&ejobActionType=edit', {
  waitUntil: 'networkidle2', timeout: 40000,
});
await setPageRuntime(fresh, true);
log('## 导航完成: ' + fresh.url().slice(0, 80));

// 等渲染
await new Promise((r) => setTimeout(r, 8000));

const info = await fresh.evaluate(() => ({
  url: location.href,
  title: document.title,
  inputs: Array.from(document.querySelectorAll('input,textarea')).slice(0, 30).map((el) => ({
    tag: el.tagName, cls: (el.className||'').toString().slice(0, 50),
    value: String(el.value||'').slice(0, 40), placeholder: el.placeholder || '',
  })),
  buttons: Array.from(document.querySelectorAll('button')).map((b) => (b.textContent||'').trim()).filter(Boolean).slice(0, 20),
  bodyLen: document.body ? document.body.innerText.length : 0,
}));
log('## url: ' + info.url.slice(0, 80));
log('## title: ' + info.title);
log('## bodyLen: ' + info.bodyLen);
log('## inputs 数量: ' + info.inputs.length);
log(JSON.stringify(info.inputs, null, 1).slice(0, 2500));
log('## buttons: ' + JSON.stringify(info.buttons));

// 若表单就绪 → 点击"保存"(真实鼠标坐标)
if (info.inputs.length > 3) {
  const box = await fresh.evaluate(() => {
    const save = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent||'').trim() === '保存');
    if (!save) return null;
    const r = save.getBoundingClientRect();
    return { x: r.x + r.width/2, y: r.y + r.height/2, w: r.width, h: r.height };
  });
  log('\n## 保存按钮: ' + JSON.stringify(box));
  if (box) {
    await fresh.bringToFront();
    await fresh.mouse.click(box.x, box.y);
    log('## 已点击保存,等待请求...');
    await new Promise((r) => setTimeout(r, 10000));
  }
}

if (savedPayload) {
  log('\n## ===== 捕获保存请求 =====');
  const params = new URLSearchParams(savedPayload.body);
  log('saveInfoExtVo: ' + params.get('saveInfoExtVo'));
  const vo = params.get('ejobSaveInputVo');
  if (vo) {
    const obj = JSON.parse(vo);
    log('\n### ejobSaveInputVo 共 ' + Object.keys(obj).length + ' 字段:');
    for (const [k, v] of Object.entries(obj)) {
      const vs = typeof v === 'string' && v.length > 60 ? v.slice(0, 60) + '...' : JSON.stringify(v);
      log(`  ${k}: ${vs}`);
    }
  }
} else {
  log('\n## 未捕获保存请求');
  const txt = await fresh.evaluate(() => document.body.innerText.slice(0, 600)).catch(() => '(页面已关闭)');
  log('## 页面文本:\n' + txt);
}

fs.writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log('\n>>> 输出: ' + OUT);
cdp.disconnect();
