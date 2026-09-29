/**
 * 职位类别下拉展开探测(W5 联调):尝试 dom_event 合成点击 placeholder →
 * 回退 viewport 坐标 trusted 点击 → 连拍验证下拉选项出现。
 *
 * 用法: node scripts/probe-category-click.mjs
 */

import { loadConfigFromEnv } from "../dist/config.js";
import { DriverClient } from "../dist/cua/driver-client.js";
import { attachBrowserSession, snapshot } from "../dist/cua/session.js";

const cfg = loadConfigFromEnv();
const client = new DriverClient({ bin: cfg.bin, session: cfg.session, timeoutMs: cfg.callTimeoutMs });
const session = await attachBrowserSession(client, cfg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = (tool, args) =>
  client.callTool(tool, { target_id: session.targetId, tab_id: session.activeTabId, ...args });

function optionHits(snap) {
  // 排除导航/语言框噪音,仅认真实类别选项
  return snap.refs.filter(
    (r) =>
      r.name !== null &&
      r.name.length >= 2 &&
      r.name.length <= 20 &&
      /(销售|技术|运营|职能|金融|生产|产品|设计|客服|传媒|采购|人力|行政|电子|机械)/.test(r.name) &&
      !/(职位管理|人才管理|搜索人才|猎头服务|提效服务)/.test(r.name),
  );
}

// 基线
const base = await snapshot(client, session);
console.log(`[基线] url=${base.page.url} refs=${base.refs.length}`);

// 路线1: dom_event 点击 placeholder
const placeholder = base.refs.find((r) => r.name !== null && r.name.includes("请输入或选择职位类别"));
if (placeholder !== undefined) {
  console.log(`[路线1] dom_event click ref=${placeholder.ref}`);
  const res = await call("browser_click", { ref: placeholder.ref, input_route: "dom_event" });
  console.log(`  status=${res.status} refusal=${res.refusalCode ?? "-"} ${(res.refusalMessage ?? "").slice(0, 140)}`);
  await sleep(1_200);
  const s1 = await snapshot(client, session);
  console.log(`  refs=${s1.refs.length} 选项命中=${optionHits(s1).length}`);
  for (const r of optionHits(s1).slice(0, 20)) console.log(`    ${r.ref} ${r.role} ${r.name}`);
  if (optionHits(s1).length > 0) {
    for (const r of optionHits(s1).slice(0, 25)) console.log(`    ${r.ref} ${r.role} ${r.name}`);
    console.log("[结果] 路线1 展开成功");
    process.exit(0);
  }
}

// 路线2: viewport 坐标 trusted 点击(offset≈155:tab+地址栏高度)
const coords = [[900, 675], [1200, 675], [765, 675], [900, 645]];
for (const [x, y] of coords) {
  console.log(`[路线2] trusted click viewport=(${x},${y})`);
  const res = await call("browser_click", { x, y });
  console.log(`  status=${res.status} refusal=${res.refusalCode ?? "-"} ${(res.refusalMessage ?? "").slice(0, 120)}`);
  await sleep(900);
  const s = await snapshot(client, session);
  const hits = optionHits(s);
  console.log(`  refs=${s.refs.length} 选项命中=${hits.length}`);
  if (hits.length > 0) {
    for (const r of hits.slice(0, 25)) console.log(`    ${r.ref} ${r.role} ${r.name}`);
    console.log("[结果] 路线2 展开成功");
    process.exit(0);
  }
}
console.log("[结果] 均未展开");
