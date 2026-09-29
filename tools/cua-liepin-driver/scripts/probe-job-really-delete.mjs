/**
 * 删除待发布职位(W5 真机验证):待发布 tab → 全选 → 删除 → 确认 → 验证。
 *
 * 用法: node scripts/probe-job-really-delete.mjs
 * 安全: 仅用于"待发布"的唯一测试职位(当前场景),删除前打印目标行名。
 */

import { writeFileSync } from "node:fs";
import { loadConfigFromEnv } from "../dist/config.js";
import { DriverClient } from "../dist/cua/driver-client.js";
import { attachBrowserSession, clickRef, snapshot } from "../dist/cua/session.js";

const cfg = loadConfigFromEnv();
const client = new DriverClient({ bin: cfg.bin, session: cfg.session, timeoutMs: cfg.callTimeoutMs });
const session = await attachBrowserSession(client, cfg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1) 确保在"待发布" tab
let snap = await snapshot(client, session);
const tab = snap.refs.find((r) => r.name === "待发布" && r.actions.includes("click"));
if (tab !== undefined) {
  await clickRef(client, session, tab.ref);
  await sleep(2_000);
}

// 2) 检查行(打印目标,安全确认)
snap = await snapshot(client, session);
const navNames = ["人才推荐", "职位管理", "搜索人才", "沟通", "人才管理", "猎头服务", "提效服务", "问 Lily", "意向人选", "急聘置顶", "火爆刷"];
const rows = snap.refs.filter(
  (r) =>
    r.role === "link" &&
    r.name &&
    r.name.length >= 4 &&
    r.name.length <= 40 &&
    !navNames.some((n) => r.name.includes(n)) &&
    !/^\d+\s*\/\s*\d+$/.test(r.name),
);
console.log(`[待发布行] ${rows.map((r) => r.name).join(" | ")}`);
if (rows.length === 0) {
  console.log("无行,退出");
  process.exit(0);
}

// 3) 全选
const labels = snap.refs.filter((r) => r.role === "labeltext" && r.actions.includes("click"));
const box = labels[labels.length - 1];
if (box === undefined) {
  console.log("无全选框");
  process.exit(1);
}
await clickRef(client, session, box.ref);
await sleep(1_200);

// 4) 删除
snap = await snapshot(client, session);
const delBtn = snap.refs.find((r) => r.role === "button" && r.name !== null && /删除/.test(r.name) && r.actions.includes("click"));
if (delBtn === undefined) {
  console.log("未找到删除按钮");
  process.exit(1);
}
console.log(`[删除] 点击 ${delBtn.ref} ${JSON.stringify(delBtn.name)}`);
await clickRef(client, session, delBtn.ref);
await sleep(1_800);

// 5) 确认弹窗
snap = await snapshot(client, session);
const hints = snap.refs.filter((r) => r.name !== null && r.name.length <= 40 && /确定|确认|删除|取消/.test(r.name));
console.log("[弹窗文本]");
for (const h of hints.slice(0, 10)) console.log(`  ${h.ref} ${h.role} ${JSON.stringify(h.name)}`);
const confirm = snap.refs.find((r) => r.role === "button" && r.name !== null && /^(确定|确认|删除)$/.test(r.name) && r.actions.includes("click"));
if (confirm !== undefined) {
  console.log(`[确认] 点击 ${confirm.ref} ${JSON.stringify(confirm.name)}`);
  await clickRef(client, session, confirm.ref);
  await sleep(2_000);
} else {
  console.log("[确认] 未找到确认按钮(可能无弹窗或按钮文案不同)");
}

// 6) 验证
for (let i = 1; i <= 3; i++) {
  await sleep(1_500);
  const s = await snapshot(client, session);
  const remains = s.refs.filter((r) => r.role === "link" && r.name && rows.some((row) => row.name === r.name));
  const ok = s.refs.find((r) => r.name !== null && /(删除成功|操作成功|已删除)/.test(r.name));
  console.log(`t${i} 残留行=${remains.length} 成功提示=${ok?.name ?? "-"}`);
  if (remains.length === 0 || ok !== undefined) break;
}

const shot = await client.callTool("get_browser_state", {
  target_id: session.targetId,
  tab_id: session.activeTabId,
  include_screenshot: true,
});
if (typeof shot.data.screenshot_png_b64 === "string") {
  writeFileSync("delete-result.png", Buffer.from(shot.data.screenshot_png_b64, "base64"));
  console.log("[截图] delete-result.png");
}
