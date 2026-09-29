/**
 * 附件下载入口探测(W4 真机):邵女士会话 → 预览层 → 找附件卡片 →
 * 点击 → 连拍观察(viewer/下载触发)。
 *
 * 用法: node scripts/probe-attach.mjs
 */

import { loadConfigFromEnv } from "../dist/config.js";
import { DriverClient } from "../dist/cua/driver-client.js";
import { attachBrowserSession, clickRef, snapshot } from "../dist/cua/session.js";

const cfg = loadConfigFromEnv();
const client = new DriverClient({ bin: cfg.bin, session: cfg.session, timeoutMs: cfg.callTimeoutMs });
const session = await attachBrowserSession(client, cfg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1) 打开会话页 → 点邵女士会话
await client.requireOk("browser_navigate", {
  target_id: session.targetId,
  tab_id: session.activeTabId,
  url: "https://lpt.liepin.com/chat/im",
});
await sleep(3_500);

let snap = await snapshot(client, session);
const row =
  snap.refs.find((r) => r.name === "邵女士" && r.role === "statictext" && r.actions.includes("click")) ??
  snap.refs.find((r) => r.name !== null && r.name.includes("邵女士") && r.actions.includes("click") && !/收到了|简历。$/.test(r.name));
if (row === undefined) {
  console.log("未找到邵女士会话");
  process.exit(1);
}
await clickRef(client, session, row.ref);
await sleep(2_500);
console.log(`[会话] 已打开 ${row.ref}`);

// 2) 找附件卡片(预览层入口"查看简历" or 附件名)
snap = await snapshot(client, session);
const candidates = snap.refs.filter(
  (r) =>
    r.name !== null &&
    r.name.length <= 40 &&
    /(附件简历|的简历|\.pdf|简历\.)/.test(r.name) &&
    r.actions.includes("click"),
);
console.log(`[附件候选] ${candidates.length}`);
for (const c of candidates.slice(0, 15)) {
  console.log(`  ${c.ref} ${c.role} [${c.visibility ?? "?"}] ${JSON.stringify(c.name)}`);
}

// 3) 进入预览层(查看简历)
const viewResume = snap.refs.find((r) => r.name === "查看简历" && r.role === "button");
if (viewResume !== undefined) {
  await clickRef(client, session, viewResume.ref);
  await sleep(2_500);
  console.log("[预览层] 已点击查看简历");
  snap = await snapshot(client, session);
  const inPreview = snap.refs.filter((r) => r.name !== null && r.name.length <= 40 && /附件/.test(r.name));
  console.log(`[预览层附件相关] ${inPreview.length}`);
  for (const c of inPreview.slice(0, 15)) {
    console.log(`  ${c.ref} ${c.role} [${c.visibility ?? "?"}] [${c.actions.join(",")}] ${JSON.stringify(c.name)}`);
  }
}

// 4) 点击附件名节点
const pdfNode = snap.refs.find((r) => r.name !== null && /\.pdf|中文简历/.test(r.name));
if (pdfNode !== undefined) {
  console.log(`[点击附件] ${pdfNode.ref} ${JSON.stringify(pdfNode.name)} actions=[${pdfNode.actions.join(",")}]`);
  try {
    await clickRef(client, session, pdfNode.ref);
    console.log("[点击] 已投递");
  } catch (err) {
    console.log(`[点击失败] ${String(err).slice(0, 160)}`);
    // 尝试邻近可点节点
    const idx = snap.refs.indexOf(pdfNode);
    const near = snap.refs.slice(Math.max(0, idx - 5), idx + 6).filter((r) => r.actions.includes("click"));
    for (const n of near) {
      try {
        await clickRef(client, session, n.ref);
        console.log(`[邻近点击] ${n.ref} ${n.role} ${JSON.stringify(n.name)?.slice(0, 30)}`);
        break;
      } catch {
        /* next */
      }
    }
  }
  for (let i = 1; i <= 4; i++) {
    await sleep(1_800);
    const s = await snapshot(client, session);
    const dl = s.refs.filter((r) => r.name !== null && r.name.length <= 30 && /(下载|download)/i.test(r.name));
    console.log(`t${i} url=${s.page.url.slice(0, 90)} refs=${s.refs.length} 下载类节点=${dl.map((d) => d.name).join("|") || "-"}`);
  }
} else {
  console.log("[附件] 未找到 .pdf 节点");
}
