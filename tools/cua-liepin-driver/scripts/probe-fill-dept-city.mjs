/**
 * 填写所属部门+工作地址(W5):UIA 定位部门 → 点击 → 看选项;
 * 城市 textbox → browser_type → 看建议 → 点选。
 *
 * 用法: node scripts/probe-fill-dept-city.mjs [城市]
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

// ---------- 1) 所属部门 ----------
const state = await client.requireOk("get_window_state", {
  pid: session.window.pid,
  window_id: session.window.windowId,
  max_elements: 600,
});
const elements = Array.isArray(state.elements) ? state.elements : [];
const dept = elements.find((e) => typeof e.label === "string" && e.role === "ComboBox" && e.label.includes("所属部门"));
if (dept !== undefined) {
  const f = dept.frame;
  const cssX = (f.x + f.w / 2) / 2;
  const cssY = (f.y + f.h / 2 - 286) / 2;
  console.log(`[部门] ${dept.role} label=${JSON.stringify(dept.label)} frame=(${f.x},${f.y}) → CSS(${cssX},${cssY})`);
  const before = await snapshot(client, session);
  const beforeSet = new Set(before.refs.map(keyOf));
  await client.callTool("browser_click", { target_id: session.targetId, tab_id: session.activeTabId, x: cssX, y: cssY });
  await sleep(1_000);
  const after = await snapshot(client, session);
  const fresh = after.refs.filter((r) => !beforeSet.has(keyOf(r)) && r.name !== null && r.name.length <= 20);
  console.log(`[部门] 新节点=${fresh.length}`);
  for (const r of fresh.slice(0, 30)) {
    console.log(`  ${r.ref} ${r.role} [${r.visibility ?? "?"}] [${r.actions.join(",")}] ${JSON.stringify(r.name)}`);
  }
  // 若有选项,点第一个可点的
  const opt = fresh.find((r) => r.actions.includes("click") && r.role !== "link");
  if (opt !== undefined) {
    console.log(`[部门] 选 ${opt.ref} ${JSON.stringify(opt.name)}`);
    await clickRef(client, session, opt.ref);
    await sleep(800);
  }
} else {
  console.log("[部门] UIA 未找到(列出候选)");
  for (const e of elements.filter((x) => typeof x.label === "string" && /select|部门/.test(x.label)).slice(0, 15)) {
    console.log(`  ${e.role} ${JSON.stringify(e.label)}`);
  }
}

// ---------- 2) 工作地址(城市) ----------
let snap = await snapshot(client, session);
let cityBox = snap.refs.find((r) => r.name !== null && r.name.includes("城市") && r.actions.includes("type"));
if (cityBox === undefined) {
  console.log("[城市] 未找到城市输入框");
} else {
  if (cityBox.visibility !== "in_viewport" && cityBox.visibility !== "near_viewport") {
    console.log(`[城市] 先点击滚动到可见(${cityBox.visibility})`);
    try {
      await clickRef(client, session, cityBox.ref);
      await sleep(1_200);
      snap = await snapshot(client, session);
      cityBox = snap.refs.find((r) => r.name !== null && r.name.includes("城市") && r.actions.includes("type"));
    } catch (err) {
      console.log(`[城市] 点击滚动失败: ${String(err).slice(0, 120)}`);
    }
  }
  if (cityBox === undefined || (cityBox.visibility !== "in_viewport" && cityBox.visibility !== "near_viewport")) {
    console.log("[城市] 仍不可见,放弃输入");
  } else {
    console.log(`[城市] ${cityBox.ref} [${cityBox.visibility}]`);
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
  const sugg = after2.refs.filter((r) => r.name !== null && r.name.includes(city) && r.name.length <= 20 && r.actions.includes("click"));
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
}
