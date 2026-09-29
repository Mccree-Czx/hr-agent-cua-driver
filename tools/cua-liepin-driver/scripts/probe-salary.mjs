/**
 * 薪资下拉展开探测(W5):多点位点击 → name-set 差集找新节点 → 输出选项。
 *
 * 用法: node scripts/probe-salary.mjs
 */

import { loadConfigFromEnv } from "../dist/config.js";
import { DriverClient } from "../dist/cua/driver-client.js";
import { attachBrowserSession, snapshot } from "../dist/cua/session.js";

const cfg = loadConfigFromEnv();
const client = new DriverClient({ bin: cfg.bin, session: cfg.session, timeoutMs: cfg.callTimeoutMs });
const session = await attachBrowserSession(client, cfg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const keyOf = (r) => `${r.role}|${r.name ?? ""}|${r.visibility ?? ""}`;

const before = await snapshot(client, session);
const beforeSet = new Set(before.refs.map(keyOf));
console.log(`[前] refs=${before.refs.length}`);

const points = [
  [455, 273],
  [422, 273],
  [420, 278],
  [455, 278],
];
for (const [x, y] of points) {
  const res = await client.callTool("browser_click", {
    target_id: session.targetId,
    tab_id: session.activeTabId,
    x,
    y,
  });
  await sleep(900);
  const after = await snapshot(client, session);
  const fresh = after.refs.filter((r) => !beforeSet.has(keyOf(r)) && r.name !== null && r.name.length <= 16);
  console.log(`(${x},${y}) status=${res.status} refs=${after.refs.length} 新节点=${fresh.length}`);
  if (fresh.length > 0) {
    for (const r of fresh.slice(0, 30)) {
      console.log(`  ${r.ref} ${r.role} [${r.visibility ?? "?"}] [${r.actions.join(",")}] ${JSON.stringify(r.name)}`);
    }
    console.log("[结果] 命中点位 " + `(${x},${y})`);
    process.exit(0);
  }
}
console.log("[结果] 未展开");
