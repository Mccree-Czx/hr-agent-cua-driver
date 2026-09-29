/**
 * 点击观测(联调校准工具):按可访问名定位元素 → 点击 → 连拍 URL/标题/节点数。
 *
 * 用法: node scripts/click-watch.mjs <名称片段|re:正则> [shotIntervalMs] [shots]
 * 用于确认入口点击的真实行为(同页跳转/新标签/无反应/弹窗)。
 * 名称以 re: 开头时按正则匹配(应对列表刷新导致的名字漂移,如 re:先生|女士)。
 */

import { loadConfigFromEnv } from "../dist/config.js";
import { DriverClient } from "../dist/cua/driver-client.js";
import { attachBrowserSession, clickRef, snapshot } from "../dist/cua/session.js";

const name = process.argv[2] ?? "沟通";
const intervalMs = Number.parseInt(process.argv[3] ?? "", 10) || 1_200;
const shots = Number.parseInt(process.argv[4] ?? "", 10) || 6;

const cfg = loadConfigFromEnv();
const client = new DriverClient({ bin: cfg.bin, session: cfg.session, timeoutMs: cfg.callTimeoutMs });
const session = await attachBrowserSession(client, cfg);

const before = await snapshot(client, session);
const isRegex = name.startsWith("re:");
const finder = isRegex
  ? (n) => new RegExp(name.slice(3)).test(n)
  : (n) => n.includes(name);
// 2026-09-29 联调教训:容器节点(role=generic)的聚合名里常含有目标文案,
// 直接 includes 会误点容器;策略:优先 button/link + 名称以目标结尾 + 排除超长名
const candidates = before.refs.filter((r) => r.name !== null && r.name.length <= 40 && finder(r.name));
const score = (r) => {
  let s = 0;
  if (r.role === "button" || r.role === "link") s += 4;
  if (isRegex ? new RegExp(name.slice(3) + "$").test(r.name ?? "") : (r.name ?? "").endsWith(name)) s += 2;
  if (r.actions.includes("click")) s += 1;
  return s;
};
const hit = candidates.sort((a, b) => score(b) - score(a))[0];
if (hit === undefined) {
  console.log(`未找到名称包含「${name}」的可访问节点(${before.refs.length} 个节点)`);
  process.exit(1);
}
console.log(`BEFORE url=${before.page.url} refs=${before.refs.length}`);
console.log(`CLICK ref=${hit.ref} role=${hit.role} name=${hit.name}`);
await clickRef(client, session, hit.ref);

for (let i = 1; i <= shots; i++) {
  await new Promise((resolve) => setTimeout(resolve, intervalMs));
  const s = await snapshot(client, session);
  console.log(`t${i} url=${s.page.url} title=${s.page.title} refs=${s.refs.length}`);
}
