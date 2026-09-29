/**
 * 帧诊断(联调校准):检查语义快照的帧归属与内容覆盖(refs vs content_refs)。
 * 用法: node scripts/frame-check.mjs [关键词...]
 */

import { loadConfigFromEnv } from "../dist/config.js";
import { DriverClient } from "../dist/cua/driver-client.js";
import { attachBrowserSession } from "../dist/cua/session.js";

const keywords = process.argv.slice(2);
const cfg = loadConfigFromEnv();
const client = new DriverClient({ bin: cfg.bin, session: cfg.session, timeoutMs: cfg.callTimeoutMs });
const s = await attachBrowserSession(client, cfg);
const d = await client.requireOk("get_browser_state", {
  target_id: s.targetId,
  tab_id: s.activeTabId,
  snapshot_format: "semantic_v2",
});

const refs = d.refs ?? [];
const contentRefs = d.content_refs ?? [];
console.log("refs=", refs.length, "content_refs=", contentRefs.length);
const frames = new Map();
for (const r of [...refs, ...contentRefs]) {
  frames.set(r.frame, (frames.get(r.frame) ?? 0) + 1);
}
console.log("frames:", JSON.stringify([...frames.entries()]));
console.log("oopif:", JSON.stringify(d.oopif ?? {}));
console.log("snapshot:", JSON.stringify(d.snapshot ?? {}));

for (const kw of keywords.length > 0 ? keywords : ["求职意向", "海外销售"]) {
  const hit = [...refs, ...contentRefs].filter((r) => typeof r.name === "string" && r.name.includes(kw));
  console.log(`[${kw}] nodes=${hit.length}`, JSON.stringify(hit.slice(0, 3)));
}
