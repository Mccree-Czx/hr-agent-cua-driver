/**
 * 探测 9v:编辑页点击"更新职位" → 抓真实保存 payload(原值回写)
 */
import { CdpBrowser } from './dist/browser/cdp_browser.js';
import { setPageRuntime } from './dist/common/lpt-utils.js';
import fs from 'node:fs';

const OUT = `${process.cwd()}/publish-probe9v-output.txt`;
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
  if (u.includes('ejobmanage.pc.ejobinfomaintain')) {
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
log('## 编辑页就绪: ' + fresh.url().slice(0, 90));

// 找"更新职位"按钮
const btn = await fresh.evaluate(() => {
  const b = Array.from(document.querySelectorAll('button')).find((x) => (x.textContent || '').trim() === '更新职位');
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, disabled: b.disabled };
});
log('## 更新职位按钮: ' + JSON.stringify(btn));
if (!btn) { fs.writeFileSync(OUT, lines.join('\n'), 'utf8'); process.exit(0); }

await fresh.bringToFront();
await fresh.mouse.click(btn.x, btn.y);
log('## 已点击"更新职位"');
await new Promise((r) => setTimeout(r, 6000));

// 可能有确认弹窗,检查并点击确认类按钮
const confirmBtn = await fresh.evaluate(() => {
  const btns = Array.from(document.querySelectorAll('.ant-lpt-modal button, .ant-lpt-modal-root button, [class*="modal"] button, [class*="Modal"] button'));
  const labels = btns.map((b) => (b.textContent || '').trim());
  const ok = btns.find((b) => /确定|确认|继续|更新/.test((b.textContent || '').trim()));
  if (ok) {
    const r = ok.getBoundingClientRect();
    return { labels, found: (ok.textContent || '').trim(), x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }
  return { labels, found: null };
});
log('## 弹窗按钮: ' + JSON.stringify(confirmBtn));
if (confirmBtn.found) {
  await fresh.mouse.click(confirmBtn.x, confirmBtn.y);
  log('## 已点击确认: ' + confirmBtn.found);
  await new Promise((r) => setTimeout(r, 10000));
}

await new Promise((r) => setTimeout(r, 6000));

// 输出捕获
for (const c of captured) {
  log('\n## ===== 捕获请求: ' + c.url + ' =====');
  const params = new URLSearchParams(c.body);
  log('saveInfoExtVo: ' + params.get('saveInfoExtVo'));
  const vo = params.get('ejobSaveInputVo');
  if (vo) {
    const obj = JSON.parse(vo);
    log('### ejobSaveInputVo 共 ' + Object.keys(obj).length + ' 字段:');
    for (const [k, v] of Object.entries(obj)) {
      const vs = typeof v === 'string' && v.length > 55 ? v.slice(0, 55) + '...' : JSON.stringify(v);
      log(`  ${k}: ${vs}`);
    }
  }
}
if (captured.length === 0) {
  log('\n## 未捕获请求, 页面状态:');
  const st = await fresh.evaluate(() => ({ url: location.href, text: document.body.innerText.slice(0, 400) })).catch(() => null);
  log(JSON.stringify(st));
}

fs.writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log('\n>>> 输出: ' + OUT);
cdp.disconnect();
