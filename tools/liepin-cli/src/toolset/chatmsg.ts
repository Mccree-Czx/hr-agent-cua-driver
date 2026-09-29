/**
 * 猎聘聊天消息命令 - 招聘者端
 *
 * 走 LPT 接口 com.liepin.im.b.chat.chat-list（抓包确认）：
 *   body: imUserType=2&imId=<自己imId>&imApp=1&oppositeImId=<对方imId>&maxMessageId=&pageSize=20
 *   resp: data.list[] { msgId, msgTime(ms), msgType, direction, payload(JSON), msgSendImId, ... }
 * 入参是对方 imId（chatlist 返回的 im_id），不是旧的 chatId。
 */

import { Page } from 'puppeteer-core';
import { LIEPIN_LPT_API, lptFetch, navigateToLpt, readLptImId } from '../common/lpt-utils.js';

export interface ChatmsgOptions {
  oppositeImId: string;
  limit?: number;
  maxMessageId?: string;
  withMeta?: boolean | string;
}

/** 保留结构化证据，下载地址和凭据不进入命令输出；这些数据不是受信下载来源。 */
export function redactMetadata(value: any, depth = 0): any {
  if (depth > 20) return '[redacted-depth]';
  if (Array.isArray(value)) return value.map(item => redactMetadata(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      /token|cookie|authorization|password|secret|sign|credential|ticket|url|uri|href|key/i.test(key)
        ? '[redacted]' : redactMetadata(item, depth + 1),
    ]));
  }
  if (typeof value === 'string') {
    if (/^\s*[\[{]/.test(value)) {
      try {
        return JSON.stringify(redactMetadata(JSON.parse(value), depth + 1));
      } catch {
        // 括号开头的文件名或普通文本不是损坏的结构化载荷，保留原始类型。
      }
    }
    return value.replace(/https?:\/\/[^\s"'<>]+/gi, '[redacted-url]');
  }
  return value;
}

/** 展示字段始终为文本；卡片标签不是 JSON，合法 JSON 文本仍按敏感字段脱敏。 */
export function redactDisplayText(value: string): string {
  try {
    return JSON.stringify(redactMetadata(JSON.parse(value)));
  } catch {
    return value.replace(/https?:\/\/[^\s"'<>]+/gi, '[redacted-url]');
  }
}

export function payloadEvidence(payload: unknown): { value: any; status: string } {
  try {
    const value = typeof payload === 'string' ? JSON.parse(payload) : payload;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid');
    return { value: redactMetadata(value), status: 'parsed' };
  } catch {
    return { value: null, status: 'invalid' };
  }
}

export function chatPageResult(items: any[], data: any, request: object, withMeta?: boolean | string): any {
  if (withMeta !== true && withMeta !== 'true') return items;
  const { list: _list, ...metadata } = data;
  return {
    items,
    pagination: { request, response: redactMetadata(metadata), status: 'unverified', complete: false },
  };
}

/** 中国大陆手机号：候选人同意索要后，号码就落在卡片消息的 payload 里 */
const PHONE_PATTERN = /1[3-9]\d{9}/;

/**
 * 卡片类消息（如候选人同意「索要手机号」后回的那张卡）原本只输出 `[手机号]`，
 * 号码明文其实就在 payload 里。直接抽出来，省掉「还得人工去网页看一眼」这一步（issue #20）。
 */
export function parsePayload(payload: string): string {
  try {
    const body = JSON.parse(payload || '{}').bodies?.[0];
    if (body?.type === 'txt') return body.msg || '';
    const label = body?.type ? `[${body.type}]` : '';
    const phone = PHONE_PATTERN.exec(payload || '');
    if (phone) return label ? `${label} ${phone[0]}` : phone[0];
    return label;
  } catch {
    return '';
  }
}

export async function chatmsg(page: Page, options: ChatmsgOptions): Promise<any> {
  const { oppositeImId, limit = 50, maxMessageId = '' } = options;
  if (!Number.isInteger(Number(limit)) || Number(limit) < 1 || Number(limit) > 100) {
    throw new Error('limit 必须为 1-100 的整数');
  }
  if (typeof maxMessageId !== 'string') throw new Error('maxMessageId 必须为原始字符串游标');

  if (!oppositeImId) {
    throw new Error('对方 imId 不能为空（取 chatlist 结果里的 im_id）');
  }

  // 落到 LPT 同源页面拿 cookie/imId（消息走 api-lpt 接口）；旧 /im 路由已 404，改用 /recommend
  await navigateToLpt(page, '/recommend', 3);

  const imId = await readLptImId(page);
  if (!imId) {
    throw new Error('无法读取自己的 imId，请确保已登录招聘者端');
  }

  const body = `imUserType=2&imId=${encodeURIComponent(imId)}&imApp=1&oppositeImId=${encodeURIComponent(oppositeImId)}&maxMessageId=${encodeURIComponent(maxMessageId)}&pageSize=${Number(limit)}`;
  const data = await lptFetch(page, `${LIEPIN_LPT_API}/api/com.liepin.im.b.chat.chat-list`, {
    body,
    clientId: '40342',
  });

  if (data.flag !== 1) {
    throw new Error('获取聊天消息失败，未返回有效数据');
  }

  if (!Array.isArray(data.data?.list)) throw new Error('聊天响应缺少 list 数组');
  const seen = new Map<string, Set<string>>();
  const list = data.data.list.filter((item: any) => {
    const id = String(item.msgId ?? '');
    if (!id) return true;
    const versions = seen.get(id) || new Set<string>();
    const signature = JSON.stringify(item);
    if (versions.has(signature)) return false;
    versions.add(signature);
    seen.set(id, versions);
    return true;
  });
  // 接口按时间倒序返回，翻转成正序（旧→新）方便阅读
  const items = list.slice().reverse().map((item: any) => {
    const ts = item.msgTime ? new Date(Number(item.msgTime)) : null;
    const timeStr = ts
      ? `${ts.getFullYear()}-${String(ts.getMonth() + 1).padStart(2, '0')}-${String(ts.getDate()).padStart(2, '0')} ${String(ts.getHours()).padStart(2, '0')}:${String(ts.getMinutes()).padStart(2, '0')}`
      : '';
    const payload = payloadEvidence(item.payload);
    const { payload: _payload, ...metadata } = item;
    const senderId = String(item.msgSendImId ?? '');
    return {
      message_id: String(item.msgId ?? ''),
      sender_im_id: senderId,
      opposite_im_id: oppositeImId,
      duplicate_message_id: (seen.get(String(item.msgId ?? ''))?.size || 0) > 1,
      payload: payload.value,
      payload_status: payload.status,
      raw_metadata: redactMetadata(metadata),
      job_association: 'unknown',
      attachment_status: 'unverified',
      sender: senderId === String(imId) ? '我' : senderId === oppositeImId ? '对方' : '未知',
      content: redactDisplayText(parsePayload(item.payload)),
      time: timeStr,
      type: item.msgType || 'txt',
    };
  });
  return chatPageResult(items, data.data, { maxMessageId, pageSize: Number(limit) }, options.withMeta);
}

/** 聊天消息命令定义 */
export const chatmsgCommand = {
  name: 'chatmsg',
  description: '查看与某候选人的聊天记录（招聘端）',
  args: [
    { name: 'oppositeImId', type: 'string', required: true, positional: true, help: '对方 imId（chatlist 返回的 im_id）' },
    { name: 'limit', type: 'int', default: 50, help: '返回条数（1-100）' },
    { name: 'maxMessageId', type: 'string', default: '', help: '历史消息游标，原样透传；真实分页效果未验证' },
    { name: 'withMeta', type: 'boolean', default: false, help: '输出 items 和分页证据；不会自动翻页' },
  ],
  columns: [
    { header: '发送者', key: 'sender', width: 8 },
    { header: '内容', key: 'content', width: 60 },
    { header: '时间', key: 'time', width: 20 },
    { header: '类型', key: 'type', width: 10 },
  ],
  func: chatmsg,
};
