/**
 * 发布表单一键填写(W5 整合):导航 → 名称+类别 → 描述 → 经验 → 学历 →
 * 薪资 → 部门 → 城市。每步带校验输出(单脚本防漂移)。
 *
 * 用法: node scripts/probe-fill-all.mjs
 */

import { loadConfigFromEnv } from "../dist/config.js";
import { DriverClient } from "../dist/cua/driver-client.js";
import { attachBrowserSession, clickRef, snapshot } from "../dist/cua/session.js";

const TITLE_KW = "销售";
const DESC = "【自动化测试职位】此岗位为系统联调临时创建,请勿投递。负责渠道拓展与客户维护。";
const CITY = "上海";

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

async function clickCss(f) {
  const res = await client.callTool("browser_click", {
    target_id: session.targetId,
    tab_id: session.activeTabId,
    x: (f.x + f.w / 2) / 2,
    y: (f.y + f.h / 2 - 286) / 2,
  });
  return res.status === "ok";
}

async function pickExact(text) {
  const snap = await snapshot(client, session);
  return (
    snap.refs.find((r) => r.name === text && r.actions.includes("click") && (r.visibility === "in_viewport" || r.visibility === "near_viewport")) ??
    snap.refs.find((r) => r.name === text && r.actions.includes("click")) ??
    null
  );
}

// 1) 导航
await client.requireOk("browser_navigate", {
  target_id: session.targetId,
  tab_id: session.activeTabId,
  url: "https://lpt.liepin.com/job/publish?ejobActionType=publish",
});
await sleep(4_000);
console.log("[1/8] 已导航发布页");

// 2) 名称+类别
let snap = await snapshot(client, session);
const nameBox = snap.refs.find((r) => r.role === "combobox" && r.actions.includes("type") && r.visibility === "in_viewport");
if (nameBox === undefined) {
  console.log("✗ 未找到名称框");
  process.exit(1);
}
await client.callTool("browser_type", { target_id: session.targetId, tab_id: session.activeTabId, ref: nameBox.ref, text: TITLE_KW, replace: true });
await sleep(1_200);
snap = await snapshot(client, session);
const pathOpt = snap.refs.find((r) => r.name !== null && r.name.includes("销售/客服") && r.actions.includes("click"));
if (pathOpt === undefined) {
  console.log("✗ 未找到推荐职位名称选项");
  process.exit(1);
}
await clickRef(client, session, pathOpt.ref);
await sleep(1_200);
const catOk = (await snapshot(client, session)).refs.some((r) => r.name !== null && r.name.includes("销售经理"));
console.log(`[2/8] 名称+类别 ${catOk ? "✓" : "?"} (${pathOpt.name})`);

// 3) 描述
await client.callTool("browser_click", { target_id: session.targetId, tab_id: session.activeTabId, x: 486, y: 353 });
await sleep(800);
snap = await snapshot(client, session);
const descBox = snap.refs.find((r) => r.actions.includes("type") && r.role === "generic" && r.visibility === "in_viewport");
if (descBox !== undefined) {
  await client.callTool("browser_type", { target_id: session.targetId, tab_id: session.activeTabId, ref: descBox.ref, text: DESC, replace: true });
  await sleep(900);
}
const descOk = (await snapshot(client, session)).refs.some((r) => r.name !== null && r.name.includes("自动化测试职位"));
console.log(`[3/8] 描述 ${descOk ? "✓" : "?"}`);

// 4) 滚动到 02 区
snap = await snapshot(client, session);
const hc = snap.refs.find((r) => r.name !== null && r.name.includes("招聘人数"));
if (hc !== undefined) {
  await clickRef(client, session, hc.ref);
  await sleep(1_200);
}
console.log("[4/8] 已滚动到职位要求区");

// 5) 经验
let f = await uiaFrame("detailWorkyear");
if (f !== null) {
  await clickCss(f);
  await sleep(900);
  let opt = await pickExact("5-10年");
  if (opt === null) {
    await client.callTool("press_key", { pid: session.window.pid, key: "ArrowDown", delivery_mode: "foreground" });
    await sleep(900);
    opt = await pickExact("5-10年");
  }
  if (opt !== null) {
    await clickRef(client, session, opt.ref);
    await sleep(900);
  }
}
console.log(`[5/8] 经验 ${(await snapshot(client, session)).refs.some((r) => r.name === "5-10年" && r.visibility !== "no_layout") ? "✓" : "?"}`);

