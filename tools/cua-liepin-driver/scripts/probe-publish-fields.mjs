/**
 * 发布表单字段映射探针(W5 联调):列出所有可输入控件及各自附近最近的标签文本,
 * 建立「字段名 → ref/role」映射表,供 jobpublish 流程设计。
 *
 * 用法: node scripts/probe-publish-fields.mjs [outFile]
 * 说明: 纯读取,不点击不输入。
 */

import { writeFileSync } from "node:fs";
import { loadConfigFromEnv } from "../dist/config.js";
import { DriverClient } from "../dist/cua/driver-client.js";
import { attachBrowserSession, snapshot } from "../dist/cua/session.js";

const outFile = process.argv[2] ?? "probe-publish-fields.json";
const cfg = loadConfigFromEnv();
const client = new DriverClient({ bin: cfg.bin, session: cfg.session, timeoutMs: cfg.callTimeoutMs });
const session = await attachBrowserSession(client, cfg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await client.requireOk("browser_navigate", {
  target_id: session.targetId,
  tab_id: session.activeTabId,
  url: "https://lpt.liepin.com/job/publish?ejobActionType=publish",
});
await sleep(4_000);

const snap = await snapshot(client, session);
console.log(`[表单] refs=${snap.refs.length}`);
writeFileSync(outFile, JSON.stringify({ page: snap.page, snapshotId: snap.snapshotId, refs: snap.refs }, null, 1), "utf8");

// 可输入控件
const inputs = snap.refs
  .map((r, i) => ({ r, i }))
  .filter(({ r }) => r.actions.includes("type") || r.actions.includes("click") && (r.role === "combobox" || r.role === "textbox" || r.role === "spinbutton"));
console.log(`--- 可输入/可选控件(${inputs.length}) ---`);
for (const { r, i } of inputs) {
  // 向前最多 12 个节点找 label 候选(statictext/heading 非空文本,长度<=24)
  let label = "(未定位到标签)";
  for (let j = i - 1; j >= Math.max(0, i - 12); j--) {
    const c = snap.refs[j];
    if (c.role === "statictext" && c.name !== null && c.name.trim() !== "" && c.name.length <= 24) {
      label = c.name;
      break;
    }
  }
  // 向后 1 个节点看 placeholder
  let placeholder = "";
  for (let j = i + 1; j < Math.min(snap.refs.length, i + 4); j++) {
    const c = snap.refs[j];
    if (c.role === "statictext" && c.name !== null && c.name.trim() !== "") {
      placeholder = c.name.slice(0, 30);
      break;
    }
  }
  console.log(`  ${r.ref} role=${r.role} [${r.visibility ?? "?"}] label≈「${label}」 placeholder≈「${placeholder}」`);
}

// 按钮(提交/保存等)
console.log("--- 按钮(去重 by name) ---");
const seen = new Set();
for (const r of snap.refs) {
  if (r.role === "button" && r.name !== null && !seen.has(r.name) && r.name.length <= 30) {
    seen.add(r.name);
    console.log(`  ${r.ref} [${r.visibility ?? "?"}] actions=[${r.actions.join(",")}] ${r.name}`);
  }
}
console.log(`OUT: ${outFile}`);
