/**
 * 职位描述输入探测(W5):点击描述框(坐标) → 快照找 textbox → 写入 → 验证。
 * 前提:页面已停留发布页且名称/类别已填(不刷新)。
 *
 * 用法: node scripts/probe-form-desc.mjs
 */

import { loadConfigFromEnv } from "../dist/config.js";
import { DriverClient } from "../dist/cua/driver-client.js";
import { attachBrowserSession, snapshot } from "../dist/cua/session.js";

const DESC = "【自动化测试职位】此岗位为系统联调临时创建,请勿投递。负责渠道拓展与客户维护。";
const cfg = loadConfigFromEnv();
const client = new DriverClient({ bin: cfg.bin, session: cfg.session, timeoutMs: cfg.callTimeoutMs });
const session = await attachBrowserSession(client, cfg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1) 点击描述框(CSS 坐标:显示层估算 ×1.25÷2)
const clickRes = await client.callTool("browser_click", {
  target_id: session.targetId,
  tab_id: session.activeTabId,
  x: 486,
  y: 353,
});
console.log(`[点击描述框] status=${clickRes.status} ${clickRes.refusalCode ?? ""}`);
await sleep(800);

// 2) 快照找可输入节点
let snap = await snapshot(client, session);
const inputs = snap.refs.filter((r) => r.actions.includes("type"));
console.log(`[可输入节点] ${inputs.length}`);
for (const r of inputs) {
  console.log(`  ${r.ref} ${r.role} [${r.visibility ?? "?"}] ${JSON.stringify(r.name)?.slice(0, 50)}`);
}

// 3) 写入描述(优先 contenteditable/textbox)
const target = inputs.find((r) => r.role === "textbox" || r.role === "generic") ?? inputs[0];
if (target === undefined) {
  console.log("[结果] 无可输入节点");
  process.exit(1);
}
console.log(`[写入] ${target.ref}`);
const typeRes = await client.callTool("browser_type", {
  target_id: session.targetId,
  tab_id: session.activeTabId,
  ref: target.ref,
  text: DESC,
  replace: true,
});
console.log(`  type status=${typeRes.status} ${typeRes.refusalCode ?? ""} ${(typeRes.refusalMessage ?? "").slice(0, 120)}`);
await sleep(1_200);

// 4) 验证
const after = await snapshot(client, session);
const counter = after.refs.find((r) => r.name !== null && /\/10000/.test(r.name));
const hit = after.refs.find((r) => r.name !== null && r.name.includes("自动化测试职位"));
console.log(`[字数计数] ${JSON.stringify(counter?.name ?? null)}`);
console.log(`[描述回显] ${hit !== undefined ? "✓ " + JSON.stringify(hit.name).slice(0, 60) : "✗"}`);
