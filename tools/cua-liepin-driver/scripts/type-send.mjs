/**
 * 会话消息发送(联调校准工具):打开指定会话 → 键入 → 点击发送 → 连拍观察。
 *
 * 用法: node scripts/type-send.mjs <会话名片段> <消息文本>
 * 说明: 走 /chat/im 会话页;点击会话行(按名)打开面板;输入框按名称"请输入"定位。
 */

import { loadConfigFromEnv } from "../dist/config.js";
import { DriverClient } from "../dist/cua/driver-client.js";
import { attachBrowserSession, snapshot } from "../dist/cua/session.js";
import { clickName, typeIntoName } from "../dist/cua/ui-actions.js";
import { clickRef } from "../dist/cua/session.js";

const convName = process.argv[2] ?? "";
const message = process.argv[3] ?? "";
if (convName === "" || message === "") {
  console.error("用法: node scripts/type-send.mjs <会话名片段> <消息文本>");
  process.exit(1);
}

const cfg = loadConfigFromEnv();
const client = new DriverClient({ bin: cfg.bin, session: cfg.session, timeoutMs: cfg.callTimeoutMs });
const session = await attachBrowserSession(client, cfg);
const ctx = {
  client,
  session,
  dryRun: false,
  log: (m) => console.log(m),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

// 1) 打开会话页并点开目标会话
await client.requireOk("browser_navigate", {
  target_id: session.targetId,
  tab_id: session.activeTabId,
  url: "https://lpt.liepin.com/chat/im",
});
await ctx.sleep(3_500);
// 会话行定位(联调教训:页面存在“收到了 X 的简历”等含名文案,必须精确匹配会话行名)
const snap0 = await snapshot(client, session);
const rowExact = snap0.refs.find(
  (r) => r.name === convName && r.role === "statictext" && r.actions.includes("click"),
);
const rowFuzzy = snap0.refs.find(
  (r) =>
    r.name !== null &&
    r.name.includes(convName) &&
    r.actions.includes("click") &&
    !/(收到了|这是|简历。$)/.test(r.name),
);
const row = rowExact ?? rowFuzzy;
if (row === undefined) {
  console.log(`未找到会话「${convName}」`);
  process.exit(1);
}
console.log(`[会话行] ${row.ref} role=${row.role} name=${row.name}`);
await clickRef(client, session, row.ref);
await ctx.sleep(2_000);

// 2) 键入消息(真实输入通道)
const typed = await typeIntoName(ctx, "输入", { names: ["请输入"], roles: ["textbox"] }, message, { timeoutMs: 10_000 });
if (!typed) {
  console.log("未找到输入框");
  process.exit(1);
}
await ctx.sleep(1_000);

// 3) 点击发送
const sent = await clickName(ctx, "发送", { names: ["发送"], roles: ["button"], excludeNames: ["发送消息"] }, { timeoutMs: 5_000 });
if (sent === null) {
  console.log("未找到发送按钮");
  process.exit(1);
}

// 4) 连拍观察消息回显
for (let i = 1; i <= 4; i++) {
  await ctx.sleep(1_500);
  const snap = await snapshot(client, session);
  const echoed = snap.refs.some((r) => r.name !== null && r.name.includes(message.slice(0, 10)));
  console.log(`t${i} refs=${snap.refs.length} 回显=${echoed}`);
}
