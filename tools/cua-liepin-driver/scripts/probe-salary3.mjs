/**
 * 薪资下拉展开实验#3(W5):单脚本内完成 UIA 定位→点击→ArrowDown→验证
 * (规避跨脚本的滚动漂移)。
 *
 * 用法: node scripts/probe-salary3.mjs
 */

import { loadConfigFromEnv } from "../dist/config.js";
import { DriverClient } from "../dist/cua/driver-client.js";
import { attachBrowserSession, snapshot } from "../dist/cua/session.js";

const cfg = loadConfigFromEnv();
const client = new DriverClient({ bin: cfg.bin, session: cfg.session, timeoutMs: cfg.callTimeoutMs });
const session = await attachBrowserSession(client, cfg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const keyOf = (r) => `${r.role}|${r.name ?? ""}|${r.visibility ?? ""}`;

// 先关可能存在的下拉(点页面空白;即使漂移点错也无碍)
await client.callTool("browser_click", { target_id: session.targetId, tab_id: session.activeTabId, x: 1200, y: 700 });
await sleep(500);

const before = await snapshot(client, session);
const beforeSet = new Set(before.refs.map(keyOf));
console.log(`[前] refs=${before.refs.length}`);

// UIA 定位 rc_select_4(最低月薪)
const state = await client.requireOk("get_window_state", {
  pid: session.window.pid,
  window_id: session.window.windowId,
  max_elements: 600,
});
const elements = Array.isArray(state.elements) ? state.elements : [];
const combo = elements.find((e) => typeof e.label === "string" && e.label === "rc_select_4");
if (combo === undefined) {
  console.log("未找到 rc_select_4");
  process.exit(1);
}
const f = combo.frame;
const cssX = (f.x + f.w / 2) / 2;
const cssY = (f.y + f.h / 2 - 286) / 2;
console.log(`[UIA] frame=(${f.x},${f.y}) → CSS(${cssX},${cssY})`);

// 点击聚焦 + 立即 ArrowDown(foreground)
await client.callTool("browser_click", { target_id: session.targetId, tab_id: session.activeTabId, x: cssX, y: cssY });
await sleep(700);
let res = await client.callTool("press_key", { pid: session.window.pid, key: "ArrowDown", delivery_mode: "foreground" });
console.log(`[ArrowDown] status=${res.status} ${res.refusalCode ?? ""}`);
await sleep(900);

let after = await snapshot(client, session);
let fresh = after.refs.filter((r) => !beforeSet.has(keyOf(r)) && r.name !== null && r.name.length <= 16);
console.log(`[after-down] refs=${after.refs.length} 新=${fresh.length}`);
for (const r of fresh.slice(0, 30)) {
  console.log(`  ${r.ref} ${r.role} [${r.visibility ?? "?"}] ${JSON.stringify(r.name)}`);
}

if (fresh.length === 0) {
  res = await client.callTool("press_key", { pid: session.window.pid, key: "Enter", delivery_mode: "foreground" });
  console.log(`[Enter] status=${res.status}`);
  await sleep(900);
  after = await snapshot(client, session);
  fresh = after.refs.filter((r) => !beforeSet.has(keyOf(r)) && r.name !== null && r.name.length <= 16);
  console.log(`[after-enter] refs=${after.refs.length} 新=${fresh.length}`);
  for (const r of fresh.slice(0, 30)) {
    console.log(`  ${r.ref} ${r.role} [${r.visibility ?? "?"}] ${JSON.stringify(r.name)}`);
  }
}
