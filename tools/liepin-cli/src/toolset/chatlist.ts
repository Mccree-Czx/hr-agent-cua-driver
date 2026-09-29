/**
 * 猎聘聊天列表命令 - 招聘者端
 */

import { Page } from 'puppeteer-core';
import { LIEPIN_LPT_API, navigateToLpt, lptFetch, readLptImId } from '../common/lpt-utils.js';
import { chatPageResult, payloadEvidence, redactDisplayText, redactMetadata } from './chatmsg.js';

export interface ChatlistOptions {
  limit?: number;
  page?: number;
  withMeta?: boolean | string;
}

export async function chatlist(page: Page, options: ChatlistOptions): Promise<any> {
  const { limit = 30, page: pageNum = 1 } = options;
  if (!Number.isSafeInteger(Number(pageNum)) || Number(pageNum) < 1) throw new Error('page 页码必须为正整数');
  if (!Number.isInteger(Number(limit)) || Number(limit) < 1 || Number(limit) > 100) {
    throw new Error('limit 必须为 1-100 的整数');
  }

  // 实测(2026-09-27):平台对 pageSize>50 会静默降级为默认 20(请求 100 实得 20,
  // 造成会话盲区——轮询看不到被挤出窗口的候选人);单页生效上限为 50,这里主动钳制。
  // 注意:不得向 stderr 输出任何提示——后端把 stderr 并入 stdout 后用取首个
  // 中括号的方式解析 JSON,含 [ 的杂音会直接破坏 chatlist 解析(2026-09-27 事故)
  const effectiveLimit = Math.min(Number(limit), 50);

  // 落到 LPT 同源页面拿 cookie/imId（IM 数据走 api-lpt 接口，不依赖页面 DOM）；
  // 旧 /im 路由已被猎聘改版删除会 404，改用有效路由 /recommend
  await navigateToLpt(page, '/recommend', 3);

  // 读取 imId
  const imId = await readLptImId(page);
  if (!imId) {
    throw new Error('无法读取 imId，请确保已登录招聘者端');
  }

  // 获取聊天列表
  const body = `imUserType=2&imId=${encodeURIComponent(imId)}&imApp=1&pageSize=${effectiveLimit}&curPage=${Number(pageNum) - 1}`;
  const data = await lptFetch(page, `${LIEPIN_LPT_API}/api/com.liepin.im.b.contact.get-contact-list`, { 
    body, 
    clientId: '40342' 
  });

  if (data.flag !== 1) {
    throw new Error('获取聊天列表失败，未返回有效数据');
  }

  if (!Array.isArray(data.data?.list)) throw new Error('聊天列表响应缺少 list 数组');
  const contacts = data.data.list;

  const items = contacts.slice(0, effectiveLimit).map((c: any) => {
    // 解析最后消息
    let latestMsg = '';
    try {
      const payload = JSON.parse(c.lastPayload || '{}');
      const body = payload.bodies?.[0];
      if (body?.type === 'txt') latestMsg = body.msg || '';
    } catch (_) {}

    // 格式化时间
    const ts = c.latestMsgTime ? new Date(c.latestMsgTime) : null;
    const timeStr = ts ? `${ts.getFullYear()}-${String(ts.getMonth() + 1).padStart(2, '0')}-${String(ts.getDate()).padStart(2, '0')} ${String(ts.getHours()).padStart(2, '0')}:${String(ts.getMinutes()).padStart(2, '0')}` : '';

    const lastPayload = payloadEvidence(c.lastPayload);
    const { lastPayload: _lastPayload, ...metadata } = c;
    return {
      last_payload: lastPayload.value,
      payload_status: lastPayload.status,
      raw_metadata: redactMetadata(metadata),
      job_association: 'unknown',
      attachment_status: 'unverified',
      name: c.name || '',
      sex: c.sex || '',
      experience: c.workage ? `${c.workage}年` : '',
      degree: c.edulevel || '',
      city: c.dq || '',
      current_company: c.company || '',
      current_title: c.title || '',
      latest_msg: redactDisplayText(latestMsg),
      latest_msg_time: timeStr,
      unread_count: String(c.unReadCnt || 0),
      direction: String(c.direction ?? ''),
      // chatmsg 需要的"对方 imId"，而非自己的 imId
      im_id: String(c.oppositeImId || ''),
      user_id: String(c.oppositeUserId || ''),
    };
  });
  return chatPageResult(items, data.data, { curPage: Number(pageNum) - 1, pageSize: effectiveLimit }, options.withMeta);
}

/** 聊天列表命令定义 */
export const chatlistCommand = {
  name: 'chatlist',
  description: '查看聊天列表（招聘端）',
  args: [
    { name: 'limit', type: 'int', default: 30, help: '返回条数（1-100；实测平台单页生效上限 50，超出按 50 请求）' },
    { name: 'page', type: 'int', default: 1, help: '页码（1-based，透传 curPage）；真实分页效果未验证' },
    { name: 'withMeta', type: 'boolean', default: false, help: '输出 items 和分页证据；不会自动翻页' },
  ],
  columns: [
    { header: '姓名', key: 'name', width: 10 },
    { header: '职位', key: 'current_title', width: 20 },
    { header: '公司', key: 'current_company', width: 15 },
    { header: '最后消息', key: 'latest_msg', width: 30 },
    { header: '时间', key: 'latest_msg_time', width: 15 },
    { header: '未读', key: 'unread_count', width: 5 },
  ],
  func: chatlist,
};