// 6) 学历
f = await uiaFrame("detailEdulevel");
if (f !== null) {
  await clickCss(f);
  await sleep(900);
  let opt = await pickExact("本科");
  if (opt === null) {
    await client.callTool("press_key", { pid: session.window.pid, key: "ArrowDown", delivery_mode: "foreground" });
    await sleep(900);
    opt = await pickExact("本科");
  }
  if (opt !== null) {
    await clickRef(client, session, opt.ref);
    await sleep(900);
  }
}
console.log(`[6/8] 学历 ${(await snapshot(client, session)).refs.some((r) => r.name === "本科" && r.visibility !== "no_layout") ? "✓" : "?"}`);

// 7) 薪资(最低=10 / 最高=15)
f = await uiaFrame("rc_select_4");
if (f !== null) {
  const before = await snapshot(client, session);
  const beforeSet = new Set(before.refs.map(keyOf));
  await clickCss(f);
  await sleep(1_000);
  const after = await snapshot(client, session);
  const opt = after.refs.find((r) => !beforeSet.has(keyOf(r)) && r.name === "10" && r.actions.includes("click"));
  if (opt !== undefined) {
    await clickRef(client, session, opt.ref);
    await sleep(900);
  }
}
f = await uiaFrame("rc_select_6");
if (f !== null) {
  const before = await snapshot(client, session);
  const beforeSet = new Set(before.refs.map(keyOf));
  await clickCss(f);
  await sleep(1_000);
  const after = await snapshot(client, session);
  const opt = after.refs.find((r) => !beforeSet.has(keyOf(r)) && r.name === "15" && r.actions.includes("click"));
  if (opt !== undefined) {
    await clickRef(client, session, opt.ref);
    await sleep(900);
  }
}
console.log("[7/8] 薪资已尝试(10/15)");

// 8) 部门(直接输入)
const state = await client.requireOk("get_window_state", {
  pid: session.window.pid,
  window_id: session.window.windowId,
  max_elements: 600,
});
const elements = Array.isArray(state.elements) ? state.elements : [];
const deptCombo = elements.find((e) => typeof e.label === "string" && e.role === "ComboBox" && e.label.includes("所属部门"));
if (deptCombo !== undefined) {
  await clickCss(deptCombo.frame);
  await sleep(800);
  const snapD = await snapshot(client, session);
  const box = snapD.refs.find((r) => r.role === "combobox" && r.name !== null && r.name.includes("所属部门"));
  if (box !== undefined) {
    await client.callTool("browser_type", { target_id: session.targetId, tab_id: session.activeTabId, ref: box.ref, text: "销售部", replace: true });
    await sleep(1_000);
    const afterD = await snapshot(client, session);
    const sugg = afterD.refs.find((r) => r.name !== null && /销售部|销售中心|销售团队/.test(r.name) && r.actions.includes("click"));
    if (sugg !== undefined) {
      await clickRef(client, session, sugg.ref);
      await sleep(800);
    }
  }
}
console.log("[8/8] 部门已尝试(销售部)");

// 终态截图准备:滚动到底部
try {
  await client.callTool("scroll", { pid: session.window.pid, direction: "down", by: "page", amount: 2, delivery_mode: "foreground" });
} catch {
  /* 忽略 */
}
await sleep(1_000);
const fin = await snapshot(client, session);
const cityBox = fin.refs.find((r) => r.name !== null && r.name.includes("城市") && r.actions.includes("type"));
console.log(`[城市] ${cityBox === undefined ? "未找到" : `${cityBox.ref} [${cityBox.visibility}]`}`);
if (cityBox !== undefined) {
  const res = await client.callTool("browser_type", { target_id: session.targetId, tab_id: session.activeTabId, ref: cityBox.ref, text: CITY, replace: true }).catch((e) => ({ status: "error", refusalMessage: String(e).slice(0, 100) }));
  console.log(`[城市写入] ${res.status} ${res.refusalCode ?? ""} ${res.refusalMessage ?? ""}`);
  await sleep(1_200);
  const after2 = await snapshot(client, session);
  const sugg = after2.refs.filter((r) => r.name !== null && r.name.includes(CITY) && r.name.length <= 24 && r.actions.includes("click"));
  console.log(`[城市建议] ${sugg.length}: ${sugg.slice(0, 6).map((r) => r.name).join("|")}`);
  const pick = sugg.find((r) => r.name === CITY) ?? sugg[0];
  if (pick !== undefined) {
    await clickRef(client, session, pick.ref);
    await sleep(900);
    console.log(`[城市选] ${pick.name}`);
  }
}
