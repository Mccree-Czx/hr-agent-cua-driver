/**
 * UIA 定位字段并点击(W5):get_window_state 找元素 → 物理坐标换算 CSS →
 * 立即 browser_click → 快照列选项。
 *
 * 用法: node scripts/probe-uia-field.mjs <label包含> [选项pattern]
 *   CSS 公式:x/2, (y-286)/2(内容区原点 286 物理,DPR=2)
 */

import { loadConfigFromEnv } from "../dist/config.js";
import { DriverClient } from "../dist/cua/driver-client.js";
import { attachBrowserSession, snapshot } from "../dist/cua/session.js";

const labelArg = process.argv[2] ?? "rc_select_4";
const pattern = new RegExp(process.argv[3] ?? "^[0-9]+[Kk]$");

const cfg = loadConfigFromEnv();
const client = new DriverClient({ bin: cfg.bin, session: cfg.session, timeoutMs: cfg.callTimeoutMs });
const session = await attachBrowserSession(client, cfg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1) UIA 实时快照
const state = await client.requireOk("get_window_state", {
  pid: session.window.pid,
  window_id: session.window.windowId,
  max_elements: 600,
});
const elements = Array.isArray(state.elements) ? state.elements : [];
const hit = elements.find((e) => typeof e.label === "string" && e.label.includes(labelArg) && e.in_web_content === true);
if (hit === undefined) {
  console.log(`[UIA] 未找到 label 含「${labelArg}」的元素`);
  const cands = elements.filter((e) => typeof e.label === "string" && e.label.length > 0).slice(0, 40);
  for (const c of cands) console.log(`  ${c.role} ${JSON.stringify(c.label)}`);
  process.exit(1);
}
const f = hit.frame;
const cssX = (f.x + f.w / 2) / 2;
const cssY = (f.y + f.h / 2 - 286) / 2;
console.log(`[UIA] ${hit.role} label=${JSON.stringify(hit.label)} frame=(${f.x},${f.y}) ${f.w}x${f.h} → CSS(${cssX},${cssY})`);

// 2) 立即点击
const res = await client.callTool("browser_click", {
  target_id: session.targetId,
  tab_id: session.activeTabId,
  x: cssX,
  y: cssY,
});
console.log(`[点击] status=${res.status} ${res.refusalCode ?? ""}`);
await sleep(1_200);

// 3) 快照列选项
const snap = await snapshot(client, session);
const opts = snap.refs.filter((r) => r.name !== null && r.name.length <= 12 && pattern.test(r.name));
console.log(`[选项匹配] ${opts.length}`);
for (const r of opts.slice(0, 30)) {
  console.log(`  ${r.ref} ${r.role} [${r.visibility ?? "?"}] [${r.actions.join(",")}] ${r.name}`);
}
