/**
 * 提交发布(W5):点击「发布职位」→ 处理确认弹窗 → 验证跳转/成功。
 *
 * 用法: node scripts/probe-publish-submit.mjs
 */

import { writeFileSync } from "node:fs";
import { loadConfigFromEnv } from "../dist/config.js";
import { DriverClient } from "../dist/cua/driver-client.js";
import { attachBrowserSession, clickRef, snapshot } from "../dist/cua/session.js";

const cfg = loadConfigFromEnv();
const client = new DriverClient({ bin: cfg.bin, session: cfg.session, timeoutMs: cfg.callTimeoutMs });
const session = await attachBrowserSession(client, cfg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const snap0 = await snapshot(client, session);
const submit = snap0.refs.find((r) => r.role === "button" && r.name !== null && r.name === "发布职位");
if (submit === undefined) {
  console.log("未找到「发布职位」按钮;候选:");
  for (const r of snap0.refs.filter((x) => x.role === "button" && x.name !== null && /发布/.test(x.name))) {
    console.log(`  ${r.ref} [${r.visibility}] ${JSON.stringify(r.name)} actions=[${r.actions.join(",")}]`);
  }
  process.exit(1);
}
console.log(`[发布] ${submit.ref} [${submit.visibility}]`);
await clickRef(client, session, submit.ref);
console.log("[点击] 已投递");

for (let i = 1; i <= 6; i++) {
  await sleep(2_000);
  const s = await snapshot(client, session);
  const hints = s.refs.filter((r) => r.name !== null && r.name.length <= 40 && /(成功|失败|请选择|请填|不能为空|确认|确定)/.test(r.name));
  console.log(`t${i} url=${s.page.url} refs=${s.refs.length}`);
  for (const h of hints.slice(0, 8)) console.log(`   hint: ${h.ref} ${h.role} ${JSON.stringify(h.name)}`);
  // 确认弹窗处理(仅第2轮起)
  const confirm = hints.find((h) => h.role === "button" && h.name !== null && /^(确定|确认|确认发布|继续发布)$/.test(h.name));
  if (i >= 2 && confirm !== undefined) {
    console.log(`[确认弹窗] 点 ${confirm.ref} ${confirm.name}`);
    await clickRef(client, session, confirm.ref);
  }
  if (s.page.url.includes("/job/manager")) {
    console.log("[结果] 已跳转职位管理页(发布成功强信号)");
    break;
  }
}

const shot = await client.callTool("get_browser_state", {
  target_id: session.targetId,
  tab_id: session.activeTabId,
  include_screenshot: true,
});
if (typeof shot.data.screenshot_png_b64 === "string") {
  writeFileSync("submit-result.png", Buffer.from(shot.data.screenshot_png_b64, "base64"));
  console.log("[截图] submit-result.png");
}
