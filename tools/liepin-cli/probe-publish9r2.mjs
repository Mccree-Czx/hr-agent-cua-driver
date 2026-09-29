/**
 * 探测 9r2:真实路径 - 点击编辑(新标签页)→ 编辑页调表单 → 点保存抓 payload
 */
import { CdpBrowser } from './dist/browser/cdp_browser.js';
import { setPageRuntime } from './dist/common/lpt-utils.js';
import fs from 'node:fs';

const OUT = `${process.cwd()}/publish-probe9r2-output.txt`;
const lines = [];
const log = (s) => { console.log(String(s).slice(0, 300)); lines.push(String(s)); };

const cdp = new CdpBrowser();
const page = await cdp.launch();
const browser = cdp.getBrowser();

let editPage = null;
let savedPayload = null;

// 监听新标签页
browser.on('targetcreated', async (target) => {
  if (target.type() !== 'page') return;
  try {
    const p = await target.page();
    if (!p) return;
    const url = p.url();
    log('!! 新标签页: ' + url.slice(0, 90));
    if (url.includes('job/publish') || url.includes('job/manager')) {
      editPage = p;
      p.on('request', (req) => {
        const u = req.url();
        if (u.includes('save-ejob-draft') || u.includes('update-ejob') || u.includes('publish-ejob')) {
          savedPayload = { url: u, body: req.postData() || '' };
          log('!! 捕获保存请求: ' + u);
        }
      });
    }
  } catch (e) { log('targetcreated 处理失败: ' + e.message.slice(0, 80)); }
});

// 1. 管理页
await setPageRuntime(page, false);
await page.goto('https://lpt.liepin.com/job/manager', { waitUntil: 'networkidle2', timeout: 40000 });
await setPageRuntime(page, true);
await new Promise((r) => setTimeout(r, 5000));
await page.bringToFront();
log('## 管理页就绪');

// 2. 点击编辑图标
const pos = await page.evaluate(() => {
  const el = document.querySelector('.antlpticon-edit');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
log('## 编辑图标: ' + JSON.stringify(pos));
await page.mouse.click(pos.x, pos.y);
log('## 已点击');

await new Promise((r) => setTimeout(r, 6000));

// 3. 盘点标签页
const pages = await browser.pages();
log('## 当前标签页数: ' + pages.length);
for (const p of pages) {
  log('  tab: ' + p.url().slice(0, 90));
  if (p.url().includes('job/publish')) editPage = p;
}
if (!editPage && page.url().includes('job/publish')) editPage = page;

if (!editPage) {
  log('!! 未找到编辑页标签');
  fs.writeFileSync(OUT, lines.join('\n'), 'utf8');
  cdp.disconnect();
  process.exit(0);
}

// 4. 编辑页等表单渲染
await editPage.bringToFront();
log('\n## 编辑页: ' + editPage.url().slice(0, 90));
let formReady = false;
for (let i = 0; i < 15; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const st = await editPage.evaluate(() => ({
    url: location.href,
    inputs: document.querySelectorAll('input,textarea').length,
    title: document.title,
  })).catch(() => ({ url: 'eval失败', inputs: -1, title: '' }));
  if (i % 2 === 0 || st.inputs > 10) log(`  [${(i+1)*2}s] ${st.url.slice(0, 60)} inputs=${st.inputs} title=${st.title.slice(0, 20)}`);
  if (st.inputs > 10) { formReady = true; break; }
}
log('\n## 表单就绪: ' + formReady);

if (formReady) {
  const formInfo = await editPage.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input,textarea')).slice(0, 35).map((el) => ({
      cls: (el.className || '').toString().slice(0, 42),
      value: String(el.value || '').slice(0, 30),
      placeholder: el.placeholder || '',
    }));
    const buttons = Array.from(document.querySelectorAll('button')).map((b) => {
      const r = b.getBoundingClientRect();
      return { text: (b.textContent || '').trim().slice(0, 12), x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
    }).filter((b) => b.text);
    return { inputs, buttons };
  });
  log('## 表单输入框:\n' + JSON.stringify(formInfo.inputs, null, 1).slice(0, 2000));
  log('## 按钮: ' + JSON.stringify(formInfo.buttons));

  const save = formInfo.buttons.find((b) => b.text === '保存');
  if (save) {
    await editPage.mouse.click(save.x, save.y);
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
} else if (formReady) {
  log('\n## 未捕获保存请求, 页面文本:');
  log(await editPage.evaluate(() => document.body.innerText.slice(0, 500)).catch(() => '(关闭)'));
}

fs.writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log('\n>>> 输出: ' + OUT);
cdp.disconnect();
