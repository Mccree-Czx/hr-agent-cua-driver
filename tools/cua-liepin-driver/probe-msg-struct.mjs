/**
 * probe-msg-struct: dump 会话消息区的完整 refs 结构,寻找"我方/对方"与"已读"信号。
 * 用法: node probe-msg-struct.mjs
 */
import { loadConfigFromEnv } from "./dist/config.js";
import { DriverClient } from "./dist/cua/driver-client.js";
import { ensureBrowserSession, snapshot, clickRef } from "./dist/cua/session.js";
import { findConversationRow, readPage } from "./dist/flows/read-pages.js";

const cfg = loadConfigFromEnv();
const client = new DriverClient({ bin: cfg.bin, session: "hr-msg", timeoutMs: 180000 });
const session = await ensureBrowserSession(client, cfg, { launchIfMissing: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ctx = { client, session, dryRun: false, log: (m) => console.log(String(m)), sleep };

const { snap: listSnap } = await readPage(ctx, "https://lpt.liepin.com/chat/im");
console.log("LIST refs=", listSnap.refs.length);
const row = findConversationRow(listSnap.refs, "邵女士");
if (row === null) {
  console.log("未找到邵女士会话行");
  process.exit(1);
}
console.log("row:", row.ref);
await clickRef(client, session, row.ref);
await sleep(2500);

const snap = await snapshot(client, session);
console.log("MSG refs=", snap.refs.length);
console.log("--- 全部命名节点(role|name|actions) ---");
snap.refs.forEach((r, i) => {
  if (r.name !== null && r.name !== "") {
    console.log(`#${i}`, r.ref, "|", r.role, "|", JSON.stringify(r.name).slice(0, 70), "|", r.actions.slice(0, 2).join(","));
  }
});
