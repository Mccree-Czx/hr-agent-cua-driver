/**
 * 探测 9w:滚动定位"更新职位"按钮 + puppeteer click → 抓真实 payload
 */
import { CdpBrowser } from './dist/browser/cdp_browser.js';
import { setPageRuntime } from './dist/common/lpt-utils.js';
import fs from 'node:fs';

const OUT = `${process.cwd()}/publish-probe9w-output.txt`;
const lines = [];
const log = (s) => { console.log(String(s).slice(0, 300)); lines.push(String(s)); };

const cdp = new CdpBrowser();
const page = await cdp.launch();
const browser = cdp.getBrowser();
const olds = await browser.pages();
for (let i = 1; i < olds.length; i++) await olds[i].close().catch(() => {});

const fresh = await browser.newPage();
const captured = [];
fresh.on('request', (req) => {
  const u = req.url();
  if (u.includes('ejobinfomaintain')) {
    captured.push({ url: u, body: req.postData() || '' });
    log('!! 捕获: ' + u.split('/').pop());
  }
});

await setPageRuntime(fresh, false);
await fresh.goto('https://lpt.liepin.com/job/publish?ejobId=85027561&ejobActionType=update&ejobTypeCode=0', {
  waitUntil: 'networkidle2', timeout: 40000,
});
await setPageRuntime(fresh, true);
await new Promise((r) => setTimeout(r, 8000));
log('## 编辑页就绪');

// 滚动到按钮 + 拿 class/坐标
const btnInfo = await fresh.evaluate(() => {
  const b = Array.from(document.querySelectorAll('button')).find((x) => (x.textContent || '').trim() === '更新职位');
  if (!b) return null;
  b.scrollIntoView({ block: 'center' });
  return { cls: (b.className || '').toString() };
});
log('## 按钮 class: ' + JSON.stringify(btnInfo));
await new Promise((r) => setTimeout(r, 1500));

// 重新拿视口内坐标
const btnPos = await fresh.evaluate(() => {
  const b = Array.from(document.querySelectorAll('button')).find((x) => (x.textContent || '').trim() === '更新职位');
  const r = b.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, inView: r.top >= 0 && r.bottom <= window.innerHeight, winH: window.innerHeight };
});
log('## 按钮视口内坐标: ' + JSON.stringify(btnPos));

await fresh.mouse.click(btnPos.x, btnPos.y);
log('## 已点击"更新职位"(视口坐标)');
await new Promise((r) => setTimeout(r, 8000));

// 检查反应:请求?弹窗?错误提示?
const after = await fresh.evaluate(() => {
  const modalBtns = Array.from(document.querySelectorAll('[class*="modal"] button, [class*="Modal"] button, [class*="dialog"] button'))
    .map((b) => ({ text: (b.textContent || '').trim(), x: (b.getBoundingClientRect().x + b.getBoundingClientRect().width/2), y: (b.getBoundingClientRect().y + b.getBoundingClientRect().height/2) }));
  const errs = Array.from(document.querySelectorAll('.ant-lpt-form-item-explain-error, [class*="error"]')).map((e) => (e.textContent || '').trim()).filter(Boolean).slice(0, 5);
  return { modalBtns, errs, url: location.href };
});
log('## 弹窗按钮: ' + JSON.stringify(after.modalBtns));
log('## 校验错误: ' + JSON.stringify(after.errs));
log('## URL: ' + after.url.slice(0, 90));

// 如有确认弹窗→点击
const ok = after.modalBtns.find((b) => /确定|确认|继续|仍要|提交/.test(b.text));
if (ok) {
  await fresh.mouse.click(ok.x, ok.y);
  log('## 已点击弹窗确认: ' + ok.text);
  await new Promise((r) => setTimeout(r, 10000));
}

for (const c of captured) {
  log('\n## ===== 捕获请求: ' + c.url + ' =====');
  const params = new URLSearchParams(c.body);
  log('saveInfoExtVo: ' + params.get('saveInfoExtVo'));
  const vo = params.get('ejobSaveInputVo');
  if (vo) {
    log('### ejobSaveInputVo 共 ' + Object.keys(vo ? JSON.parse(vo) : {}) + ' 字段');
    const obj = JSON.parse(vo);
    for (const [k, v] of Object.entries(obj)) {
      const vs = typeof v === 'string' && v.length > 55 ? v.slice(0, 55) + '...' : JSON.stringify(v);
      log(`  ${k}: ${vs}`);
    }
  }
}
if (captured.length === 0) log('\n## 仍未捕获请求');

fs.writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log('\n>>> 输出: ' + OUT);
cdp.disconnect();
