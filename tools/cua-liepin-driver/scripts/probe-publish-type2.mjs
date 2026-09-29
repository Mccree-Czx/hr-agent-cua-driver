/**
 * 发布表单输入验证 #2(W5 联调):定位职位名称输入框(combobox+type),
 * browser_type 写中文(replace) → 快照验证 → 清空复原。
 *
 * 用法: node scripts/probe-publish-type2.mjs
 * 安全: 只填表不提交;结束后清空输入框恢复原状。
 */

import { loadConfigFromEnv } from "../dist/config.js";
import { DriverClient } from "../dist/cua/driver-client.js";
import { attachBrowserSession, snapshot } from "../dist/cua/session.js";

const TEXT = "自动化探测职位勿扰";
const cfg = loadConfigFromEnv();
const client = new DriverClient({ bin: cfg.bin, session: cfg.session, timeoutMs: cfg.callTimeoutMs });
const session = await attachBrowserSession(client, cfg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const snap0 = await snapshot(client, session);
console.log(`[表单] url=${snap0.page.url} refs=${snap0.refs.length}`);

// 输入框候选:role=combobox/textbox 且 actions 含 type(有值后可见)
const inputs = snap0.refs.filter(
  (r) => (r.role === "combobox" || r.role === "textbox") && r.actions.includes("type"),
);
console.log(`[输入框候选] ${inputs.map((r) => `${r.ref}(${r.role})`).join(", ")}`);
if (inputs.length === 0) {
  console.log("未找到可输入控件");
  process.exit(1);
}

const target = inputs[0];
console.log(`[目标] ${target.ref} role=${target.role}`);

async function typeInto(ref, text, replace) {
  const res = await client.callTool("browser_type", {
    target_id: session.targetId,
    tab_id: session.activeTabId,
    ref,
    text,
    replace,
  });
  if (res.status === "refused") {
    return `refused(${res.refusalCode}): ${res.refusalMessage ?? ""}`.slice(0, 160);
  }
  return "ok";
}

// 1) 写中文
console.log(`[写入] ${await typeInto(target.ref, TEXT, true)}`);
await sleep(1_000);
let snap1 = await snapshot(client, session);
const hit = snap1.refs.find((r) => r.name !== null && r.name.includes("自动化探测"));
console.log(hit !== undefined ? `[验证] ✓ 中文写入成功 ref=${hit.ref} name=${hit.name}` : "[验证] ✗ 快照未见中文");

// 2) 清空复原
if (hit !== undefined) {
  const focused = snap1.refs.find(
    (r) => (r.role === "combobox" || r.role === "textbox") && r.actions.includes("type"),
  );
  const ref = focused?.ref ?? target.ref;
  console.log(`[清空] ${await typeInto(ref, "", true)} (ref=${ref})`);
  await sleep(800);
  const snap2 = await snapshot(client, session);
  const still = snap2.refs.find((r) => r.name !== null && r.name.includes("自动化探测"));
  console.log(still !== undefined ? "[清空] ✗ 仍残留" : "[清空] ✓ 已复原");
}
