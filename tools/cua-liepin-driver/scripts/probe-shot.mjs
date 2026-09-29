/**
 * 带截图快照(W5 联调):拉取视口 PNG 用于精确定位控件坐标。
 *
 * 用法: node scripts/probe-shot.mjs <outPng> [query]
 */

import { writeFileSync } from "node:fs";
import { loadConfigFromEnv } from "../dist/config.js";
import { DriverClient } from "../dist/cua/driver-client.js";
import { attachBrowserSession } from "../dist/cua/session.js";

const outPng = process.argv[2] ?? "shot.png";
const query = process.argv[3] ?? "";

const cfg = loadConfigFromEnv();
const client = new DriverClient({ bin: cfg.bin, session: cfg.session, timeoutMs: cfg.callTimeoutMs });
const session = await attachBrowserSession(client, cfg);

const args = {
  target_id: session.targetId,
  tab_id: session.activeTabId,
  snapshot_format: "semantic_v2",
  include_screenshot: true,
};
if (query !== "") {
  args.query = query;
}
const res = await client.callTool("get_browser_state", args);
console.log(`status=${res.status} ${res.refusalCode ?? ""}`);
const data = res.data;
const b64 = data.screenshot_png_b64;
if (typeof b64 !== "string" || b64 === "") {
  console.log("无截图数据; keys=" + Object.keys(data).join(","));
  process.exit(1);
}
writeFileSync(outPng, Buffer.from(b64, "base64"));
console.log(`PNG=${outPng} size=${data.screenshot_width}x${data.screenshot_height}`);
console.log(`page=${JSON.stringify(data.page ?? {})}`);
const refs = (data.refs ?? []).concat(data.content_refs ?? []);
console.log(`refs=${refs.length}`);
