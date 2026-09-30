/**
 * probe-waitfull: 多轮(清场+导航+快照)实验,找语义快照"完整窗口"的触发规律。
 * 用法: node probe-waitfull.mjs [轮数] [间隔ms]
 */
import { loadConfigFromEnv } from "./dist/config.js";
import { DriverClient } from "./dist/cua/driver-client.js";
import { ensureBrowserSession, snapshot } from "./dist/cua/session.js";

const cfg = loadConfigFromEnv();
const client = new DriverClient({ bin: cfg.bin, session: "hr-wait", timeoutMs: 120000 });
const session = await ensureBrowserSession(client, cfg, { launchIfMissing: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rounds = Number.parseInt(process.argv[2] ?? "10", 10);
const gapMs = Number.parseInt(process.argv[3] ?? "4000", 10);
const target = "https://lpt.liepin.com/job/manager";
const nav = (url) =>
  client.callTool("browser_navigate", { target_id: session.targetId, tab_id: session.activeTabId, url });

for (let i = 1; i <= rounds; i++) {
  await nav("about:blank");
  await sleep(900);
  await nav(target);
  await sleep(3200);
  const snap = await snapshot(client, session);
  const named = snap.refs.filter((r) => r.name !== null && r.name !== "");
  const hasJob = snap.refs.some((r) => r.name === "海外ToB渠道销售（出海品牌）");
  console.log(`R${i}: refs=${snap.refs.length} named=${named.length} 职位行=${hasJob}`);
  if (hasJob && named.length >= 40 && process.argv[4] !== "noearly") {
    console.log("SUCCESS at round", i);
    break;
  }
  await sleep(gapMs);
}
