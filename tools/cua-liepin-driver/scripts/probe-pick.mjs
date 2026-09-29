/**
 * 通用下拉选择(W5):必要时点开下拉 → 找目标选项 → 点击 → 验证。
 *
 * 用法: node scripts/probe-pick.mjs <x> <y> <选项文本>
 * 例: node scripts/probe-pick.mjs 500 150 5-10年
 */

import { loadConfigFromEnv } from "../dist/config.js";
import { DriverClient } from "../dist/cua/driver-client.js";
import { attachBrowserSession, clickRef, snapshot } from "./../dist/cua/session.js";

const x = Number.parseFloat(process.argv[2] ?? "0");
const y = Number.parseFloat(process.argv[3] ?? "0");
const text = process.argv[4] ?? "";

const cfg = loadConfigFromEnv();
const client = new DriverClient({ bin: cfg.bin, session: cfg.session, timeoutMs: cfg.callTimeoutMs });
const session = await attachBrowserSession(client, cfg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findOption(snap) {
  const exact = snap.refs.find((r) => r.name === text && r.actions.includes("click"));
  if (exact !== undefined) return exact;
  const exactAny = snap.refs.find((r) => r.name === text);
  if (exactAny !== undefined) return exactAny;
  return snap.refs.find((r) => r.name !== null && r.name.includes(text) && r.name.length <= text.length + 8);
}

let snap = await snapshot(client, session);
let option = findOption(snap);
if (option === undefined) {
  console.log(`[选项未现] 点击 (${x},${y}) 展开`);
  const res = await client.callTool("browser_click", {
    target_id: session.targetId,
    tab_id: session.activeTabId,
    x,
    y,
  });
  console.log(`  click status=${res.status} ${res.refusalCode ?? ""}`);
  await sleep(1_000);
  snap = await snapshot(client, session);
  option = findOption(snap);
}
if (option === undefined) {
  console.log(`[结果] 未找到选项「${text}」`);
  process.exit(1);
}
console.log(`[选项] ${option.ref} ${option.role} [${option.visibility}] [${option.actions.join(",")}] ${JSON.stringify(option.name)}`);

// 点击:优先自身;若不可点则找邻近可点节点(选项行容器)
let clicked = false;
if (option.actions.includes("click")) {
  await clickRef(client, session, option.ref);
  clicked = true;
} else {
  const idx = snap.refs.indexOf(option);
  const near = snap.refs.slice(Math.max(0, idx - 4), idx + 5).filter((r) => r.actions.includes("click") && r.role !== "link");
  for (const n of near) {
    try {
      await clickRef(client, session, n.ref);
      console.log(`[邻近点击] ${n.ref} ${n.role} ${JSON.stringify(n.name)?.slice(0, 30)}`);
      clicked = true;
      break;
    } catch {
      /* 试下一个 */
    }
  }
}
if (!clicked) {
  console.log("[结果] 无法点击选项");
  process.exit(1);
}
await sleep(1_000);

const after = await snapshot(client, session);
const settled = after.refs.find((r) => r.name === text && r.visibility !== "no_layout");
console.log(`[验证] ${settled !== undefined ? "✓ 已选中: " + JSON.stringify(settled.name) : "? 未见确认节点"}`);
