/**
 * 填写工作经验+学历(W5,单脚本防漂移):
 * 点 offscreen 招聘人数滚动 → UIA 定位 detailWorkyear → 点击/ArrowDown →
 * 选 5-10年 → 同法 detailEdulevel → 选 本科。
 *
 * 用法: node scripts/probe-fill-edu.mjs
 */

import { loadConfigFromEnv } from "../dist/config.js";
import { DriverClient } from "../dist/cua/driver-client.js";
import { attachBrowserSession, clickRef, snapshot } from "../dist/cua/session.js";

const cfg = loadConfigFromEnv();
const client = new DriverClient({ bin: cfg.bin, session: cfg.session, timeoutMs: cfg.callTimeoutMs });
const session = await attachBrowserSession(client, cfg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function clickCss(x, y) {
  const res = await client.callTool("browser_click", { target_id: session.targetId, tab_id: session.activeTabId, x, y });
  return res.status === "ok";
}

async function findOption(text) {
  const snap = await snapshot(client, session);
  return (
    snap.refs.find(
      (r) => r.name === text && r.actions.includes("click") && (r.visibility === "in_viewport" || r.visibility === "near_viewport"),
    ) ??
    snap.refs.find((r) => r.name === text && r.actions.includes("click")) ??
    null
  );
}

// 0) 滚动到 02 区
const snap0 = await snapshot(client, session);
const hc = snap0.refs.find((r) => r.name !== null && r.name.includes("招聘人数"));
if (hc !== undefined) {
  await clickRef(client, session, hc.ref);
  await sleep(1_200);
}

// 1) 工作经验
let f = await uiaFrame("detailWorkyear");
if (f === null) {
  console.log("[经验] UIA 未找到 detailWorkyear");
} else {
  const cssX = (f.x + f.w / 2) / 2;
  const cssY = (f.y + f.h / 2 - 286) / 2;
  console.log(`[经验] frame=(${f.x},${f.y}) → CSS(${cssX},${cssY})`);
  await clickCss(cssX, cssY);
  await sleep(900);
  let opt = await findOption("5-10年");
  if (opt === null) {
    await client.callTool("press_key", { pid: session.window.pid, key: "ArrowDown", delivery_mode: "foreground" });
    await sleep(900);
    opt = await findOption("5-10年");
  }
  if (opt !== null) {
    console.log(`[经验选项] ${opt.ref} ${opt.name}`);
    await clickRef(client, session, opt.ref);
    await sleep(900);
    const chk = await snapshot(client, session);
    const ok = chk.refs.find((r) => r.name === "5-10年" && r.visibility !== "no_layout");
    console.log(`[经验结果] ${ok !== undefined ? "✓ 5-10年" : "? 未见回显"}`);
  } else {
    console.log("[经验] 未找到选项");
  }
}

// 2) 学历
f = await uiaFrame("detailEdulevel");
if (f === null) {
  console.log("[学历] UIA 未找到 detailEdulevel");
} else {
  const cssX = (f.x + f.w / 2) / 2;
  const cssY = (f.y + f.h / 2 - 286) / 2;
  console.log(`[学历] frame=(${f.x},${f.y}) → CSS(${cssX},${cssY})`);
  await clickCss(cssX, cssY);
  await sleep(900);
  let opt = await findOption("本科");
  if (opt === null) {
    await client.callTool("press_key", { pid: session.window.pid, key: "ArrowDown", delivery_mode: "foreground" });
    await sleep(900);
    opt = await findOption("本科");
  }
  if (opt !== null) {
    console.log(`[学历选项] ${opt.ref} ${opt.name}`);
    await clickRef(client, session, opt.ref);
    await sleep(900);
    const chk = await snapshot(client, session);
    const ok = chk.refs.find((r) => r.name === "本科" && r.visibility !== "no_layout");
    console.log(`[学历结果] ${ok !== undefined ? "✓ 本科" : "? 未见回显"}`);
  } else {
    console.log("[学历] 未找到选项");
  }
}
