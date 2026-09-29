/**
 * 猎聘「获取简历附件」命令 - 招聘者端(API 路线,2026-09-26 真机契约)
 *
 * 背景:附件卡片不是独立消息,而是挂在候选人消息的 `payload.ext.extBody.bizData` 上
 * (bizType === "7"),其 `attachmentResume.param` 为 JSON 字符串(含 attachmentSign)。
 *
 * 真机验证链路(2026-09-26):
 *   1. POST com.liepin.im.b.chat.chat-list        → 找 bizType=7 且含 attachmentResume.param 的消息
 *   2. POST com.liepin.zhuque.resumeview.get-resume-attachment
 *      body: fileSign=<attachmentSign>&download=1 → {accessPath, fileName, fileExtension}
 *   3. window.open(accessPath)(userGesture) + CDP 下载通道(allowAndName)→ 落盘校验 %PDF-
 *
 * 安全约定:
 *   - attachmentSign(签名)仅在进程内流转,绝不写入输出/日志;
 *   - 下载来源必须属于 liepin.com 域,否则取消;
 *   - 全程不打开会话、不改会话已读状态(纯接口路线)。
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Page } from 'puppeteer-core';
import { LIEPIN_LPT_API, lptFetch, navigateToLpt, readLptImId } from '../common/lpt-utils.js';
import { requirePage } from '../common/utils.js';

export interface AttachFetchOptions {
  /** 目标会话的对方 im_id */
  imId: string;
  /** 附件下载落盘目录 */
  outDir: string;
  /** 允许的最大字节数,默认 20MiB */
  maxBytes?: number;
}

export type AttachFetchResult =
  | { found: false; success: false; reason: 'no-attachment' }
  | { found: true; success: false; reason: 'fetch-failed' | 'download-failed' | 'verify-failed'; detail: string }
  | {
      found: true;
      success: true;
      file: string;
      bytes: number;
      sha256: string;
      fileName: string;
      fileExtension: string;
      sourceOrigin: string;
      via: 'api';
    };

/** 附件卡片消息的 bizType(真机确认) */
const ATTACHMENT_BIZ_TYPE = '7';
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 60000;
/** 下载来源必须属于 liepin.com 域(真机确认附件由 tdoss 签发;此处放宽到全域并仍校验) */
const LEPIN_ORIGIN_PATTERN = /^https:\/\/([a-z0-9-]+\.)*liepin\.com$/i;
/** allowAndName 落盘文件名就是 guid,必须是无路径分隔符的安全标识 */
const GUID_PATTERN = /^[a-zA-Z0-9-]+$/;

/**
 * 从 chat-list 消息列表中找最新的附件卡片消息,提取 attachmentSign(仅内存使用)。
 * 仅扫描「对方」发送的消息(与轮询的附件发送方原则一致,不把我方卡片当候选人简历)。
 * 返回 null 表示确无附件(不是错误)。
 */
export function findAttachmentSign(list: any[], oppositeImId: string): string | null {
  for (const message of list) {
    // 仅对方消息:我方发出的卡片(如平台回执)不得作为附件来源(不猜)
    if (String(message?.msgSendImId ?? '') !== oppositeImId) continue;
    let payload = message?.payload;
    if (typeof payload === 'string') {
      try {
        payload = JSON.parse(payload);
      } catch {
        continue;
      }
    }
    const bizData = payload?.ext?.extBody?.bizData;
    if (!bizData || String(bizData.bizType) !== ATTACHMENT_BIZ_TYPE) continue;
    const paramText = bizData.attachmentResume?.param;
    if (typeof paramText !== 'string' || !paramText.trim()) continue;
    try {
      const param = JSON.parse(paramText);
      const sign = param?.attachmentSign;
      if (typeof sign === 'string' && sign.trim()) {
        return sign.trim();
      }
    } catch {
      // param 非法:视为该条无附件,继续找(不猜)
    }
  }
  return null;
}

/** 获取用于捕获浏览器下载的 CDP 会话(浏览器级;与 attach-download 同策略) */
async function createDownloadSession(page: Page) {
  const browser = page.browser();
  if (browser) {
    return browser.target().createCDPSession();
  }
  return page.target().createCDPSession();
}

/**
 * 经浏览器下载通道把 accessPath 落盘;完成后尽力关闭 window.open 产生的标签页。
 */
