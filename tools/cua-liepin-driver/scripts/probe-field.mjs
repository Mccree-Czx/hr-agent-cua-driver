/**
 * 通用下拉/输入字段探查(W5):点击坐标 → 列出候选选项节点。
 *
 * 用法: node scripts/probe-field.mjs <x> <y> [pattern]
 *   pattern: 选项关键词正则(默认 不限|年|本科|大专|硕士|千|万|K)
 */

import { loadConfigFromEnv } from "../dist/config.js";
import { DriverClient } from "../dist/cua/driver-client.js";
import { attachBrowserSession, snapshot } from "../dist/cua/session.js";

const x = Number.parseFloat(process.argv[2] ?? "0");
const y = Number.parseFloat(process.argv[3] ?? "0");
const pattern = new RegExp(process.argv[4] ?? "不限|年|本科|大专|硕士|博士|K|k|万|千|部|中心|市|区");

const cfg = loadConfigFromEnv();
const client = new DriverClient({ bin: cfg.bin, session: cfg.session, timeoutMs: cfg.callTimeoutMs });
const session = await attachBrowserSession(client, cfg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const before = await snapshot(client, session);
const beforeRefs = new Set(before.refs.map((r) => r.ref));
console.log(`[前] refs=${before.refs.length}`);

const res = await client.callTool("browser_click", {
  target_id: session.targetId,
  tab_id: session.activeTabId,
  x,
  y,
});
console.log(`[点击] (${x},${y}) status=${res.status} ${res.refusalCode ?? ""}`);
await sleep(1_200);

const after = await snapshot(client, session);
console.log(`[后] refs=${after.refs.length}`);
const fresh = after.refs.filter((r) => !beforeRefs.has(r.ref));
console.log(`--- 新增节点(${fresh.length}) ---`);
for (const r of fresh.slice(0, 40)) {
  console.log(`  ${r.ref} ${r.role} [${r.visibility ?? "?"}] [${r.actions.join(",")}] ${JSON.stringify(r.name)?.slice(0, 50)}`);
}
console.log("--- 匹配 pattern 节点 ---");
const hits = after.refs.filter((r) => r.name !== null && r.name.length <= 30 && pattern.test(r.name));
for (const r of hits.slice(0, 40)) {
  console.log(`  ${r.ref} ${r.role} [${r.visibility ?? "?"}] [${r.actions.join(",")}] ${JSON.stringify(r.name)}`);
}
