/**
 * 填写薪资(W5):UIA 定位 rc_select_4/rc_select_6 → 点击 → 观察选项 →
 * 选目标值 → 同法最高月薪。
 *
 * 用法: node scripts/probe-fill-salary.mjs [最低] [最高]
 */

import { loadConfigFromEnv } from "../dist/config.js";
import { DriverClient } from "../dist/cua/driver-client.js";
import { attachBrowserSession, clickRef, snapshot } from "../dist/cua/session.js";

const low = process.argv[2] ?? "15K";
const high = process.argv[3] ?? "30K";

const cfg = loadConfigFromEnv();
const client = new DriverClient({ bin: cfg.bin, session: cfg.session, timeoutMs: cfg.callTimeoutMs });
const session = await attachBrowserSession(client, cfg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const keyOf = (r) => `${r.role}|${r.name ?? ""}|${r.visibility ?? ""}`;

async function uiaFrame(label) {
  const state = await client.requireOk("get_window_state", {
    pid: session.window.pid,
    window_id: session.window.windowId,
    max_elements: 600,
  });
  const elements = Array.isArray(state.elements) ? state.elements : [];
  const hit = elements.find((e) => typeof e.label === "string" && e.label === label);
  return hit === undefined ? null : hit.frame;
}

async function openAndList(label) {
  const f = await uiaFrame(label);
  if (f === null) {
    console.log(`[${label}] UIA 未找到`);
    return null;
  }
  const cssX = (f.x + f.w / 2) / 2;
  const cssY = (f.y + f.h / 2 - 286) / 2;
  console.log(`[${label}] frame=(${f.x},${f.y}) → CSS(${cssX},${cssY})`);
  const before = await snapshot(client, session);
  const beforeSet = new Set(before.refs.map(keyOf));
  await client.callTool("browser_click", { target_id: session.targetId, tab_id: session.activeTabId, x: cssX, y: cssY });
  await sleep(1_000);
  const after = await snapshot(client, session);
  const fresh = after.refs.filter((r) => !beforeSet.has(keyOf(r)) && r.name !== null && r.name.length <= 16);
  console.log(`[${label}] 新节点=${fresh.length}`);
  for (const r of fresh.slice(0, 35)) {
    console.log(`  ${r.ref} ${r.role} [${r.visibility ?? "?"}] [${r.actions.join(",")}] ${JSON.stringify(r.name)}`);
  }
  return { after, fresh };
}

let r = await openAndList("rc_select_4");
if (r !== null && r.fresh.length > 0) {
  const opt = r.fresh.find((x) => x.name === low && x.actions.includes("click")) ?? r.fresh.find((x) => x.name === low);
  if (opt !== undefined) {
    console.log(`[选低] ${opt.ref} ${opt.name}`);
    await clickRef(client, session, opt.ref);
    await sleep(900);
  } else {
    console.log(`[选低] 未见「${low}」`);
  }
}

r = await openAndList("rc_select_6");
if (r !== null && r.fresh.length > 0) {
  const opt = r.fresh.find((x) => x.name === high && x.actions.includes("click")) ?? r.fresh.find((x) => x.name === high);
  if (opt !== undefined) {
    console.log(`[选高] ${opt.ref} ${opt.name}`);
    await clickRef(client, session, opt.ref);
    await sleep(900);
  } else {
    console.log(`[选高] 未见「${high}」`);
  }
}

const fin = await snapshot(client, session);
const shown = fin.refs.filter((x) => x.name !== null && /K$/.test(x.name) && x.name.length <= 6);
console.log(`[回显] ${shown.map((x) => x.name).join(" | ")}`);
