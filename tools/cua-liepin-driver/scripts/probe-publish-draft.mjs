/**
 * 发布表单草稿保存实验(W5 联调):填职位名称 → 点击「保 存」→ 观察结果。
 *
 * 用法: node scripts/probe-publish-draft.mjs
 * 安全: 只保存草稿(不发布);标题明确标注为自动化测试职位。
 */

import { loadConfigFromEnv } from "../dist/config.js";
import { DriverClient } from "../dist/cua/driver-client.js";
import { attachBrowserSession, clickRef, snapshot } from "../dist/cua/session.js";

const TITLE = "【自动化测试】请勿投递-临时草稿";
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

// 1) 定位职位名称输入框(combobox + type,优先 in_viewport)
const snap0 = await snapshot(client, session);
const inputs = snap0.refs.filter(
  (r) => r.role === "combobox" && r.actions.includes("type"),
);
const input = inputs.find((r) => r.visibility === "in_viewport") ?? inputs[0];
if (input === undefined) {
  console.log(`未找到职位名称输入框(refs=${snap0.refs.length})`);
  process.exit(1);
}
console.log(`[输入框] ${input.ref} visibility=${input.visibility}`);

// 2) 写标题
const typed = await client.callTool("browser_type", {
  target_id: session.targetId,
  tab_id: session.activeTabId,
  ref: input.ref,
  text: TITLE,
  replace: true,
});
console.log(`[写入] ${typed.status} ${typed.refusalCode ?? ""}`);
await sleep(1_000);

// 3) 定位「保 存」按钮
const snap1 = await snapshot(client, session);
const saveBtn = snap1.refs.find(
  (r) => r.role === "button" && r.name !== null && /^保\s*存$/.test(r.name),
);
if (saveBtn === undefined) {
  console.log("未找到「保存」按钮");
  process.exit(1);
}
console.log(`[保存按钮] ${saveBtn.ref} visibility=${saveBtn.visibility}`);

// 4) 点击保存
try {
  await clickRef(client, session, saveBtn.ref);
  console.log("[点击] 已投递");
} catch (err) {
  console.log(`[点击失败] ${String(err).slice(0, 200)}`);
  process.exit(1);
}

// 5) 连拍观察
for (let i = 1; i <= 4; i++) {
  await sleep(2_000);
  const snap = await snapshot(client, session);
  const hint = snap.refs.find(
    (r) => r.name !== null && /(成功|失败|请填|请选择|不能为空|必填)/.test(r.name) && r.name.length <= 60,
  );
  console.log(`t${i} url=${snap.page.url} refs=${snap.refs.length} hint=${hint?.name ?? "-"}`);
}
