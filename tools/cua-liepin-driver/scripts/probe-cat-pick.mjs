/**
 * 推荐职位名称下拉选择试验(W5):名称框输入关键词 → 找下拉选项行 →
 * 点击选项 → 验证名称框/类别框落值(截图+快照)。
 *
 * 用法: node scripts/probe-cat-pick.mjs [关键词]
 */

import { writeFileSync } from "node:fs";
import { loadConfigFromEnv } from "../dist/config.js";
import { DriverClient } from "../dist/cua/driver-client.js";
import { attachBrowserSession, snapshot } from "../dist/cua/session.js";

const keyword = process.argv[2] ?? "销售";

const cfg = loadConfigFromEnv();
const client = new DriverClient({ bin: cfg.bin, session: cfg.session, timeoutMs: cfg.callTimeoutMs });
const session = await attachBrowserSession(client, cfg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shot(out) {
  const res = await client.callTool("get_browser_state", {
    target_id: session.targetId,
    tab_id: session.activeTabId,
    include_screenshot: true,
  });
  if (typeof res.data.screenshot_png_b64 === "string") {
    writeFileSync(out, Buffer.from(res.data.screenshot_png_b64, "base64"));
  }
}

// 确保在发布页(刷新状态)
await client.requireOk("browser_navigate", {
  target_id: session.targetId,
  tab_id: session.activeTabId,
  url: "https://lpt.liepin.com/job/publish?ejobActionType=publish",
});
await sleep(3_500);

// 1) 名称框输入关键词
let snap = await snapshot(client, session);
const nameBox = snap.refs.find((r) => r.role === "combobox" && r.actions.includes("type") && r.visibility === "in_viewport");
if (nameBox === undefined) {
  console.log("未找到名称输入框");
  process.exit(1);
}
console.log(`[名称框] ${nameBox.ref}`);
await client.callTool("browser_type", {
  target_id: session.targetId,
  tab_id: session.activeTabId,
  ref: nameBox.ref,
  text: keyword,
  replace: true,
});
await sleep(1_200);

// 2) 找下拉选项:含路径分隔符 ">" 的 statictext,取其附近可点击节点
snap = await snapshot(client, session);
console.log(`[下拉后] refs=${snap.refs.length}`);
const pathNodes = snap.refs.filter((r) => r.name !== null && r.name.includes(">") && r.name.length <= 80);
console.log(`[路径节点] ${pathNodes.length}`);
for (const p of pathNodes.slice(0, 8)) {
  const idx = snap.refs.indexOf(p);
  const around = snap.refs.slice(Math.max(0, idx - 3), idx + 4);
  console.log(`  路径: ${p.ref} ${JSON.stringify(p.name).slice(0, 60)}`);
  for (const a of around) {
    if (a.actions.includes("click")) {
      console.log(`    可点邻近: ${a.ref} ${a.role} [${a.actions.join(",")}] ${JSON.stringify(a.name).slice(0, 40)}`);
    }
  }
}

// 3) 点击第一个路径节点(试试 statictext 能否直接点)
if (pathNodes.length === 0) {
  console.log("[结果] 无下拉选项(关键词可能无联想)");
  process.exit(1);
}
const target = pathNodes[0];
console.log(`[点击] ${target.ref} ${JSON.stringify(target.name).slice(0, 50)}`);
const clickRes = await client.callTool("browser_click", {
  target_id: session.targetId,
  tab_id: session.activeTabId,
  ref: target.ref,
});
console.log(`  click status=${clickRes.status} ${clickRes.refusalCode ?? ""} ${(clickRes.refusalMessage ?? "").slice(0, 100)}`);
await sleep(1_500);

// 4) 验证:名称/类别落值
const after = await snapshot(client, session);
console.log(`[点击后] refs=${after.refs.length}`);
const combos = after.refs.filter((r) => r.role === "combobox");
for (const c of combos) {
  console.log(`  combobox ${c.ref} [${c.visibility ?? "?"}] name=${JSON.stringify(c.name)}`);
}
const kwHits = after.refs.filter((r) => r.name !== null && (r.name.includes("销售") || r.name.includes(">")) && r.name.length <= 80);
for (const r of kwHits.slice(0, 15)) console.log(`  hit ${r.ref} ${r.role} ${JSON.stringify(r.name).slice(0, 60)}`);
const placeholderGone = after.refs.every((r) => r.name !== "请输入或选择职位类别");
console.log(`[类别占位符消失] ${placeholderGone}`);
await shot("cat-pick-result.png");
console.log("[截图] cat-pick-result.png");
