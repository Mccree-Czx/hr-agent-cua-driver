/**
 * 探测 8e:验证"Runtime 域开启"是否是自爆触发条件
 * 步骤:关 Runtime → 导航编辑页 → 观察存活 → 开 Runtime → 观察是否自爆
 */
import { CdpBrowser } from './dist/browser/cdp_browser.js';
import { setPageRuntime } from './dist/common/lpt-utils.js';
import fs from 'node:fs';

const OUT = `${process.cwd()}/publish-probe8e-output.txt`;
const lines = [];
const log = (s) => { console.log(String(s).slice(0, 250)); lines.push(String(s)); };

const cdp = new CdpBrowser();
const page = await cdp.launch();
const browser = cdp.getBrowser();
const fresh = await browser.newPage();

const EDIT_URL = 'https://lpt.liepin.com/job/publish?ejobId=85027561&ejobActionType=edit';

// 阶段1:关 Runtime 后导航,保持 10 秒
await setPageRuntime(fresh, false);
await fresh.goto(EDIT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
log('## goto 完成(runtime off): ' + fresh.url().slice(0, 80));
for (let i = 1; i <= 5; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  log(`  [off ${i * 2}s] url=${fresh.url().slice(0, 80)}`);
}

// 阶段2:开 Runtime,观察 8 秒
await setPageRuntime(fresh, true);
log('\n## Runtime 已开启,观察...');
for (let i = 1; i <= 4; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  log(`  [on ${i * 2}s] url=${fresh.url().slice(0, 80)}`);
}

await fresh.close().catch(() => {});
fs.writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log('\n>>> 输出: ' + OUT);
cdp.disconnect();
