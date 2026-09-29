/**
 * 城市专步(W5):UIA 定位城市框 → 点击聚焦 → browser_type → 建议选择。
 *
 * 用法: node scripts/probe-fill-city.mjs [城市]
 */

import { loadConfigFromEnv } from "../dist/config.js";
import { DriverClient } from "../dist/cua/driver-client.js";
import { attachBrowserSession, clickRef, snapshot } from "../dist/cua/session.js";

const city = process.argv[2] ?? "上海";
const cfg = loadConfigFromEnv();
const client = new DriverClient({ bin: cfg.bin, session: cfg.session, timeoutMs: cfg.callTimeoutMs });
const session = await attachBrowserSession(client, cfg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// UIA 定位城市框
const state = await client.requireOk("get_window_state", {
  pid: session.window.pid,
  window_id: session.window.windowId,
  max_elements: 600,
});
const elements = Array.isArray(state.elements) ? state.elements : [];
const cityNode = elements.find((e) => typeof e.label === "string" && e.label.includes("请仔细选择城市"));
if (cityNode === undefined) {
  console.log("UIA 未找到城市框;列出 Edit 候选:");
  for (const e of elements.filter((x) => x.role === "Edit" || x.role === "ComboBox").slice(0, 20)) {
    console.log(`  ${e.role} ${JSON.stringify(e.label)} frame=(${e.frame?.x},${e.frame?.y})`);
  }
  process.exit(1);
}
const f = cityNode.frame;
const cssX = (f.x + f.w / 2) / 2;
const cssY = (f.y + f.h / 2 - 286) / 2;
console.log(`[城市框] ${cityNode.role} frame=(${f.x},${f.y}) → CSS(${cssX},${cssY})`);
await client.callTool("browser_click", { target_id: session.targetId, tab_id: session.activeTabId, x: cssX, y: cssY });
await sleep(900);

let snap = await snapshot(client, session);
let box = snap.refs.find((r) => r.name !== null && r.name.includes("城市") && r.actions.includes("type"));
console.log(`[semantic] ${box === undefined ? "未找到" : box.ref + " [" + box.visibility + "]"}`);
if (box === undefined) {
  process.exit(1);
}
let res = await client.callTool("browser_type", { target_id: session.targetId, tab_id: session.activeTabId, ref: box.ref, text: city, replace: true }).catch((e) => ({ status: "error", refusalMessage: String(e).slice(0, 140) }));
console.log(`[写入] ${res.status} ${res.refusalCode ?? ""} ${res.refusalMessage ?? ""}`);
if (res.status !== "ok") {
  // 再点一次聚焦后重试
  await client.callTool("browser_click", { target_id: session.targetId, tab_id: session.activeTabId, x: cssX, y: cssY });
  await sleep(800);
  snap = await snapshot(client, session);
  box = snap.refs.find((r) => r.name !== null && r.name.includes("城市") && r.actions.includes("type")) ?? box;
  res = await client.callTool("browser_type", { target_id: session.targetId, tab_id: session.activeTabId, ref: box.ref, text: city, replace: true }).catch((e) => ({ status: "error", refusalMessage: String(e).slice(0, 140) }));
  console.log(`[重试写入] ${res.status} ${res.refusalCode ?? ""} ${res.refusalMessage ?? ""}`);
}
await sleep(1_200);

const after = await snapshot(client, session);
const sugg = after.refs.filter((r) => r.name !== null && r.name.includes(city) && r.name.length <= 24 && r.actions.includes("click"));
console.log(`[建议] ${sugg.length}: ${sugg.slice(0, 8).map((r) => r.name).join(" | ")}`);
const pick = sugg.find((r) => r.name === city) ?? sugg[0];
if (pick !== undefined) {
  await clickRef(client, session, pick.ref);
  await sleep(900);
  const fin = await snapshot(client, session);
  const shown = fin.refs.find((r) => r.name !== null && r.name.includes(city));
  console.log(`[结果] ${shown !== undefined ? "✓ " + JSON.stringify(shown.name) : "? 未见回显"}`);
}
