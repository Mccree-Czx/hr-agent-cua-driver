/**
 * 附件下载入口探测#2(W4):"收到简历"视图 → 勾选全部 → 浏览简历 → 观察。
 *
 * 用法: node scripts/probe-attach2.mjs
 */

import { writeFileSync } from "node:fs";
import { loadConfigFromEnv } from "../dist/config.js";
import { DriverClient } from "../dist/cua/driver-client.js";
import { attachBrowserSession, snapshot } from "../dist/cua/session.js";

const cfg = loadConfigFromEnv();
const client = new DriverClient({ bin: cfg.bin, session: cfg.session, timeoutMs: cfg.callTimeoutMs });
const session = await attachBrowserSession(client, cfg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1) semantic 找目标(优先) 
let snap = await snapshot(client, session, "浏览简历");
console.log(`[q=浏览简历] refs=${snap.refs.length}`);
for (const r of snap.refs.slice(0, 10)) console.log(`  ${r.ref} ${r.role} [${r.actions.join(",")}] ${JSON.stringify(r.name)}`);

// 2) 坐标勾选"全部" + 点"浏览简历"(截图估算 ×0.625)
const click = (x, y) =>
  client.callTool("browser_click", { target_id: session.targetId, tab_id: session.activeTabId, x, y });

let res = await click(409, 576);
console.log(`[勾选全部] (409,576) status=${res.status} ${res.refusalCode ?? ""}`);
await sleep(1_200);

res = await click(689, 576);
console.log(`[浏览简历] (689,576) status=${res.status} ${res.refusalCode ?? ""}`);

// 3) 连拍观察
for (let i = 1; i <= 5; i++) {
  await sleep(2_000);
  const s = await snapshot(client, session);
  console.log(`t${i} url=${s.page.url.slice(0, 100)} refs=${s.refs.length}`);
  const hints = s.refs.filter((r) => r.name !== null && r.name.length <= 40 && /(简历|下载|附件|在线预览|预览)/.test(r.name));
  for (const h of hints.slice(0, 8)) console.log(`   ${h.ref} ${h.role} [${h.actions.join(",")}] ${JSON.stringify(h.name)}`);
}

const shot = await client.callTool("get_browser_state", {
  target_id: session.targetId,
  tab_id: session.activeTabId,
  include_screenshot: true,
});
if (typeof shot.data.screenshot_png_b64 === "string") {
  writeFileSync("attach-view2.png", Buffer.from(shot.data.screenshot_png_b64, "base64"));
  console.log("[截图] attach-view2.png");
}
