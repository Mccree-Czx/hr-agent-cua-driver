/**
 * 一次性侦察(反向对照):扫描全部会话的 oppositeRead 取值分布,验证字段语义。
 * 找一个 oppositeRead != "1" 的会话(未读样本),并 dump 其消息级 readflag 对照。
 * 仅输出结构信息(名称脱敏、字段取值),不输出消息内容。结束恢复用户标签页。
 */
import { CdpBrowser } from './dist/browser/cdp_browser.js';
import { safeGoto, readLptImId, lptFetch, LIEPIN_LPT_API } from './dist/common/lpt-utils.js';

const t0 = Date.now();
const mark = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const overall = setTimeout(() => { mark('!! 侦察超时(120s)'); process.exit(2); }, 120_000);
const mask = (n) => (n ? n.slice(0, 1) + '**' : '');

const cdp = new CdpBrowser();
let page = null;
try {
  page = await cdp.launch();
  await safeGoto(page, 'https://lpt.liepin.com/recommend');
  const imId = await readLptImId(page);
  const contacts = await lptFetch(page, `${LIEPIN_LPT_API}/api/com.liepin.im.b.contact.get-contact-list`, {
    body: `imUserType=2&imId=${encodeURIComponent(imId)}&imApp=1&pageSize=30&curPage=0`, clientId: '40342',
  });
  const list = contacts.data?.list || [];
  mark('会话总数=' + list.length);
  const dist = {};
  for (const c of list) dist[String(c.oppositeRead)] = (dist[String(c.oppositeRead)] || 0) + 1;
  mark('oppositeRead 分布: ' + JSON.stringify(dist));
  // 明细:名称脱敏 + direction + oppositeRead + unReadCnt
  for (const c of list) {
    mark(`  会话 ${mask(c.name)} dir=${c.direction} oppositeRead=${JSON.stringify(c.oppositeRead)} unReadCnt=${c.unReadCnt}`);
  }
  // 找未读样本(direction=0 且 oppositeRead != 1 优先),dump 消息级字段对照
  const sample = list.find((c) => c.direction === 0 && String(c.oppositeRead) !== '1')
    || list.find((c) => String(c.oppositeRead) !== '1');
  if (sample) {
    mark('未读样本: ' + mask(sample.name));
    const msgs = await lptFetch(page, `${LIEPIN_LPT_API}/api/com.liepin.im.b.chat.chat-list`, {
      body: `imUserType=2&imId=${encodeURIComponent(imId)}&imApp=1&oppositeImId=${encodeURIComponent(sample.oppositeImId)}&maxMessageId=&pageSize=8`,
      clientId: '40342',
    });
    const mlist = (msgs.data?.list || []).slice().reverse();
    mlist.forEach((m, i) => mark(`  msg#${i} dir=${m.direction} type=${m.msgType} readflag=${JSON.stringify(m.readflag)} oppositeRead=${JSON.stringify(m.oppositeRead)}`));
  } else {
    mark('未找到 oppositeRead != "1" 的样本(全部已读?)');
  }
  mark('侦察完成');
} catch (e) {
  mark('异常: ' + (e?.message || e));
} finally {
  clearTimeout(overall);
  try { if (page) { await safeGoto(page, 'https://lpt.liepin.com/chat/im'); mark('已恢复用户标签页'); } } catch (e) { mark('恢复失败: ' + e?.message); }
  cdp.disconnect();
  process.exit(0);
}
