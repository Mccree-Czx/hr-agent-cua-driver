/**
 * 页面截图(联调校准工具):bind → 视图截图 → 落盘 PNG。
 * 用法: node scripts/capture-shot.mjs <outPng>
 * 说明: 后端字段名未文档化,脚本自动探测 data 中含长 base64 的字段。
 */

import { writeFileSync } from "node:fs";
import { loadConfigFromEnv } from "../dist/config.js";
import { DriverClient } from "../dist/cua/driver-client.js";
import { attachBrowserSession } from "../dist/cua/session.js";

const outPng = process.argv[2] ?? "shot.png";
const cfg = loadConfigFromEnv();
const client = new DriverClient({ bin: cfg.bin, session: cfg.session, timeoutMs: cfg.callTimeoutMs });
const session = await attachBrowserSession(client, cfg);

const data = await client.requireOk("get_browser_state", {
  target_id: session.targetId,
  tab_id: session.activeTabId,
  snapshot_format: "semantic_v2",
  include_screenshot: true,
});

function findBase64(node, path = "data") {
  if (typeof node === "string") {
    return /image|png|jpeg|jpg|screenshot|base64|data:image/i.test(path) && node.length > 1000
      ? { path, value: node }
      : null;
  }
  if (node !== null && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      const found = findBase64(v, `${path}.${k}`);
      if (found !== null) {
        return found;
      }
    }
  }
  return null;
}

writeFileSync(`${outPng}.json`, JSON.stringify(data, null, 1), "utf8");
const hit = findBase64(data);
if (hit === null) {
  const keys = [];
  const walk = (n, p) => {
    if (n !== null && typeof n === "object") {
      for (const [k, v] of Object.entries(n)) {
        keys.push(`${p}.${k}:${typeof v === "string" ? v.length : Array.isArray(v) ? `[${v.length}]` : typeof v}`);
        walk(v, `${p}.${k}`);
      }
    }
  };
  walk(data, "data");
  console.log("未找到截图字段。字段清单:\n" + keys.slice(0, 60).join("\n"));
  process.exit(1);
}
writeFileSync(outPng, Buffer.from(hit.value.replace(/^data:image\/\w+;base64,/, ""), "base64"));
console.log(`SHOT: ${outPng} (来自 ${hit.path}, ${hit.value.length} b64 字符)`);
