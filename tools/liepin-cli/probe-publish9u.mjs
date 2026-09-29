/**
 * 探测 9u:新tab + Runtime关闭 + goto 真实 update URL → 表单渲染 → 保存抓 payload
 */
import { CdpBrowser } from './dist/browser/cdp_browser.js';
import { setPageRuntime } from './dist/common/lpt-utils.js';
import fs from 'node:fs';

const OUT = `${process.cwd()}/publish-probe9u-output.txt`;
const lines = [];
const log = (s) => { console.log(String(s).slice(0, 300)); lines.push(String(s)); };

const cdp = new CdpBrowser();
const page = await cdp.launch();
const browser = cdp.getBrowser();

// 清掉旧 tab
const olds = await browser.pages();
for (let i = 1; i < olds.length; i++) await olds[i].close().catch(() => {});

const fresh = await browser.newPage();
let savedPayload = null;
fresh.on('request', (req) => {
  const u = req.url();
  if (u.includes('save-ejob-draft') || u.includes('update-ejob') || u.includes('publish-ejob')) {
    savedPayload = { url: u, body: req.postData() || '' };
    log('!! 捕获保存请求: ' + u);
  }
});

const URL_UPDATE = 'https://lpt.liepin.com/job/publish?ejobId=85027561&ejobActionType=update&ejobTypeCode=0';

await setPageRuntime(fresh, false);
await fresh.goto(URL_UPDATE, { waitUntil: 'networkidle2', timeout: 40000 });
await setPageRuntime(fresh, true);
log('## 导航完成: ' + fresh.url().slice(0, 100));

// 等 React 渲染(期间少量 evaluate)
let ready = false;
for (let i = 0; i < 12; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  const st = await fresh.evaluate(() => ({
    url: location.href,
    inputs: document.querySelectorAll('input,textarea').length,
    bodyLen: document.body ? document.body.innerText.length : 0,
  })).catch(() => ({ url: 'eval失败', inputs: -1, bodyLen: -1 }));
  log(`  [${(i+1)*3}s] ${st.url.slice(0, 60)} inputs=${st.inputs} bodyLen=${st.bodyLen}`);
  if (st.inputs > 8) { ready = true; break; }
}
log('\n## 表单就绪: ' + ready);

if (ready) {
  const info = await fresh.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input,textarea')).slice(0, 30).map((el) => ({
      cls: (el.className || '').toString().slice(0, 40),
      value: String(el.value || '').slice(0, 25),
      placeholder: el.placeholder || '',
    }));
    const buttons = Array.from(document.querySelectorAll('button')).map((b) => {
      const r = b.getBoundingClientRect();
      return { text: (b.textContent || '').trim().slice(0, 12), x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
    }).filter((b) => b.text);
    return { inputs: inputs, buttons };
  });
  log('## 输入框:\n' + JSON.stringify(info.inputs, null, 1).slice(0, 2200));
  log('## 按钮: ' + JSON.stringify(info.buttons));

  const save = info.buttons.find((b) => b.text === '保存');
  if (save) {
    await fresh.mouse.click(save.x, save.y);
    log('## 已点击保存(原值回写)...');
    await new Promise((r) => setTimeout(r, 12000));
  }
}

if (savedPayload) {
  log('\n## ===== 保存 payload =====');
  const params = new URLSearchParams(savedPayload.body);
  log('saveInfoExtVo: ' + params.get('saveInfoExtVo'));
  const vo = params.get('ejobSaveInputVo');
  if (vo) {
    const obj = JSON.parse(vo);
    log('\n### ejobSaveInputVo 共 ' + Object.keys(obj).length + ' 字段:');
    for (const [k, v] of Object.entries(obj)) {
      const vs = typeof v === 'string' && v.length > 55 ? v.slice(0, 55) + '...' : JSON.stringify(v);
      log(`  ${k}: ${vs}`);
    }
  }
} else if (ready) {
  log('\n## 未捕获保存请求, 页面文本:');
  log(await fresh.evaluate(() => document.body.innerText.slice(0, 500)).catch(() => '(关闭)'));
}

fs.writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log('\n>>> 输出: ' + OUT);
cdp.disconnect();