async function captureDownload(page: Page, options: { url: string; outDir: string; maxBytes: number }) {
  const { url, outDir, maxBytes } = options;
  const downloadSession = await createDownloadSession(page);
  const triggerSession = await page.target().createCDPSession();
  let observed: { guid: string; origin: string } | null = null;
  let settled = false;
  let resolveDone!: (value: { guid: string; origin: string; bytes: number }) => void;
  let rejectDone!: (error: Error) => void;
  const completion = new Promise<{ guid: string; origin: string; bytes: number }>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  completion.catch(() => {});
  const finish = (settle: () => void) => {
    if (settled) return;
    settled = true;
    settle();
  };
  const cancel = async (guid: string) => {
    try {
      await downloadSession.send('Browser.cancelDownload', { guid });
    } catch {
      /* 可能已经结束,忽略 */
    }
  };

  downloadSession.on('Browser.downloadWillBegin', (params: any) => {
    let origin = '';
    try {
      origin = new URL(params.url).origin;
    } catch {
      origin = '';
    }
    if (observed || !LEPIN_ORIGIN_PATTERN.test(origin)) {
      void cancel(params.guid).then(() =>
        finish(() => rejectDone(new Error('下载来源未知或出现额外下载,已取消'))),
      );
      return;
    }
    if (!GUID_PATTERN.test(params.guid)) {
      void cancel(params.guid).then(() =>
        finish(() => rejectDone(new Error('浏览器文件标识不合法,已取消'))),
      );
      return;
    }
    observed = { guid: params.guid, origin };
  });
  downloadSession.on('Browser.downloadProgress', (params: any) => {
    if (!observed || params.guid !== observed.guid) return;
    if (params.totalBytes > maxBytes || params.receivedBytes > maxBytes) {
      void cancel(params.guid).then(() =>
        finish(() => rejectDone(new Error(`文件超过 ${maxBytes} 字节上限,已取消`))),
      );
      return;
    }
    if (params.state === 'completed') {
      finish(() => resolveDone({ ...observed!, bytes: params.receivedBytes }));
    } else if (params.state === 'canceled') {
      finish(() => rejectDone(new Error('浏览器下载已被取消')));
    }
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await downloadSession.send('Browser.setDownloadBehavior', {
      behavior: 'allowAndName',
      downloadPath: outDir,
      eventsEnabled: true,
    });

    // 触发下载:window.open(accessPath)(与站点自身下载行为一致;userGesture 保留用户手势)
    const trigger: any = await triggerSession.send('Runtime.evaluate', {
      expression: `window.open(${JSON.stringify(url)}, '_blank') && 'opened'`,
      returnByValue: true,
      userGesture: true,
    });
    if (trigger?.exceptionDetails || trigger?.result?.value !== 'opened') {
      throw new Error('下载触发失败(弹窗被拦截或页面异常)');
    }

    const done = await Promise.race([
      completion,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('60 秒内未确认下载完成')),
          DOWNLOAD_TIMEOUT_MS,
        );
      }),
    ]);
    return done;
  } finally {
    if (timer) clearTimeout(timer);
    // 尽力关闭下载触发的标签页(未找到则忽略)
    try {
      const targets: any = await downloadSession.send('Target.getTargets');
      for (const info of targets?.targetInfos || []) {
        if (info.type === 'page' && String(info.url) === url) {
          await downloadSession.send('Target.closeTarget', { targetId: info.targetId });
        }
      }
    } catch {
      /* 关闭标签页失败不影响主流程 */
    }
    try {
      await downloadSession.send('Browser.setDownloadBehavior', {
        behavior: 'default',
        eventsEnabled: false,
      });
    } catch {
      /* 恢复失败不覆盖主错误 */
    }
    try {
      await downloadSession.detach();
    } catch {
      /* 会话可能已断开 */
    }
    try {
      await triggerSession.detach();
    } catch {
      /* 会话可能已断开 */
    }
  }
}

