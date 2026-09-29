/**
 * 一次性侦察:确认消息"已读"字段(2026-09-26)。
 *
 * 目标会话:胡先生(UI 显示我方两条消息均为"已读",且其已回复=已读真值样本)。
 * 仅输出结构信息:字段名、read 相关字段取值、消息方向/时间;不输出消息内容与候选人隐私正文。
 * 结束恢复用户标签页 -> /chat/im。
 */
import { CdpBrowser } from './dist/browser/cdp_browser.js';
import { safeGoto, readLptImId, lptFetch, LIEPIN_LPT_API } from './dist/common/lpt-utils.js';

const TARGET_NAME = '胡先生';
const t0 = Date.now();
const mark = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const overall = setTimeout(() => { mark('!! 侦察超时(120s)'); process.exit(2); }, 120_000);

const cdp = new CdpBrowser();
let page = null;
try {
  page = await cdp.launch();
  await safeGoto(page, 'https://lpt.liepin.com/recommend');
  const imId = await readLptImId(page);
  mark('就绪,自己的 imId len=' + String(imId).length);

  // 1. 会话列表:找目标会话,并 dump 会话对象的字段结构
  const contactsBody = `imUserType=2&imId=${encodeURIComponent(imId)}&imApp=1&pageSize=30&curPage=0`;
  const contacts = await lptFetch(page, `${LIEPIN_LPT_API}/api/com.liepin.im.b.contact.get-contact-list`, {
    body: contactsBody, clientId: '40342',
  });
  const session = (contacts.data?.list || []).find((c) => c.name === TARGET_NAME);
  if (!session) throw new Error('未在会话列表找到 ' + TARGET_NAME);
  const sessionKeys = Object.keys(session).sort();
  mark('会话字段清单: ' + sessionKeys.join(','));
  const sessionReadFields = Object.fromEntries(
    sessionKeys.filter((k) => /read|unread/i.test(k)).map((k) => [k, session[k]]),
  );
  mark('会话 read 相关取值: ' + JSON.stringify(sessionReadFields));
  const oppositeImId = String(session.oppositeImId || '');
  mark('direction=' + session.direction + ' latestMsgTime=' + session.latestMsgTime);

  // 2. 该会话消息:dump 最近消息的字段结构(read 相关取值 + 方向/类型/时间),不打印内容
  const msgBody = `imUserType=2&imId=${encodeURIComponent(imId)}&imApp=1&oppositeImId=${encodeURIComponent(oppositeImId)}&maxMessageId=&pageSize=10`;
  const msgs = await lptFetch(page, `${LIEPIN_LPT_API}/api/com.liepin.im.b.chat.chat-list`, {
    body: msgBody, clientId: '40342',
  });
  const list = (msgs.data?.list || []).slice().reverse(); // 正序
  mark('消息数=' + list.length);
  list.forEach((m, i) => {
    const keys = Object.keys(m).sort();
    const readish = Object.fromEntries(keys.filter((k) => /read|status/i.test(k)).map((k) => [k, m[k]]));
    mark(`msg#${i} dir=${m.direction} type=${m.msgType} time=${m.msgTime} sendImlen=${String(m.msgSendImId || '').length} keys=[${keys.join(',')}] readish=${JSON.stringify(readish)}`);
  });
  mark('侦察完成');
} catch (e) {
  mark('异常: ' + (e?.message || e));
} finally {
  clearTimeout(overall);
  try {
    if (page) { await safeGoto(page, 'https://lpt.liepin.com/chat/im'); mark('已恢复用户标签页'); }
  } catch (e) { mark('恢复失败(可忽略): ' + (e?.message || e)); }
  cdp.disconnect();
  process.exit(0);
}
