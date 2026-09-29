/**
 * doctor:部署自检(真实环境冒烟)。
 *
 * 检查项:
 *  1. cua-driver 可执行 + 版本;
 *  2. 守护进程可用(list_windows 调用成功);
 *  3. 猎聘 Chrome 窗口发现情况;
 *  4. `--attach` 时完成 prepare/bind 并做一次语义快照(冒烟)。
 */

import type { DriverConfig } from "../config.js";
import { DriverClient } from "../cua/driver-client.js";
import { attachBrowserSession, snapshot } from "../cua/session.js";
import { listWindows, pickChromeWindow } from "../cua/window.js";
import { EXIT_OK, truncate } from "../contract.js";

export interface DoctorReport {
  ok: boolean;
  driverVersion?: string;
  daemon?: boolean;
  windowCount?: number;
  chromeWindow?: { pid: number; windowId: number; title: string } | null;
  attach?: { ok: boolean; pageUrl?: string; refCount?: number; error?: string };
  error?: string;
}

export async function doctor(
  cfg: DriverConfig,
  options: { attach: boolean; log: (line: string) => void },
): Promise<{ code: number; report: DoctorReport }> {
  const report: DoctorReport = { ok: false };
  const client = new DriverClient({ bin: cfg.bin, session: cfg.session, timeoutMs: cfg.callTimeoutMs });

  try {
    report.driverVersion = await client.version();
    options.log(`[ok] cua-driver: ${report.driverVersion}`);
  } catch (err) {
    report.error = `cua-driver 不可用: ${truncate(String(err))}`;
    return { code: 1, report };
  }

  try {
    const windows = await listWindows(client);
    report.daemon = true;
    report.windowCount = windows.length;
    options.log(`[ok] daemon: 可用(可见窗口 ${windows.length} 个)`);
  } catch (err) {
    report.error = `守护进程不可用: ${truncate(String(err))}`;
    return { code: 1, report };
  }

  try {
    const windows = await listWindows(client);
    const found = pickChromeWindow(windows, cfg.windowTitleMatch);
    report.chromeWindow = found
      ? { pid: found.pid, windowId: found.windowId, title: found.title }
      : null;
    options.log(
      found
        ? `[ok] 猎聘窗口: pid=${found.pid} window=${found.windowId}`
        : "[warn] 未发现猎聘 Chrome 窗口(标题匹配),先启动浏览器",
    );
  } catch (err) {
    options.log(`[warn] 窗口枚举失败: ${truncate(String(err))}`);
  }

  if (options.attach) {
    try {
      const session = await attachBrowserSession(client, cfg.windowTitleMatch);
      const snap = await snapshot(client, session);
      report.attach = { ok: true, pageUrl: snap.page.url, refCount: snap.refs.length };
      options.log(`[ok] attach+snapshot: ${snap.page.url} (节点 ${snap.refs.length})`);
    } catch (err) {
      report.attach = { ok: false, error: truncate(String(err)) };
      options.log(`[fail] attach: ${truncate(String(err))}`);
      report.ok = false;
      return { code: 1, report };
    }
  }

  report.ok = report.driverVersion !== undefined && report.daemon === true;
  return { code: report.ok ? EXIT_OK : 1, report };
}
