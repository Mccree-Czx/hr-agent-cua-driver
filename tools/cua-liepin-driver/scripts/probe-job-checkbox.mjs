/**
 * 职位行勾选框结构探针(W5 联调):打印所有可点击 labeltext 与职位名 link
 * 的前后邻近节点,建立「行 ↔ 勾选框」定位依据。
 *
 * 用法: node scripts/probe-job-checkbox.mjs
 * 说明: 纯读取,不点击。
 */

import { loadConfigFromEnv } from "../dist/config.js";
import { DriverClient } from "../dist/cua/driver-client.js";
import { attachBrowserSession, snapshot } from "../dist/cua/session.js";

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

const snap = await snapshot(client, session);
console.log(`[列表] refs=${snap.refs.length}`);

const desc = (r) => `${r.ref}(${r.role},${(r.visibility ?? "?").slice(0, 4)},[${r.actions.join("|")}])`;
const ctxOf = (i, back = 2, fwd = 2) => {
  const parts = [];
  for (let j = Math.max(0, i - back); j <= Math.min(snap.refs.length - 1, i + fwd); j++) {
    const r = snap.refs[j];
    if (r.name !== null && r.name.trim() !== "" && r.name.length <= 30) {
      parts.push(`${j === i ? ">>" : ""}${desc(r)}「${r.name}」`);
    }
  }
  return parts.join(" ");
};

console.log("--- 可点击 labeltext ---");
snap.refs.forEach((r, i) => {
  if (r.role === "labeltext" && r.actions.includes("click")) {
    console.log(`[${i}] ${ctxOf(i)}`);
  }
});

console.log("--- 疑似职位名 link(长度 4-30,in_viewport/near) ---");
snap.refs.forEach((r, i) => {
  if (
    r.role === "link" &&
    r.name !== null &&
    r.name.length >= 4 &&
    r.name.length <= 30 &&
    (r.visibility === "in_viewport" || r.visibility === "near_viewport")
  ) {
    console.log(`[${i}] ${ctxOf(i, 3, 1)}`);
  }
});

console.log("--- statictext「沟通中」附近的节点(行区域参考) ---");
snap.refs.forEach((r, i) => {
  if (r.name === "沟通中") {
    console.log(`[${i}] ${ctxOf(i, 6, 6)}`);
  }
});
