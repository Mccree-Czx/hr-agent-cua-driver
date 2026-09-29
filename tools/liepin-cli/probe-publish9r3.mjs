/**
 * 探测 9r3:清理旧标签 → 点击编辑 → 精确跟踪新标签页 → 表单渲染 → 保存抓 payload
 */
import { CdpBrowser } from './dist/browser/cdp_browser.js';
import { setPageRuntime } from './dist/common/lpt-utils.js';
import fs from 'node:fs';

const OUT = `${process.cwd()}/publish-probe9r3-output.txt`;
const lines = [];
const log = (s) => { console.log(String(s).slice(0, 300)); lines.push(String(s)); };

const cdp = new CdpBrowser();
const page = await cdp.launch();
const browser = cdp.getBrowser();

// 0. 关掉除当前外的所有标签
let pages = await browser.pages();
for (let i = 1; i < pages.length; i++) {
  await pages[i].close().catch(() => {});
}
log(`## 清理后标签数: ${(await browser.pages()).length}`);

let newTab = null;
let savedPayload = null;

browser.on('targetcreated', async (target) => {
  if (target.type() !== 'page') return;
  try {
    const p = await target.page();
    if (!p) return;
    log('!! 新标签页创建: ' + p.url().slice(0, 100));
    newTab = p;
    p.on('request', (req) => {
      const u = req.url();
      if (u.includes('save-ejob-draft') || u.includes('update-ejob') || u.includes('publish-ejob')) {
        savedPayload = { url: u, body: req.postData() || '' };
        log('!! 捕获保存请求: ' + u);
      }
    });
  } catch (e) { log('new tab 处理: ' + e.message.slice(0, 80)); }
});

// 1. 管理页
await setPageRuntime(page, false);
await page.goto('https://lpt.liepin.com/job/manager', { waitUntil: 'networkidle2', timeout: 40000 });
await setPageRuntime(page, true);
await new Promise((r) => setTimeout(r, 5000));
await page.bringToFront();
log('## 管理页就绪: ' + page.url());

// 2. 点击编辑图标
const pos = await page.evaluate(() => {
  const el = document.querySelector('.antlpticon-edit');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
log('## 编辑图标: ' + JSON.stringify(pos));
await page.mouse.click(pos.x, pos.y);

// 3. 等新标签稳定(不 evaluate 新 tab)
await new Promise((r) => setTimeout(r, 12000));
log('## 12s 后新标签 URL: ' + (newTab ? newTab.url().slice(0, 100) : '(无新标签)'));

if (newTab) {
  await newTab.bringToFront();
  // 再等 10 秒让 React 渲染(全程不碰新标签的 evaluate)
  await new Promise((r) => setTimeout(r, 10000));
  log('## 22s 后新标签 URL: ' + newTab.url().slice(0, 100));

  // 一次性 evaluate:拿表单概况 + 保存按钮坐标
  try {
    const info = await newTab.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input,textarea')).slice(0, 30).map((el) => ({
        cls: (el.className || '').toString().slice(0, 40),
        value: String(el.value || '').slice(0, 25),
        placeholder: el.placeholder || '',
      }));
      const buttons = Array.from(document.querySelectorAll('button')).map((b) => {
        const r = b.getBoundingClientRect();
        return { text: (b.textContent || '').trim().slice(0, 12), x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };
      }).filter((b) => b.text);
      return { url: location.href, inputs: inputs.length, inputsSample: inputs, buttons, bodyLen: document.body.innerText.length };
    });
    log(`\n## 表单: url=${info.url.slice(0, 70)} inputs=${info.inputs} bodyLen=${info.bodyLen}`);
    log('## 输入框样例:\n' + JSON.stringify(info.inputsSample, null, 1).slice(0, 1800));
    log('## 按钮: ' + JSON.stringify(info.buttons));

    const save = info.buttons.find((b) => b.text === '保存');
    if (save && info.inputs > 5) {
      await newTab.mouse.click(save.x, save.y);
      log('## 已点击保存(原值回写)...');
      await new Promise((r) => setTimeout(r, 12000));
    }
  } catch (e) {
    log('## 新标签已不可用: ' + e.message.slice(0, 100));
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
} else if (newTab) {
  log('\n## 未捕获保存请求');
}

fs.writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log('\n>>> 输出: ' + OUT);
cdp.disconnect();
