/**
 * probe-shotmode: include_screenshot:true 是否改变快照完整度(强制 tab 视口捕获)。
 * 用法: node probe-shotmode.mjs
 */
import { loadConfigFromEnv } from "./dist/config.js";
import { DriverClient } from "./dist/cua/driver-client.js";
import { ensureBrowserSession, snapshot } from "./dist/cua/session.js";

const cfg = loadConfigFromEnv();
const client = new DriverClient({ bin: cfg.bin, session: "hr-shotmode", timeoutMs: 180000 });
const session = await ensureBrowserSession(client, cfg, { launchIfMissing: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nav = (url) =>
  client.callTool("browser_navigate", { target_id: session.targetId, tab_id: session.activeTabId, url });

for (let i = 1; i <= 3; i++) {
  await nav("about:blank");
  await sleep(900);
  await nav("https://lpt.liepin.com/job/manager");
  await sleep(3200);
  const res = await client.callTool("get_browser_state", {
    target_id: session.targetId,
    tab_id: session.activeTabId,
    snapshot_format: "semantic_v2",
    include_screenshot: true,
  });
  const all = [...(res.data.refs ?? []), ...(res.data.content_refs ?? [])];
  const hasJob = all.some((r) => r?.name === "海外ToB渠道销售（出海品牌）");
  const img = typeof res.data.screenshot_png_b64 === "string" ? res.data.screenshot_png_b64.length : 0;
  console.log(`S${i}: status=${res.status} refs=${all.length} named=${all.filter((r) => r?.name).length} 职位行=${hasJob} png=${img}`);
  if (hasJob) {
    console.log("SUCCESS with screenshot mode at", i);
    break;
  }
  await sleep(3000);
}
