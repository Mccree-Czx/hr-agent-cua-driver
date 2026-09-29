/**
 * 发布表单输入探测(W5 联调):定位「职位名称」附近的候选节点,
 * 逐个尝试 click + browser_type(replace) → 快照验证文本是否落入输入框。
 *
 * 用法: node scripts/probe-publish-input.mjs
 * 安全: 只填表不提交,离开页面即丢弃;不触碰任何提交/发布按钮。
 */

import { loadConfigFromEnv } from "../dist/config.js";
import { DriverClient } from "../dist/cua/driver-client.js";
import { attachBrowserSession, clickRef, snapshot } from "../dist/cua/session.js";

const TEXT = "自动化探测职位勿扰";
const cfg = loadConfigFromEnv();
const client = new DriverClient({ bin: cfg.bin, session: cfg.session, timeoutMs: cfg.callTimeoutMs });
const session = await attachBrowserSession(client, cfg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await client.requireOk("browser_navigate", {
  target_id: session.targetId,
  tab_id: session.activeTabId,
  url: "https://lpt.liepin.com/job/publish?ejobActionType=publish",
});
await sleep(4_000);

const snap0 = await snapshot(client, session);
console.log(`[表单] url=${snap0.page.url} refs=${snap0.refs.length}`);
const labelIdx = snap0.refs.findIndex((r) => r.name === "职位名称");
if (labelIdx < 0) {
  console.log("未找到「职位名称」标签");
  process.exit(1);
}
console.log(`[标签] idx=${labelIdx} ref=${snap0.refs[labelIdx].ref}`);

// 「职位名称」标签后 6 个节点里的 generic/textbox 候选
const candidates = snap0.refs
  .slice(labelIdx + 1, labelIdx + 7)
  .filter((r) => r.role === "generic" || r.role === "textbox");
console.log(`[候选] ${candidates.map((r) => `${r.ref}(${r.role})`).join(", ")}`);

for (const cand of candidates.slice(0, 4)) {
  console.log(`--- 尝试 ${cand.ref} role=${cand.role} actions=[${cand.actions.join(",")}] ---`);
  try {
    await clickRef(client, session, cand.ref);
    await sleep(800);
  } catch (err) {
    console.log(`  click 失败: ${String(err).slice(0, 120)}`);
    continue;
  }
  try {
    const res = await client.callTool("browser_type", {
      target_id: session.targetId,
      tab_id: session.activeTabId,
      ref: cand.ref,
      text: TEXT,
      replace: true,
    });
    if (res.status === "refused") {
      console.log(`  type 拒绝(${res.refusalCode}): ${res.refusalMessage ?? ""}`.slice(0, 160));
      continue;
    }
  } catch (err) {
    console.log(`  type 异常: ${String(err).slice(0, 140)}`);
    continue;
  }
  await sleep(1_000);
  const snap1 = await snapshot(client, session);
  const hit = snap1.refs.find((r) => r.name !== null && r.name.includes("自动化探测"));
  console.log(hit !== undefined ? `  ✓ 输入成功! 命中节点 ${hit.ref} name=${hit.name}` : "  ✗ 未在快照中发现输入文本");
  if (hit !== undefined) {
    break;
  }
}
