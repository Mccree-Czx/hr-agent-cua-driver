/**
 * 探测 9r:真实用户路径 —— 管理页点击编辑图标 → 编辑页渲染 → 点保存抓 payload
 */
import { CdpBrowser } from './dist/browser/cdp_browser.js';
import { setPageRuntime } from './dist/common/lpt-utils.js';
import fs from 'node:fs';

const OUT = `${process.cwd()}/publish-probe9r-output.txt`;
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

// 1. 打开管理页(正确姿势)
await setPageRuntime(fresh, false);
await fresh.goto('https://lpt.liepin.com/job/manager', { waitUntil: 'networkidle2', timeout: 40000 });
await setPageRuntime(fresh, true);
await new Promise((r) => setTimeout(r, 5000));
log('## 管理页: ' + fresh.url());
await fresh.bringToFront();

// 2. 点击编辑图标
const editPos = await fresh.evaluate(() => {
  const el = document.querySelector('.antlpticon-edit');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
log('## 编辑图标坐标: ' + JSON.stringify(editPos));
if (editPos) {
  await fresh.mouse.click(editPos.x, editPos.y);
  log('## 已点击编辑图标');
}

// 3. 等 SPA 跳转 + 渲染
let ready = false;
for (let i = 0; i < 15; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const st = await fresh.evaluate(() => ({
    url: location.href,
    inputs: document.querySelectorAll('input,textarea').length,
    rootLen: document.querySelector('#root')?.children?.length ?? -1,
  })).catch(() => ({ url: 'eval失败', inputs: -1, rootLen: -1 }));
  if (i % 3 === 0 || st.inputs > 3) log(`  [${(i+1)*2}s] url=${st.url.slice(0, 70)} inputs=${st.inputs}`);
  if (st.inputs > 5) { ready = true; break; }
}
log('\n## 编辑页准备: ' + ready + ', URL: ' + fresh.url().slice(0, 90));

if (ready) {
  const formInfo = await fresh.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input,textarea')).map((el) => ({
      cls: (el.className || '').toString().slice(0, 45),
      value: String(el.value || '').slice(0, 35),
      placeholder: el.placeholder || '',
    }));
    const buttons = Array.from(document.querySelectorAll('button')).map((b) => {
      const r = b.getBoundingClientRect();
      return { text: (b.textContent || '').trim().slice(0, 12), x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
    }).filter((b) => b.text);
    return { inputs: inputs.slice(0, 35), buttons };
  });
  log('\n## 表单输入框:\n' + JSON.stringify(formInfo.inputs, null, 1).slice(0, 2200));
  log('\n## 按钮(含坐标):\n' + JSON.stringify(formInfo.buttons));

  // 4. 点击"保存"(鼠标)
  const saveBtn = formInfo.buttons.find((b) => b.text === '保存');
  log('\n## 保存按钮: ' + JSON.stringify(saveBtn));
  if (saveBtn) {
    await fresh.mouse.click(saveBtn.x, saveBtn.y);
    log('## 已点击保存(原值回写),等待...');
    await new Promise((r) => setTimeout(r, 12000));
  }
}

if (savedPayload) {
  log('\n## ===== 保存请求 payload =====');
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
  log(await fresh.evaluate(() => document.body.innerText.slice(0, 600)).catch(() => '(关闭)'));
}

fs.writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log('\n>>> 输出: ' + OUT);
cdp.disconnect();
