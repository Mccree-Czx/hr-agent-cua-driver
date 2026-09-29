/**
 * 薪资下拉展开实验#2(W5):聚焦后尝试 键盘/Enter/UIA click 组合。
 *
 * 用法: node scripts/probe-salary2.mjs
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

async function check(tag) {
  await sleep(900);
  const after = await snapshot(client, session);
  const fresh = after.refs.filter((r) => !beforeSet.has(keyOf(r)) && r.name !== null && r.name.length <= 16);
  console.log(`${tag} → refs=${after.refs.length} 新节点=${fresh.length}`);
  for (const r of fresh.slice(0, 25)) {
    console.log(`  ${r.ref} ${r.role} [${r.visibility ?? "?"}] ${JSON.stringify(r.name)}`);
  }
  return fresh.length > 0;
}

// 聚焦
await client.callTool("browser_click", { target_id: session.targetId, tab_id: session.activeTabId, x: 422, y: 273 });
await sleep(600);

// 1) ArrowDown(foreground:Chromium 丢弃 background 键击)
let res = await client.callTool("press_key", { pid: session.window.pid, key: "ArrowDown", delivery_mode: "foreground" });
console.log(`[ArrowDown] status=${res.status} ${res.refusalCode ?? ""}`);
if (await check("arrowdown")) process.exit(0);

// 2) Enter
res = await client.callTool("press_key", { pid: session.window.pid, key: "Enter", delivery_mode: "foreground" });
console.log(`[Enter] status=${res.status} ${res.refusalCode ?? ""}`);
if (await check("enter")) process.exit(0);

// 3) UIA click(element_token)
const state = await client.requireOk("get_window_state", {
  pid: session.window.pid,
  window_id: session.window.windowId,
  max_elements: 600,
});
const elements = Array.isArray(state.elements) ? state.elements : [];
const combo = elements.find((e) => typeof e.label === "string" && e.label === "rc_select_4");
if (combo !== undefined) {
  console.log(`[UIA] ${combo.element_token} actions=[${(combo.actions ?? []).join(",")}]`);
  res = await client.callTool("click", {
    pid: session.window.pid,
    window_id: session.window.windowId,
    element_token: combo.element_token,
  });
  console.log(`[UIA click] status=${res.status} ${res.refusalCode ?? ""}`);
  if (await check("uia-click")) process.exit(0);
}
console.log("[结果] 均未展开");
