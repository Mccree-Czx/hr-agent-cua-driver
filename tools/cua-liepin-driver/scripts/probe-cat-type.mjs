/**
 * 类别搜索输入验证(W5):向可见 combobox 第二个候选写关键词 → 截图+快照
 * 验证落点(类别框会触发下拉选项;名称框会直接显示文本)。
 *
 * 用法: node scripts/probe-cat-type.mjs <index> <text>
 * 例: node scripts/probe-cat-type.mjs 1 销售
 */

import { writeFileSync } from "node:fs";
import { loadConfigFromEnv } from "../dist/config.js";
import { DriverClient } from "../dist/cua/driver-client.js";
import { attachBrowserSession, snapshot } from "../dist/cua/session.js";

const idx = Number.parseInt(process.argv[2] ?? "1", 10);
const text = process.argv[3] ?? "销售";

const cfg = loadConfigFromEnv();
const client = new DriverClient({ bin: cfg.bin, session: cfg.session, timeoutMs: cfg.callTimeoutMs });
const session = await attachBrowserSession(client, cfg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const snap0 = await snapshot(client, session);
const inputs = snap0.refs.filter(
  (r) => (r.role === "combobox" || r.role === "textbox") && r.actions.includes("type") && r.visibility === "in_viewport",
);
console.log(`[输入源] ${inputs.map((r, i) => `${i}:${r.ref}(${r.role})`).join(" ")}`);
const target = inputs[idx];
if (target === undefined) {
  console.log(`索引 ${idx} 不存在`);
  process.exit(1);
}
console.log(`[目标] ${idx} → ${target.ref}`);

const res = await client.callTool("browser_type", {
  target_id: session.targetId,
  tab_id: session.activeTabId,
  ref: target.ref,
  text,
  replace: true,
});
console.log(`[写入] status=${res.status} ${res.refusalCode ?? ""} ${(res.refusalMessage ?? "").slice(0, 120)}`);
await sleep(1_200);

const snap1 = await snapshot(client, session);
console.log(`[写入后] refs=${snap1.refs.length}`);
const hits = snap1.refs.filter((r) => r.name !== null && r.name.includes(text) && r.name.length <= 40);
for (const r of hits.slice(0, 30)) console.log(`  ${r.ref} ${r.role} [${r.visibility ?? "?"}] ${JSON.stringify(r.name)}`);
const comboHits = snap1.refs.filter((r) => (r.role === "option" || r.role === "listitem") && r.name !== null);
console.log(`[option/listitem] ${comboHits.length}`);
for (const r of comboHits.slice(0, 30)) console.log(`  ${r.ref} ${r.role} ${JSON.stringify(r.name)}`);

const shot = await client.callTool("get_browser_state", {
  target_id: session.targetId,
  tab_id: session.activeTabId,
  include_screenshot: true,
});
if (typeof shot.data.screenshot_png_b64 === "string") {
  writeFileSync("cat-type-result.png", Buffer.from(shot.data.screenshot_png_b64, "base64"));
  console.log("[截图] cat-type-result.png");
}
