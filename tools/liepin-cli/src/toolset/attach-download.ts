/**
 * 猎聘「下载简历附件」命令 - 招聘者端
 *
 * 第一阶段（2026-09-25）真机验证结论：直接从页面 fetch 附件 URL 会被 403（CORS 防护）
 * 挡下，**唯一可行通道是界面上的预览窗下载按钮触发的浏览器原生下载**。本命令据此实现：
 *
 *   1. 在聊天页按 `data-tlg-ext`（URI 编码 JSON 的 `to_imid`）精确锁定目标会话，
 *      未命中或命中多个一律报错——不猜、不点第一个。
 *   2. 点开最后一张附件卡片的「附件简历」，等服务端预览弹窗出现。
 *   3. 弹窗里必须**唯一**可见一个带指定 svg 图标的下载按钮，否则报错（不任选）。
 *   4. 用 CDP `Browser.setDownloadBehavior(allowAndName)` 把下载落到指定目录并捕获事件；
 *      来源必须属于受信 origin，超限/未知来源一律 `Browser.cancelDownload`。
 *   5. 校验落盘文件为 PDF（`%PDF-`）且不超上限，输出 SHA-256。
 *
 * 注意：打开会话会把它标记为已读（业务上已接受）。
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Page } from 'puppeteer-core';
import { navigateToLpt, waitForSelectorSafe } from '../common/lpt-utils.js';
import { requirePage } from '../common/utils.js';

export interface AttachDownloadOptions {
  /** 目标会话的对方 im_id */
  imId: string;
  /** 附件下载落盘目录 */
  outDir: string;
  /** 允许的最大字节数，默认 20MiB */
  maxBytes?: number;
}

export interface AttachDownloadResult {
  success: true;
  file: string;
  bytes: number;
  sha256: string;
  sourceOrigin: string;
}

/** 受信附件来源（第一阶段真机确认：附件由 tdoss 签发，预览在 wow，lpt 回调） */
const TRUSTED_ORIGINS = [
  'https://tdoss.liepin.com',
  'https://lpt.liepin.com',
  'https://wow.liepin.com',
];
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
/** 选择器等待上限（毫秒）；LIEPIN_SELECTOR_TIMEOUT_MS 供测试注入短超时，避免真等超时路径 */
const selectorTimeoutMs = (): number => Number(process.env.LIEPIN_SELECTOR_TIMEOUT_MS || 15000);
const DOWNLOAD_TIMEOUT_MS = 60000;
/** allowAndName 落盘文件名就是 guid，必须是无路径分隔符的安全标识 */
const GUID_PATTERN = /^[a-zA-Z0-9-]+$/;

/**
 * 获取用于捕获浏览器下载的 CDP 会话。
 *
 * 第一阶段真机验证（2026-09-25）：Browser domain 的下载事件（downloadWillBegin /
 * downloadProgress）只投递给浏览器级根会话，页面子会话（page.target().createCDPSession()）
 * 收不到——计划已裁定此时回退到浏览器级会话。这里优先用浏览器 target，取不到再退回页面 target。
 */
async function createDownloadSession(page: Page) {
  const browser = page.browser();
  if (browser) {
    return browser.target().createCDPSession();
  }
  return page.target().createCDPSession();
}

