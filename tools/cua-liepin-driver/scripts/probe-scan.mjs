/**
 * 工作经验下拉 y 轴扫描(W5):x=500 固定,y 逐档点击,检查是否出现年限选项。
 *
 * 用法: node scripts/probe-scan.mjs [x] [y1 y2 y3 ...]
 */

import { loadConfigFromEnv } from "../dist/config.js";
import { DriverClient } from "../dist/cua/driver-client.js";
import { attachBrowserSession, snapshot } from "../dist/cua/session.js";

const rawArgs = process.argv.slice(2);
const x = Number.parseFloat(rawArgs[0] ?? "500");
const patternArg = rawArgs.slice(1).find((a) => Number.isNaN(Number(a)));
const optionRe = new RegExp(patternArg ?? "^(不限|1年以下|[0-9]+-[0-9]+年|[0-9]+年以上)$");
const ys = rawArgs
  .slice(1)
  .filter((a) => !Number.isNaN(Number(a)))
  .map(Number);
const list = ys.length > 0 ? ys : [100, 110, 120, 130, 140, 150, 160, 170];

const cfg = loadConfigFromEnv();
const client = new DriverClient({ bin: cfg.bin, session: cfg.session, timeoutMs: cfg.callTimeoutMs });
const session = await attachBrowserSession(client, cfg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const y of list) {
  const res = await client.callTool("browser_click", {
    target_id: session.targetId,
    tab_id: session.activeTabId,
    x,
    y,
  });
  await sleep(900);
  const snap = await snapshot(client, session);
  const years = snap.refs.filter(
    (r) => r.name !== null && r.name.length <= 12 && optionRe.test(r.name),
  );
  const focusHit = snap.refs.find((r) => r.name !== null && /工作经验要求|请选择/.test(r.name) && r.name.length <= 12);
  console.log(`(${x},${y}) status=${res.status} refs=${snap.refs.length} 年限选项=${years.length} ${years.map((r) => r.name).join("|")}`);
  if (years.length > 0) {
    for (const r of years) console.log(`  ✓ ${r.ref} ${r.role} [${r.visibility}] ${r.name}`);
    console.log("[结果] 命中! y=" + y);
    process.exit(0);
  }
}
console.log("[结果] 未命中");
