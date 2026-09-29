/**
 * 一次性诊断:定位 chatlist 调用在共享浏览器上的挂起点(2026-09-26)。
 *
 * 背景:后端每小时轮询的 chatlist 连续两次(14:14/14:59)耗尽 3 分钟超时被强杀,
 * 期间无任何输出;同期其它命令(resume/greet/recommend)正常,需定位挂在哪一步。
 *
 * 步骤与 chatlist 命令内部一致,逐步计时;整体 150s 自终止,未完成的步骤即挂起点。
 * 结束时尽力把用户标签页恢复回 /chat/im。
 */
import { CdpBrowser } from './dist/browser/cdp_browser.js';
import { safeGoto, readLptImId, lptFetch, LIEPIN_LPT_API } from './dist/common/lpt-utils.js';

const t0 = Date.now();
const mark = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const overall = setTimeout(() => {
  mark('!! 总体超时(150s):最后一个 [start] 之后没有 [ok] 的步骤即为挂起点');
  process.exit(2);
}, 150_000);

const cdp = new CdpBrowser();
let page = null;
try {
  mark('start: launch(connect→pages→setViewport)');
  page = await cdp.launch();
  mark('ok: launch;当前页面=' + page.url().slice(0, 60));

  mark('start: safeGoto /recommend');
  await safeGoto(page, 'https://lpt.liepin.com/recommend');
  mark('ok: safeGoto; url=' + page.url().slice(0, 60));
  await new Promise((r) => setTimeout(r, 3000));

  mark('start: readLptImId');
  const imId = await readLptImId(page);
  mark('ok: readLptImId=' + String(imId || '').slice(0, 10) + '...(len ' + String(imId || '').length + ')');

  mark('start: lptFetch contact-list');
  const body = `imUserType=2&imId=${encodeURIComponent(imId)}&imApp=1&pageSize=30&curPage=0`;
  const data = await lptFetch(page, `${LIEPIN_LPT_API}/api/com.liepin.im.b.contact.get-contact-list`, {
    body,
    clientId: '40342',
  });
  mark('ok: lptFetch flag=' + data.flag + ' count=' + (data.data?.list?.length ?? '?'));

  mark('诊断完成:未复现挂起');
} catch (e) {
  mark('异常: ' + (e?.message || e));
} finally {
  clearTimeout(overall);
  try {
    if (page) {
      mark('恢复用户标签页 -> /chat/im');
      await safeGoto(page, 'https://lpt.liepin.com/chat/im');
      mark('ok: 已恢复');
    }
  } catch (e) {
    mark('恢复失败(可忽略): ' + (e?.message || e));
  }
  cdp.disconnect();
  process.exit(0);
}
