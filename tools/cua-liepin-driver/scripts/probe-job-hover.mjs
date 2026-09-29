/**
 * 职位行 hover 探测(W5):列表 → hover 职位行 → 找行内操作入口(编辑/更多)。
 *
 * 用法: node scripts/probe-job-hover.mjs
 */

import { loadConfigFromEnv } from "../dist/config.js";
import { DriverClient } from "../dist/cua/driver-client.js";
import { attachBrowserSession, snapshot } from "../dist/cua/session.js";

const cfg = loadConfigFromEnv();
const client = new DriverClient({ bin: cfg.bin, session: cfg.session, timeoutMs: cfg.callTimeoutMs });
const session = await attachBrowserSession(client, cfg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const keyOf = (r) => `${r.role}|${r.name ?? ""}|${r.visibility ?? ""}`;

await client.requireOk("browser_navigate", {
  target_id: session.targetId,
  tab_id: session.activeTabId,
  url: "https://lpt.liepin.com/job/manager",
});
await sleep(4_000);

const snap0 = await snapshot(client, session);
const navNames = ["人才推荐", "职位管理", "搜索人才", "人才管理", "猎头服务", "提效服务", "问 Lily", "意向人选", "急聘置顶", "火爆刷"];
const rows = snap0.refs.filter(
  (r) =>
    r.role === "link" &&
    r.name !== null &&
    r.name.length >= 4 &&
    r.name.length <= 40 &&
    (r.visibility === "in_viewport" || r.visibility === "near_viewport") &&
    !navNames.some((n) => r.name.includes(n)) &&
    !/^\d+\s*\/\s*\d+$/.test(r.name),
);
console.log(`[职位行] ${rows.length}: ${rows.map((r) => r.name).join(" | ")}`);
if (rows.length === 0) {
  process.exit(1);
}

const beforeSet = new Set(snap0.refs.map(keyOf));
for (const row of rows.slice(0, 2)) {
  console.log(`[hover] ${row.ref} ${JSON.stringify(row.name)}`);
  try {
    const res = await client.callTool("browser_pointer", {
      target_id: session.targetId,
      tab_id: session.activeTabId,
      action: "hover",
      ref: row.ref,
    });
    console.log(`  hover status=${res.status} ${res.refusalCode ?? ""}`);
  } catch (err) {
    console.log(`  hover 异常: ${String(err).slice(0, 140)}`);
  }
  await sleep(1_000);
  const after = await snapshot(client, session);
  const fresh = after.refs.filter((r) => !beforeSet.has(keyOf(r)) && r.name !== null && r.name.length <= 30);
  console.log(`  新节点=${fresh.length}`);
  for (const r of fresh.slice(0, 25)) {
    console.log(`    ${r.ref} ${r.role} [${r.visibility ?? "?"}] [${r.actions.join(",")}] ${JSON.stringify(r.name)}`);
  }
  // 全部按钮(筛选行内操作)
  const btns = after.refs.filter((r) => r.role === "button" && r.name !== null && r.name.length <= 20 && (r.visibility === "in_viewport" || r.visibility === "near_viewport"));
  console.log(`  可见按钮: ${btns.map((b) => b.name).join(" | ")}`);
}
