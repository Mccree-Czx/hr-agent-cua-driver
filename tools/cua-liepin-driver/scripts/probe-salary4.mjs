/**
 * 薪资下拉展开实验#4(W5):点 offscreen「招聘人数」自动滚到薪资区 →
 * UIA 重定位 rc_select_4(视口内) → 点击 → ArrowDown → 验证。单脚本全程。
 *
 * 用法: node scripts/probe-salary4.mjs
 */

import { loadConfigFromEnv } from "../dist/config.js";
import { DriverClient } from "../dist/cua/driver-client.js";
import { attachBrowserSession, clickRef, snapshot } from "../dist/cua/session.js";

const cfg = loadConfigFromEnv();
const client = new DriverClient({ bin: cfg.bin, session: cfg.session, timeoutMs: cfg.callTimeoutMs });
const session = await attachBrowserSession(client, cfg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const keyOf = (r) => `${r.role}|${r.name ?? ""}|${r.visibility ?? ""}`;

// 1) 点「招聘人数」(offscreen)→ 浏览器滚动到该行
const snap0 = await snapshot(client, session);
const headcount = snap0.refs.find((r) => r.name !== null && r.name.includes("招聘人数"));
if (headcount === undefined) {
  console.log("未找到招聘人数节点");
  process.exit(1);
}
console.log(`[招聘人数] ${headcount.ref} [${headcount.visibility}]`);
await clickRef(client, session, headcount.ref);
await sleep(1_500);

// 2) UIA 重定位 rc_select_4
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
console.log(`[UIA] rc_select_4 frame=(${f.x},${f.y}) → CSS(${cssX},${cssY}) ${cssY > 770 ? "(仍在视口外!)" : ""}`);

const before = await snapshot(client, session);
const beforeSet = new Set(before.refs.map(keyOf));

// 3) 点击 + ArrowDown
await client.callTool("browser_click", { target_id: session.targetId, tab_id: session.activeTabId, x: cssX, y: cssY });
await sleep(700);
const res = await client.callTool("press_key", { pid: session.window.pid, key: "ArrowDown", delivery_mode: "foreground" });
console.log(`[ArrowDown] status=${res.status} ${res.refusalCode ?? ""}`);
await sleep(1_000);

const after = await snapshot(client, session);
const fresh = after.refs.filter((r) => !beforeSet.has(keyOf(r)) && r.name !== null && r.name.length <= 16);
console.log(`[after] refs=${after.refs.length} 新=${fresh.length}`);
for (const r of fresh.slice(0, 35)) {
  console.log(`  ${r.ref} ${r.role} [${r.visibility ?? "?"}] ${JSON.stringify(r.name)}`);
}
