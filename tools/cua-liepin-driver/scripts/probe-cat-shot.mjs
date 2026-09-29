/**
 * 类别下拉点击+立即截图(W5 联调):尝试不同坐标,点击后 400ms 内截图,
 * 判断下拉是否展开(展开时截图可见选项列表)。
 *
 * 用法: node scripts/probe-cat-shot.mjs
 */

import { writeFileSync } from "node:fs";
import { loadConfigFromEnv } from "../dist/config.js";
import { DriverClient } from "../dist/cua/driver-client.js";
import { attachBrowserSession, snapshot } from "../dist/cua/session.js";

const cfg = loadConfigFromEnv();
const client = new DriverClient({ bin: cfg.bin, session: cfg.session, timeoutMs: cfg.callTimeoutMs });
const session = await attachBrowserSession(client, cfg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shot(out) {
  const res = await client.callTool("get_browser_state", {
    target_id: session.targetId,
    tab_id: session.activeTabId,
    include_screenshot: true,
  });
  const b64 = res.data.screenshot_png_b64;
  if (typeof b64 === "string" && b64 !== "") {
    writeFileSync(out, Buffer.from(b64, "base64"));
    return true;
  }
  return false;
}

// 候选坐标:类别输入框(UIA rc_select_1 物理(760,802)56高 → CSS x=380 y=258~286)
const coords = [
  [500, 272],
  [420, 272],
  [600, 272],
];
for (const [x, y] of coords) {
  const res = await client.callTool("browser_click", {
    target_id: session.targetId,
    tab_id: session.activeTabId,
    x,
    y,
  });
  console.log(`[click] (${x},${y}) status=${res.status} ${res.refusalCode ?? ""}`);
  await sleep(500);
  const snap = await snapshot(client, session);
  const hits = snap.refs.filter(
    (r) => r.name !== null && /(销售|技术|运营|职能|金融|生产|产品|设计|客服|传媒|采购|人力|行政|互联网|电子)/.test(r.name) && !/(职位管理|人才管理)/.test(r.name),
  );
  console.log(`  快照 refs=${snap.refs.length} 选项命中=${hits.length}`);
  if (hits.length > 0) {
    for (const r of hits.slice(0, 30)) console.log(`    ${r.ref} ${r.role} ${r.name}`);
    const ok = await shot(`pub-cat-open.png`);
    console.log(`[结果] 下拉已展开(截图: ${ok})`);
    process.exit(0);
  }
  const ok = await shot(`pub-cat-${x}-${y}.png`);
  console.log(`  截图=${ok}`);
}
console.log("[结果] 未展开");