export async function attachDownload(
  page: Page,
  options: AttachDownloadOptions,
): Promise<AttachDownloadResult> {
  requirePage(page);
  const imId = String(options.imId ?? '').trim();
  // CDP setDownloadBehavior 的 downloadPath 必须是绝对路径，否则浏览器会直接取消下载
  const outDir = options.outDir ? resolve(String(options.outDir).trim()) : '';
  const maxBytes = options.maxBytes === undefined ? DEFAULT_MAX_BYTES : Number(options.maxBytes);

  if (!imId) throw new Error('缺少 --imId（目标会话的对方 im_id）');
  if (!outDir) throw new Error('缺少 --out（附件下载目录）');
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('--maxBytes 必须为正整数');
  }

  // 下载目录不存在时创建（浏览器写入必须是已存在的绝对目录）
  await mkdir(outDir, { recursive: true });

  // 落到聊天页（会话列表与附件卡片都在这里）
  await navigateToLpt(page, '/chat/im', 3);

  // 1. 精确定位会话并点击（data-tlg-ext 的 to_imid）
  const sessionStatus = await page.evaluate((targetImId: string) => {
    const items = Array.prototype.slice.call(
      document.querySelectorAll('.im-ui-contact-list-item'),
    ) as Element[];
    const matched = items.filter((item) => {
      const raw = item.getAttribute('data-tlg-ext');
      if (!raw) return false;
      try {
        return String(JSON.parse(decodeURIComponent(raw))?.to_imid ?? '') === String(targetImId);
      } catch {
        return false;
      }
    });
    if (matched.length === 0) return 'none';
    if (matched.length > 1) return 'multiple';
    (matched[0] as HTMLElement).click();
    return 'clicked';
  }, imId);
  if (sessionStatus === 'none') {
    throw new Error('会话不存在：没有 imId 匹配的会话（不猜测、不打开第一个）');
  }
  if (sessionStatus === 'multiple') {
    throw new Error('会话不唯一：多个会话项匹配同一 imId（歧义，拒绝继续）');
  }
  if (sessionStatus !== 'clicked') throw new Error('会话定位失败：未能点击目标会话');

  // 2. 等附件卡片出现，点最后一张卡片的「附件简历」
  try {
    await waitForSelectorSafe(page, '.im-ui-send-attachment-card', { timeout: selectorTimeoutMs() });
  } catch {
    throw new Error('会话中未出现附件卡片（超时）；不猜测附件位置');
  }
  const cardClicked = await page.evaluate(() => {
    const cards = Array.prototype.slice.call(
      document.querySelectorAll('.im-ui-send-attachment-card'),
    ) as Element[];
    if (!cards.length) return false;
    const last = cards[cards.length - 1];
    const items = Array.prototype.slice.call(
      last.querySelectorAll('.im-ui-send-attachment-card-info-item-content'),
    ) as Element[];
    const target = items.find((el) => (el.textContent || '').trim() === '附件简历');
    if (!target) return false;
    (target as HTMLElement).click();
    return true;
  });
  if (!cardClicked) throw new Error('未找到「附件简历」附件卡片（不任选其它卡片）');

  // 3. 等预览弹窗，校验唯一可见下载按钮
  try {
    await waitForSelectorSafe(page, '.im-ui-preview-modal-title-box', { timeout: selectorTimeoutMs() });
  } catch {
    throw new Error('附件预览弹窗未出现（超时）');
  }
  const downloadButtons = await page.evaluate(() => {
    const links = Array.prototype.slice.call(
      document.querySelectorAll('.im-ui-preview-modal-title-box a'),
    ) as Element[];
    return links.filter(
      (el) =>
        el.getBoundingClientRect().width > 0 &&
        Boolean(el.querySelector('svg path[d^="M8.98 11.687"]')),
    ).length;
  });
  if (downloadButtons === 0) throw new Error('预览弹窗中未找到可用的下载按钮');
  if (downloadButtons !== 1) throw new Error('预览弹窗中下载按钮不唯一（拒绝任选）');

  // 4. CDP 下载捕获
  // 下载行为与事件挂浏览器级会话；触发点击（Runtime.evaluate + userGesture）挂页面会话。
  const downloadSession = await createDownloadSession(page);
  const clickSession = await page.target().createCDPSession();
  let observed: { guid: string; origin: string } | null = null;
  let settled = false;
  let resolveDone!: (value: { guid: string; origin: string; bytes: number }) => void;
  let rejectDone!: (error: Error) => void;
  const completion = new Promise<{ guid: string; origin: string; bytes: number }>(
    (resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    },
  );
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
      /* 可能已经结束，忽略 */
    }
  };

  downloadSession.on('Browser.downloadWillBegin', (params: any) => {
    let origin = '';
    try {
      origin = new URL(params.url).origin;
    } catch {
      origin = '';
    }
    if (observed || !TRUSTED_ORIGINS.includes(origin)) {
      void cancel(params.guid).then(() =>
        finish(() => rejectDone(new Error('下载来源未知或出现额外下载，已取消'))),
      );
      return;
    }
    if (!GUID_PATTERN.test(params.guid)) {
      void cancel(params.guid).then(() =>
        finish(() => rejectDone(new Error('浏览器文件标识不合法，已取消'))),
      );
      return;
    }
    observed = { guid: params.guid, origin };
  });
  downloadSession.on('Browser.downloadProgress', (params: any) => {
    if (!observed || params.guid !== observed.guid) return;
    if (params.totalBytes > maxBytes || params.receivedBytes > maxBytes) {
      void cancel(params.guid).then(() =>
        finish(() => rejectDone(new Error(`文件超过 ${maxBytes} 字节上限，已取消`))),
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

    // 触发下载：重新确认唯一性后点击（userGesture 走 CDP，保留用户手势）
    const clickResult: any = await clickSession.send('Runtime.evaluate', {
      expression: `(() => {
        const links = Array.from(document.querySelectorAll('.im-ui-preview-modal-title-box a'))
          .filter(e => e.getBoundingClientRect().width > 0 && e.querySelector('svg path[d^="M8.98 11.687"]'));
        if (links.length !== 1) return 'not-unique';
        links[0].click();
        return 'clicked';
      })()`,
      returnByValue: true,
      userGesture: true,
    });
    if (clickResult?.exceptionDetails || clickResult?.result?.value !== 'clicked') {
      throw new Error('下载按钮执行异常或不再唯一，已中止（不重试）');
    }

    const done = await Promise.race([
      completion,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('60 秒内未确认下载完成（不自动重试）')),
          DOWNLOAD_TIMEOUT_MS,
        );
      }),
    ]);

    // 5. 落盘校验
    const filePath = join(outDir, done.guid);
    const info = await stat(filePath).catch(() => null);
    if (!info || !info.isFile()) throw new Error('下载文件未落盘');
    if (!info.size || info.size > maxBytes) throw new Error('本地文件长度验证失败');
    if (info.size !== done.bytes) throw new Error('本地文件长度与下载进度不一致');
    const bytes = await readFile(filePath);
    if (bytes.subarray(0, 5).toString() !== '%PDF-') {
      throw new Error('下载文件不是 PDF（缺少 %PDF- 签名）');
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');

    return {
      success: true,
      file: filePath,
      bytes: info.size,
      sha256,
      sourceOrigin: done.origin,
    };
  } finally {
    if (timer) clearTimeout(timer);
    // 恢复浏览器默认下载行为，避免影响用户后续手动下载
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
      await clickSession.detach();
    } catch {
      /* 会话可能已断开 */
    }
  }
}

/** 下载简历附件命令定义 */
export const attachDownloadCommand = {
  name: 'attach-download',
  description: '从指定会话下载简历附件（走浏览器下载通道 + PDF 校验）',
  args: [
    {
      name: 'imId',
      type: 'string',
      required: true,
      help: '目标会话的对方 im_id（chatlist 返回的 im_id）',
    },
    {
      name: 'out',
      type: 'string',
      required: true,
      help: '附件下载目录（必填，须已存在）',
    },
    {
      name: 'maxBytes',
      type: 'int',
      default: DEFAULT_MAX_BYTES,
      help: '允许的最大字节数（默认 20MiB）',
    },
  ],
  columns: [
    { header: '文件', key: 'file', width: 60 },
    { header: '字节', key: 'bytes', width: 12 },
    { header: 'SHA-256', key: 'sha256', width: 64 },
    { header: '来源', key: 'sourceOrigin', width: 30 },
  ],
  // CLI 参数名为 --out，函数入参字段为 outDir，这里做一次显式映射
  func: (page: Page, options: any) =>
    attachDownload(page, {
      imId: options.imId,
      outDir: options.out ?? options.outDir,
      maxBytes: options.maxBytes,
    }),
};
