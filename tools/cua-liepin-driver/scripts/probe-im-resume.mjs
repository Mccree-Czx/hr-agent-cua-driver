/**
 * IM 会话简历入口探针(联调):打开 /chat/im → 选中会话 → 列出含
 * 「简历/查看/在线」的节点 → (可选)点击目标并连拍 URL 变化。
 *
 * 用法: node scripts/probe-im-resume.mjs [会话名片段] [--click <名称片段>]
 * 目的: 探索 resIdEncode 获取路径(点击简历入口后 URL 是否带 resIdEncode)。
 */

import { loadConfigFromEnv } from "../dist/config.js";
import { DriverClient } from "../dist/cua/driver-client.js";
import { attachBrowserSession, clickRef, snapshot } from "../dist/cua/session.js";

const argv = process.argv.slice(2);
const convName = argv.find((a) => !a.startsWith("--")) ?? "邵女士";
const clickIdx = argv.indexOf("--click");
const clickTarget = clickIdx >= 0 ? argv[clickIdx + 1] : null;

const cfg = loadConfigFromEnv();
const client = new DriverClient({ bin: cfg.bin, session: cfg.session, timeoutMs: cfg.callTimeoutMs });
const session = await attachBrowserSession(client, cfg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1) 打开会话页并点开目标会话
await client.requireOk("browser_navigate", {
  target_id: session.targetId,
  tab_id: session.activeTabId,
  url: "https://lpt.liepin.com/chat/im",
});
await sleep(3_500);

const snap0 = await snapshot(client, session);
const row =
  snap0.refs.find((r) => r.name === convName && r.role === "statictext" && r.actions.includes("click")) ??
  snap0.refs.find(
    (r) =>
      r.name !== null &&
      r.name.includes(convName) &&
      r.actions.includes("click") &&
      !/(收到了|这是|简历。$)/.test(r.name),
  );
if (row === undefined) {
  console.log(`未找到会话「${convName}」(${snap0.refs.length} 节点)`);
  process.exit(1);
}
console.log(`[会话行] ${row.ref} role=${row.role} name=${row.name}`);
await clickRef(client, session, row.ref);
await sleep(2_500);

// 2) 列出含关键词的节点
const snap1 = await snapshot(client, session);
console.log(`[面板] url=${snap1.page.url} refs=${snap1.refs.length}`);
const kw = /(简历|查看|在线|详情|附件)/;
for (const r of snap1.refs) {
  if (r.name !== null && r.name.length <= 60 && kw.test(r.name)) {
    console.log(`  ${r.ref} role=${r.role} actions=[${r.actions.join(",")}] name=${r.name}`);
  }
}

// 3) 可选: 点击目标并连拍
if (clickTarget !== null) {
  const hit =
    snap1.refs.find(
      (r) =>
        r.name !== null &&
        r.name.includes(clickTarget) &&
        r.actions.includes("click") &&
        r.name.length <= 40,
    ) ?? null;
  if (hit === null) {
    console.log(`未找到可点击的「${clickTarget}」`);
    process.exit(1);
  }
  console.log(`[点击] ${hit.ref} role=${hit.role} name=${hit.name}`);
  await clickRef(client, session, hit.ref);
  for (let i = 1; i <= 5; i++) {
    await sleep(1_500);
    const s = await snapshot(client, session);
    console.log(`t${i} url=${s.page.url} title=${s.page.title} refs=${s.refs.length}`);
  }
}