export async function attachFetch(page: Page, options: AttachFetchOptions): Promise<AttachFetchResult> {
  requirePage(page);
  const imId = String(options.imId ?? '').trim();
  const outDir = options.outDir ? resolve(String(options.outDir).trim()) : '';
  const maxBytes = options.maxBytes === undefined ? DEFAULT_MAX_BYTES : Number(options.maxBytes);

  if (!imId) throw new Error('缺少 --imId(目标会话的对方 im_id)');
  if (!outDir) throw new Error('缺少 --out(附件下载目录)');
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) throw new Error('--maxBytes 必须为正整数');

  await mkdir(outDir, { recursive: true });

  // 落到同源页面拿 cookie/imId(纯接口路线,不打开会话)
  await navigateToLpt(page, '/recommend', 3);
  const ownImId = await readLptImId(page);
  if (!ownImId) {
    throw new Error('无法读取自己的 imId,请确保已登录招聘者端');
  }

  // 1) chat-list:找附件卡片消息(bizType=7 + attachmentResume.param)
  const chatBody = `imUserType=2&imId=${encodeURIComponent(ownImId)}&imApp=1`
    + `&oppositeImId=${encodeURIComponent(imId)}&maxMessageId=&pageSize=50`;
  const chatData = await lptFetch(page, `${LIEPIN_LPT_API}/api/com.liepin.im.b.chat.chat-list`, {
    body: chatBody,
    clientId: '40342',
  });
  if (chatData.flag !== 1) {
    throw new Error(`获取聊天消息失败(flag=${chatData.flag})`);
  }
  const list = Array.isArray(chatData.data?.list) ? chatData.data.list : [];
  const attachmentSign = findAttachmentSign(list, imId);
  if (!attachmentSign) {
    return { found: false, success: false, reason: 'no-attachment' };
  }

  // 2) 签名换下载地址(签名值不输出)
  const attData = await lptFetch(page, `${LIEPIN_LPT_API}/api/com.liepin.zhuque.resumeview.get-resume-attachment`, {
    body: `fileSign=${encodeURIComponent(attachmentSign)}&download=1`,
  });
  const accessPath = String(attData?.data?.accessPath || '');
  if (attData.flag !== 1 || !accessPath) {
    return { found: true, success: false, reason: 'fetch-failed', detail: `get-resume-attachment flag=${attData?.flag}` };
  }

  // 3) 浏览器下载通道落盘 + 校验
  let downloaded: { guid: string; origin: string; bytes: number };
  try {
    downloaded = await captureDownload(page, { url: accessPath, outDir, maxBytes });
  } catch (e: any) {
    return { found: true, success: false, reason: 'download-failed', detail: String(e?.message || e).slice(0, 200) };
  }

  const filePath = join(outDir, downloaded.guid);
  const info = await stat(filePath).catch(() => null);
  if (!info || !info.isFile()) {
    return { found: true, success: false, reason: 'verify-failed', detail: '下载文件未落盘' };
  }
  if (!info.size || info.size > maxBytes) {
    return { found: true, success: false, reason: 'verify-failed', detail: '本地文件长度验证失败' };
  }
  if (info.size !== downloaded.bytes) {
    return { found: true, success: false, reason: 'verify-failed', detail: '本地文件长度与下载进度不一致' };
  }
  const bytes = await readFile(filePath);
  if (bytes.subarray(0, 5).toString() !== '%PDF-') {
    return { found: true, success: false, reason: 'verify-failed', detail: '下载文件不是 PDF(缺少 %PDF- 签名)' };
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  const apiFileName = String(attData?.data?.fileName || '').trim();
  const apiExt = String(attData?.data?.fileExtension || '').trim();
  const fileExtension = apiExt || 'pdf';
  const fileName = apiFileName || `resume.${fileExtension}`;

  return {
    found: true,
    success: true,
    file: filePath,
    bytes: info.size,
    sha256,
    fileName,
    fileExtension,
    sourceOrigin: downloaded.origin,
    via: 'api',
  };
}

/** 获取简历附件命令定义 */
export const attachFetchCommand = {
  name: 'attach-fetch',
  description: '从指定会话获取简历附件(纯接口路线 + 浏览器下载通道 + PDF 校验)',
  args: [
    {
      name: 'imId',
      type: 'string',
      required: true,
      help: '目标会话的对方 im_id(chatlist 返回的 im_id)',
    },
    {
      name: 'out',
      type: 'string',
      required: true,
      help: '附件下载目录(必填)',
    },
    {
      name: 'maxBytes',
      type: 'int',
      default: DEFAULT_MAX_BYTES,
      help: '允许的最大字节数(默认 20MiB)',
    },
  ],
  columns: [
    { header: '文件', key: 'file', width: 60 },
    { header: '字节', key: 'bytes', width: 12 },
    { header: 'SHA-256', key: 'sha256', width: 64 },
    { header: '来源', key: 'sourceOrigin', width: 30 },
  ],
  // CLI 参数名为 --out,函数入参字段为 outDir,这里做一次显式映射
  func: (page: Page, options: any) =>
    attachFetch(page, {
      imId: options.imId,
      outDir: options.out ?? options.outDir,
      maxBytes: options.maxBytes,
    }),
};
