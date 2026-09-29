/**
 * 猎聘删除职位命令 - 招聘者端
 *
 * 真机验证流程(2026-09-25):
 *   猎聘规则:发布中/暂停的职位不能直接删除(错误码 ejob_009),必须两步:
 *   1) POST .../ejobinfomaintain.end-ejobs     结束发布(ejobIdList JSON 数组)
 *   2) POST .../ejobinfomaintain.delete-ejobs  删除职位
 *   两者的 body 均为 url-encoded 的 ejobIdList=JSON.stringify([id,...])
 */

import { Page } from 'puppeteer-core';
import { LIEPIN_LPT_API, lptFetch, navigateToLpt } from '../common/lpt-utils.js';

export interface JobdeleteOptions {
  /** 职位 ID,支持逗号分隔批量 */
  job: string;
}

function parseJobIds(raw: string): string[] {
  if (!raw || !raw.trim()) {
    throw new Error('缺少 --job(职位 ID,支持逗号分隔)');
  }
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function jobdelete(page: Page, options: JobdeleteOptions): Promise<any> {
  const jobIds = parseJobIds(options.job);

  await navigateToLpt(page, '/job/manager', 2);

  const body = `ejobIdList=${encodeURIComponent(JSON.stringify(jobIds))}`;

  // 1. 结束发布(已结束的职位会返回错误,忽略;幂等)
  const endRes = await lptFetch(
    page,
    `${LIEPIN_LPT_API}/api/com.liepin.kuafu.ejobmanage.pc.ejobinfomaintain.end-ejobs`,
    { body },
  );
  if (endRes.flag !== 1) {
    // 已是"已结束"状态的职位 end 会报错,不阻断,由后面的删除结果决定成败
    console.error(`[提示] 结束发布未成功(可能已是已结束状态): ${endRes.msg || endRes.code || ''}`);
  }

  await new Promise((r) => setTimeout(r, 2000));

  // 2. 删除
  const delRes = await lptFetch(
    page,
    `${LIEPIN_LPT_API}/api/com.liepin.kuafu.ejobmanage.pc.ejobinfomaintain.delete-ejobs`,
    { body },
  );
  if (delRes.flag !== 1) {
    throw new Error(
      `删除职位失败: ${delRes.msg || delRes.code || JSON.stringify(delRes).slice(0, 200)}`,
    );
  }

  return {
    success: true,
    deleted: jobIds,
    message: `已删除 ${jobIds.length} 个职位`,
  };
}

/** 删除职位命令定义 */
export const jobdeleteCommand = {
  name: 'jobdelete',
  description: '删除猎聘职位(自动先结束发布再删除;支持逗号分隔批量)',
  args: [
    { name: 'job', type: 'string', default: '', help: '职位 ID(必填,支持逗号分隔批量,如 85869365,85869375)' },
  ],
  columns: [
    { header: '结果', key: 'message', width: 30 },
  ],
  func: jobdelete,
};
