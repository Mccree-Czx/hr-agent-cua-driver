/**
 * 职位列表勾选实验(W5 联调):点击"全选" → 观察批量操作条按钮变化 → 取消勾选。
 *
 * 用法: node scripts/probe-job-select.mjs
 * 安全: 只勾选/取消,绝不点击任何操作按钮(结束/删除)。
 */

import { loadConfigFromEnv } from "../dist/config.js";
import { DriverClient } from "../dist/cua/driver-client.js";
import { attachBrowserSession, clickRef, snapshot } from "../dist/cua/session.js";

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

const snap0 = await snapshot(client, session);
console.log(`[列表] url=${snap0.page.url} refs=${snap0.refs.length}`);

// 找可点击的 labeltext(全选框;tab 的 labeltext 通常无 click action)
const labels = snap0.refs.filter((r) => r.role === "labeltext" && r.actions.includes("click"));
console.log(`[checkbox 候选] ${labels.map((r) => r.ref).join(", ")}`);
if (labels.length === 0) {
  console.log("未找到可点击 labeltext(勾选框)");
  process.exit(1);
}
const box = labels[labels.length - 1]; // 最后一个通常是列表区附近

console.log(`[勾选] 点击 ${box.ref}`);
try {
  await clickRef(client, session, box.ref);
} catch (err) {
  console.log(`[勾选失败] ${String(err).slice(0, 160)}`);
  process.exit(1);
}
await sleep(1_500);

const snap1 = await snapshot(client, session);
console.log(`[勾选后] refs=${snap1.refs.length}`);
console.log("--- 批量条按钮状态 ---");
for (const r of snap1.refs) {
  if (
    r.role === "button" &&
    r.name !== null &&
    r.name.length <= 30 &&
    r.visibility !== "offscreen" &&
    /(结束|刷新|删除|下线|暂停|上线|批量|导出)/.test(r.name)
  ) {
    console.log(`  ${r.ref} actions=[${r.actions.join(",")}] name=${r.name}`);
  }
}
console.log("--- 全部按钮(去重) ---");
const seen = new Set();
for (const r of snap1.refs) {
  if (r.role === "button" && r.name !== null && !seen.has(r.name) && r.name.length <= 30) {
    seen.add(r.name);
    console.log(`  ${r.ref} actions=[${r.actions.join(",")}] name=${r.name}`);
  }
}

// 取消勾选(复原)
console.log(`[取消勾选] 再点 ${box.ref}`);
try {
  // ref 可能已 stale,重新快照后按同样策略找
  const snap2 = await snapshot(client, session);
  const labels2 = snap2.refs.filter((r) => r.role === "labeltext" && r.actions.includes("click"));
  const box2 = labels2[labels2.length - 1];
  if (box2 !== undefined) {
    await clickRef(client, session, box2.ref);
    console.log("[取消勾选] 已投递");
  } else {
    console.log("[取消勾选] 未找到勾选框(跳过)");
  }
} catch (err) {
  console.log(`[取消勾选失败] ${String(err).slice(0, 160)}`);
}
