/**
 * 页面探针(联调校准工具,非运行时命令)。
 *
 * 用法: node scripts/probe-page.mjs <url|-> [outFile] [query] [clickRef]
 *   url   : 目标页面 URL;传 "-" 表示不导航,只快照当前页
 *   outFile: 快照 JSON 落盘路径(默认 probe-page.json)
 *   query : 可选,语义查询词(仅返回匹配节点)
 *   clickRef : 可选,先点击指定 ref 再快照(联调:捕获跳转后 URL,如导航入口/候选人卡片)
 *
 * 输出: 页面 URL/标题/ref 数量,并把 {page, refs} 写入 outFile(UTF-8)。
 */

import { writeFileSync } from "node:fs";
import { loadConfigFromEnv } from "../dist/config.js";
import { DriverClient } from "../dist/cua/driver-client.js";
import { attachBrowserSession, clickRef, snapshot } from "../dist/cua/session.js";

const url = process.argv[2] ?? "-";
const outFile = process.argv[3] ?? "probe-page.json";
const query = process.argv[4];
const clickRefArg = process.argv[5];

const cfg = loadConfigFromEnv();
const client = new DriverClient({ bin: cfg.bin, session: cfg.session, timeoutMs: cfg.callTimeoutMs });
const session = await attachBrowserSession(client, cfg);

if (url !== "-") {
  await client.requireOk("browser_navigate", {
    target_id: session.targetId,
    tab_id: session.activeTabId,
    url,
  });
  await new Promise((resolve) => setTimeout(resolve, 3_500));
}

if (clickRefArg !== undefined && clickRefArg !== "") {
  await clickRef(client, session, clickRefArg);
  await new Promise((resolve) => setTimeout(resolve, 3_000));
}

const snap = await snapshot(client, session, query);
writeFileSync(
  outFile,
  JSON.stringify({ page: snap.page, snapshotId: snap.snapshotId, refs: snap.refs }, null, 1),
  "utf8",
);
console.log(`URL: ${snap.page.url}`);
console.log(`TITLE: ${snap.page.title}`);
console.log(`REFS: ${snap.refs.length}`);
console.log(`OUT: ${outFile}`);
