/**
 * 抓完整 job/manager 快照并分析 records 索引关系(诊断)。
 *
 * 用法: node scripts/probe-jm-index.mjs
 */

import { writeFileSync } from "node:fs";
import { loadConfigFromEnv } from "../dist/config.js";
import { DriverClient } from "../dist/cua/driver-client.js";
import { ensureBrowserSession, snapshot } from "../dist/cua/session.js";
import { jobRowIndexes } from "../dist/cua/extract.js";

const cfg = loadConfigFromEnv();
const client = new DriverClient({ bin: cfg.bin, session: cfg.session, timeoutMs: cfg.callTimeoutMs });
const session = await ensureBrowserSession(client, cfg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (let attempt = 1; attempt <= 4; attempt++) {
  await client.requireOk("browser_navigate", {
    target_id: session.targetId,
    tab_id: session.activeTabId,
    url: "https://lpt.liepin.com/job/manager",
  });
  await sleep(5_000);
  const snap = await snapshot(client, session);
  const hasRow = snap.refs.some((r) => r.name !== null && r.name.includes("海外ToB"));
  const hasFields = snap.refs.some((r) => r.name !== null && r.name.includes("上海-黄浦区"));
  console.log(`#${attempt} refs=${snap.refs.length} 行=${hasRow} 字段=${hasFields}`);
  if (hasRow) {
    writeFileSync("jm-snap.json", JSON.stringify({ page: snap.page, refs: snap.refs }, null, 1), "utf8");
    console.log("已保存 jm-snap.json");
    const idxs = jobRowIndexes(snap.refs);
    console.log("jobRow索引=" + JSON.stringify(idxs));
    snap.refs.forEach((r, i) => {
      if (r.name && /上海-黄浦区|15-30k|\d{4}\.\d{2}\.\d{2}刷新|^沟通中$|海外ToB/.test(r.name)) {
        console.log(`  i=${i} ${r.role} [${r.visibility ?? "?"}] ${JSON.stringify(r.name).slice(0, 42)}`);
      }
    });
    break;
  }
  await sleep(2_000);
}
