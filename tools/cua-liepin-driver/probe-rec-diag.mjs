/**
 * probe-rec-diag: /recommend 页语义快照的完整度诊断(include_screenshot 已固化)。
 * 用法: node probe-rec-diag.mjs
 */
import { loadConfigFromEnv } from "./dist/config.js";
import { DriverClient } from "./dist/cua/driver-client.js";
import { ensureBrowserSession, snapshot } from "./dist/cua/session.js";
import { textLinesOf } from "./dist/cua/extract.js";

const cfg = loadConfigFromEnv();
const client = new DriverClient({ bin: cfg.bin, session: process.env.CUA_SESSION ?? "hr-rec", timeoutMs: 180000 });
const session = await ensureBrowserSession(client, cfg, { launchIfMissing: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nav = (url) =>
  client.callTool("browser_navigate", { target_id: session.targetId, tab_id: session.activeTabId, url });

for (let i = 1; i <= 4; i++) {
  await nav("about:blank");
  await sleep(900);
  await nav("https://lpt.liepin.com/recommend");
  await sleep(3500);
  const snap = await snapshot(client, session);
  const named = snap.refs.filter((r) => r.name !== null && r.name !== "");
  const lines = textLinesOf(snap);
  const hasCandidate = snap.refs.some((r) => typeof r.name === "string" && /女士|先生/.test(r.name));
  console.log(`R${i}: refs=${snap.refs.length} named=${named.length} lines=${lines.length} 候选人=${hasCandidate}`);
  if (i === 1 || (hasCandidate && named.length >= 40)) {
    if (i !== 1) {
      console.log("SUCCESS at round", i);
    }
  }
  if (i === 4) {
    console.log("--- 命名节点(前 50) ---");
    for (const r of named.slice(0, 50)) {
      console.log(r.ref, "|", r.role, "|", JSON.stringify(r.name).slice(0, 50));
    }
  }
  await sleep(2500);
}
