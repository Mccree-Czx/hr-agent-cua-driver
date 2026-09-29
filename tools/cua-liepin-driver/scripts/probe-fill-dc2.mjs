/**
 * 填写部门(双击防旧下拉)+工作地址(scroll 到底部)(W5)。
 *
 * 用法: node scripts/probe-fill-dc2.mjs [城市]
 */

import { loadConfigFromEnv } from "../dist/config.js";
import { DriverClient } from "../dist/cua/driver-client.js";
import { attachBrowserSession, clickRef, snapshot } from "../dist/cua/session.js";

const city = process.argv[2] ?? "上海";
const cfg = loadConfigFromEnv();
const client = new DriverClient({ bin: cfg.bin, session: cfg.session, timeoutMs: cfg.callTimeoutMs });
const session = await attachBrowserSession(client, cfg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const keyOf = (r) => `${r.role}|${r.name ?? ""}|${r.visibility ?? ""}`;

// 0) 点空白关旧下拉
await client.callTool("browser_click", { target_id: session.targetId, tab_id: session.activeTabId, x: 1200, y: 720 });
await sleep(600);

// 1) 部门:直接向 ComboBox 输入文本(有 type 能力;输入后看联想)
const state = await client.requireOk("get_window_state", {
  pid: session.window.pid,
  window_id: session.window.windowId,
  max_elements: 600,
});
const elements = Array.isArray(state.elements) ? state.elements : [];
const dept = elements.find((e) => typeof e.label === "string" && e.role === "ComboBox" && e.label.includes("所属部门"));
if (dept === undefined) {
  console.log("[部门] UIA 未找到");
} else {
  const f = dept.frame;
  const cssX = (f.x + f.w / 2) / 2;
  const cssY = (f.y + f.h / 2 - 286) / 2;
  console.log(`[部门] frame=(${f.x},${f.y}) → CSS(${cssX},${cssY})`);
  // 先点击聚焦(确保下拉上下文),再找 semantic 里所属部门 combobox 的 ref 输入
  await client.callTool("browser_click", { target_id: session.targetId, tab_id: session.activeTabId, x: cssX, y: cssY });
  await sleep(800);
  const snapD = await snapshot(client, session);
  const deptBox = snapD.refs.find((r) => r.role === "combobox" && r.name !== null && r.name.includes("所属部门"));
  if (deptBox === undefined) {
    console.log("[部门] semantic 未找到 combobox");
  } else {
    const res = await client.callTool("browser_type", {
      target_id: session.targetId,
      tab_id: session.activeTabId,
      ref: deptBox.ref,
      text: "销售部",
      replace: true,
    });
    console.log(`[部门写入] status=${res.status} ${res.refusalCode ?? ""}`);
    await sleep(1_000);
    const afterD = await snapshot(client, session);
    const sugg = afterD.refs.filter((r) => r.name !== null && r.name.includes("销售") && r.name.length <= 24 && r.actions.includes("click"));
    console.log(`[部门联想] ${sugg.length}`);
    for (const r of sugg.slice(0, 10)) console.log(`  ${r.ref} ${r.role} ${JSON.stringify(r.name)}`);
    const pickD = sugg.find((r) => r.name === "销售部") ?? sugg[0];
    if (pickD !== undefined) {
      await clickRef(client, session, pickD.ref);
      await sleep(800);
      console.log(`[部门选] ${pickD.ref} ${JSON.stringify(pickD.name)}`);
    }
  }
}

// 2) 滚动到底部找城市
let scrolled;
try {
  scrolled = await client.callTool("scroll", { pid: session.window.pid, direction: "down", by: "page", amount: 2 });
  console.log(`[scroll] status=${scrolled.status} ${scrolled.refusalCode ?? ""}`);
} catch (err) {
  console.log(`[scroll] background 被拒,升级 foreground: ${String(err).slice(0, 100)}`);
  try {
    scrolled = await client.callTool("scroll", { pid: session.window.pid, direction: "down", by: "page", amount: 2, delivery_mode: "foreground" });
    console.log(`[scroll-fg] status=${scrolled.status}`);
  } catch (err2) {
    console.log(`[scroll-fg] 仍失败: ${String(err2).slice(0, 120)}`);
  }
}
await sleep(1_200);

let snap = await snapshot(client, session);
let cityBox = snap.refs.find((r) => r.name !== null && r.name.includes("城市") && r.actions.includes("type"));
console.log(`[城市] ${cityBox === undefined ? "未找到" : cityBox.ref + " [" + cityBox.visibility + "]"}`);
if (cityBox !== undefined && (cityBox.visibility === "in_viewport" || cityBox.visibility === "near_viewport")) {
  const res = await client.callTool("browser_type", {
    target_id: session.targetId,
    tab_id: session.activeTabId,
    ref: cityBox.ref,
    text: city,
    replace: true,
  });
  console.log(`[城市写入] status=${res.status} ${res.refusalCode ?? ""}`);
  await sleep(1_200);
  const after2 = await snapshot(client, session);
  const sugg = after2.refs.filter((r) => r.name !== null && r.name.includes(city) && r.name.length <= 24 && r.actions.includes("click"));
  console.log(`[城市建议] ${sugg.length}`);
  for (const r of sugg.slice(0, 12)) {
    console.log(`  ${r.ref} ${r.role} [${r.visibility ?? "?"}] ${JSON.stringify(r.name)}`);
  }
  const pick = sugg.find((r) => r.name === city) ?? sugg[0];
  if (pick !== undefined) {
    console.log(`[城市选] ${pick.ref} ${JSON.stringify(pick.name)}`);
    await clickRef(client, session, pick.ref);
    await sleep(900);
    const fin = await snapshot(client, session);
    const shown = fin.refs.find((r) => r.name !== null && r.name.includes(city));
    console.log(`[城市结果] ${shown !== undefined ? "✓ " + JSON.stringify(shown.name) : "? 未见回显"}`);
  }
}
