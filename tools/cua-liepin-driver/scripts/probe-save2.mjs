/**
 * 草稿保存迭代探测(W5):点击「保 存」→ 连拍收集校验提示 → 输出缺口。
 * 前提:名称/类别/描述已填(不刷新)。
 *
 * 用法: node scripts/probe-save2.mjs
 */

import { writeFileSync } from "node:fs";
import { loadConfigFromEnv } from "../dist/config.js";
import { DriverClient } from "../dist/cua/driver-client.js";
import { attachBrowserSession, clickRef, snapshot } from "../dist/cua/session.js";

const cfg = loadConfigFromEnv();
const client = new DriverClient({ bin: cfg.bin, session: cfg.session, timeoutMs: cfg.callTimeoutMs });
const session = await attachBrowserSession(client, cfg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const snap = await snapshot(client, session);
const saveBtn = snap.refs.find((r) => r.role === "button" && r.name !== null && /^保\s*存$/.test(r.name));
if (saveBtn === undefined) {
  console.log("未找到保存按钮");
  process.exit(1);
}
console.log(`[保存按钮] ${saveBtn.ref} [${saveBtn.visibility}]`);
await clickRef(client, session, saveBtn.ref);
console.log("[点击] 已投递");

for (let i = 1; i <= 4; i++) {
  await sleep(2_000);
  const s = await snapshot(client, session);
  const hints = s.refs.filter((r) => r.name !== null && r.name.length <= 40 && /(请选择|请填|不能为空|必填|请输入|成功|失败)/.test(r.name));
  console.log(`t${i} url=${s.page.url} refs=${s.refs.length} hints=${JSON.stringify(hints.map((h) => h.name))}`);
  if (i === 1 && hints.length === 0) {
    // 没有提示时也截个图看看页面状态
    const shot = await client.callTool("get_browser_state", {
      target_id: session.targetId,
      tab_id: session.activeTabId,
      include_screenshot: true,
    });
    if (typeof shot.data.screenshot_png_b64 === "string") {
      writeFileSync("save-iter.png", Buffer.from(shot.data.screenshot_png_b64, "base64"));
      console.log("  截图: save-iter.png");
    }
  }
}
