/**
 * 推荐卡片预览层探针(联调):推荐页 → 点击第一张卡片姓名 → #preview 预览层
 * → 读取「简历编号」值(resIdEncode 候选) → 导航简历详情页验证。
 *
 * 用法: node scripts/probe-rec-preview.mjs
 * 背景: 卡片点击不改变 URL(仅 #preview),resIdEncode 在预览层「简历编号」字段;
 *       已验证 IM 会话预览层路径,本脚本验证推荐页路径同构性。
 */

import { loadConfigFromEnv } from "../dist/config.js";
import { DriverClient } from "../dist/cua/driver-client.js";
import { attachBrowserSession, clickRef, snapshot } from "../dist/cua/session.js";

const cfg = loadConfigFromEnv();
const client = new DriverClient({ bin: cfg.bin, session: cfg.session, timeoutMs: cfg.callTimeoutMs });
const session = await attachBrowserSession(client, cfg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1) 打开推荐页
await client.requireOk("browser_navigate", {
  target_id: session.targetId,
  tab_id: session.activeTabId,
  url: "https://lpt.liepin.com/recommend",
});
await sleep(3_500);

// 2) 找第一个候选人姓名节点(卡片姓名,如「X女士/X先生」)
const snap0 = await snapshot(client, session);
const nameNode = snap0.refs.find(
  (r) => r.role === "statictext" && r.name !== null && /^[\u4e00-\u9fa5]{1,3}(女士|先生)$/.test(r.name),
);
if (nameNode === undefined) {
  console.log(`未找到候选人姓名节点(${snap0.refs.length} 节点)`);
  process.exit(1);
}
console.log(`[卡片姓名] ${nameNode.ref} name=${nameNode.name} visibility=${nameNode.visibility}`);

// 3) 点击姓名打开预览层(若 offscreen 被拒,尝试滚动后再点)
try {
  await clickRef(client, session, nameNode.ref);
} catch (err) {
  console.log(`[点击失败] ${String(err).slice(0, 200)}`);
  console.log("[滚动] 尝试滚动页面后重试");
  await client.requireOk("browser_pointer", {
    target_id: session.targetId,
    tab_id: session.activeTabId,
    action: "scroll",
    delta_y: 700,
  });
  await sleep(1_500);
  const snapR = await snapshot(client, session);
  const retry = snapR.refs.find(
    (r) => r.role === "statictext" && r.name !== null && /^[\u4e00-\u9fa5]{1,3}(女士|先生)$/.test(r.name),
  );
  if (retry === undefined) {
    console.log("滚动后仍未见候选人姓名");
    process.exit(1);
  }
  await clickRef(client, session, retry.ref);
}
await sleep(2_500);

// 4) 快照 → 解析「简历编号」值(推荐预览层可能没有;有的则直接读)
const snap1 = await snapshot(client, session);
console.log(`[预览] url=${snap1.page.url} refs=${snap1.refs.length}`);
const idx = snap1.refs.findIndex((r) => r.name === "简历编号");
let value = null;
if (idx >= 0) {
  for (let i = idx + 1; i < Math.min(idx + 6, snap1.refs.length); i++) {
    const r = snap1.refs[i];
    if (r.role === "statictext" && r.name !== null && /^[A-Za-z0-9]{8,64}$/.test(r.name)) {
      value = r.name;
      break;
    }
  }
  console.log(`[简历编号] idx=${idx} value=${value}`);
} else {
  console.log("本预览层无「简历编号」;列出可点击入口(button/link):");
  for (const r of snap1.refs) {
    if ((r.role === "button" || r.role === "link") && r.name !== null && r.name.length <= 30) {
      console.log(`  ${r.ref} role=${r.role} actions=[${r.actions.join(",")}] name=${r.name}`);
    }
  }
  // 尝试点击「查看简历」深入
  const deeper = snap1.refs.find(
    (r) => r.role === "button" && r.name !== null && /查看简历|完整简历/.test(r.name),
  );
  if (deeper !== undefined) {
    console.log(`[深入] 点击 ${deeper.ref} name=${deeper.name}`);
    await clickRef(client, session, deeper.ref);
    await sleep(2_500);
    const snap2 = await snapshot(client, session);
    console.log(`[深入后] url=${snap2.page.url} refs=${snap2.refs.length}`);
    const idx2 = snap2.refs.findIndex((r) => r.name === "简历编号");
    if (idx2 >= 0) {
      for (let i = idx2 + 1; i < Math.min(idx2 + 6, snap2.refs.length); i++) {
        const r = snap2.refs[i];
        if (r.role === "statictext" && r.name !== null && /^[A-Za-z0-9]{8,64}$/.test(r.name)) {
          value = r.name;
          break;
        }
      }
      console.log(`[简历编号] value=${value}`);
    } else {
      console.log("深入后仍无「简历编号」;含「编号」节点:");
      for (const r of snap2.refs) {
        if (r.name !== null && r.name.length <= 40 && /编号/.test(r.name)) {
          console.log(`  ${r.ref} role=${r.role} name=${r.name}`);
        }
      }
    }
  }
}

// 5) 导航验证(若解析到值)
if (value !== null) {
  await client.requireOk("browser_navigate", {
    target_id: session.targetId,
    tab_id: session.activeTabId,
    url: `https://lpt.liepin.com/resume/detail?resIdEncode=${value}`,
  });
  await sleep(3_000);
  const snap2 = await snapshot(client, session);
  console.log(`[详情验证] title=${snap2.page.title} url=${snap2.page.url}`);
}
