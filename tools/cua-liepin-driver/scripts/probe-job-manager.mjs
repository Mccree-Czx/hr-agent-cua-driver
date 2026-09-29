/**
 * 职位管理页探针(联调 W5):导航 /job/manager → (尝试关闭营销浮层)
 * → 打印页面文本与按钮结构 → 快照落盘。
 *
 * 用法: node scripts/probe-job-manager.mjs [outFile]
 * 目的: 校准 joblist/jobdelete/jobpublish 的匹配器(职位行/操作菜单/发布入口)。
 */

import { writeFileSync } from "node:fs";
import { loadConfigFromEnv } from "../dist/config.js";
import { DriverClient } from "../dist/cua/driver-client.js";
import { attachBrowserSession, clickRef, snapshot } from "../dist/cua/session.js";

const outFile = process.argv[2] ?? "probe-job-manager.json";

const cfg = loadConfigFromEnv();
const client = new DriverClient({ bin: cfg.bin, session: cfg.session, timeoutMs: cfg.callTimeoutMs });
const session = await attachBrowserSession(client, cfg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await client.requireOk("browser_navigate", {
  target_id: session.targetId,
  tab_id: session.activeTabId,
  url: "https://lpt.liepin.com/job/manager",
});
await sleep(4_000);

// 1) 关闭遮挡浮层(Close/✕ 按钮;只点一次,没有则跳过)
let snap = await snapshot(client, session);
const overlayClose = snap.refs.find(
  (r) =>
    (r.role === "button" || r.role === "image") &&
    r.name !== null &&
    /^(Close|✕|close)$/i.test(r.name) &&
    r.actions.includes("click"),
);
if (overlayClose !== undefined) {
  console.log(`[浮层] 关闭 ${overlayClose.ref} name=${overlayClose.name}`);
  try {
    await clickRef(client, session, overlayClose.ref);
    await sleep(1_500);
    snap = await snapshot(client, session);
  } catch (err) {
    console.log(`[浮层] 关闭失败(忽略): ${String(err).slice(0, 120)}`);
  }
} else {
  console.log("[浮层] 未发现 Close 按钮");
}

// 2) 打印结构
console.log(`[页面] url=${snap.page.url} title=${snap.page.title} refs=${snap.refs.length}`);
console.log("--- 文本节点(长度<=40) ---");
for (const r of snap.refs) {
  if (r.role === "statictext" && r.name !== null && r.name.length <= 40) {
    console.log(`  ${r.ref} [${r.visibility ?? "?"}] ${r.name}`);
  }
}
console.log("--- 按钮/链接 ---");
for (const r of snap.refs) {
  if ((r.role === "button" || r.role === "link") && r.name !== null && r.name.length <= 40) {
    console.log(`  ${r.ref} [${r.visibility ?? "?"}] actions=[${r.actions.join(",")}] ${r.name}`);
  }
}

writeFileSync(outFile, JSON.stringify({ page: snap.page, snapshotId: snap.snapshotId, refs: snap.refs }, null, 1), "utf8");
console.log(`OUT: ${outFile}`);
