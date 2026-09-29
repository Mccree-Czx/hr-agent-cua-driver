/**
 * 顶层窗口枚举与猎聘 Chrome 窗口挑选(纯函数便于单测)。
 *
 * `list_windows` 输出兼容两种形状:`_legacy_windows`(当前实测)或 `windows`。
 */

import type { DriverClient } from "./driver-client.js";

export interface NativeWindow {
  pid: number;
  windowId: number;
  title: string;
  minimized: boolean;
  isOnScreen: boolean;
}

interface RawWindow {
  pid?: unknown;
  window_id?: unknown;
  title?: unknown;
  minimized?: unknown;
  is_on_screen?: unknown;
}

/** 解析 list_windows 输出为窗口数组 */
export function parseWindows(data: Record<string, unknown>): NativeWindow[] {
  const list = (data._legacy_windows ?? data.windows ?? []) as RawWindow[];
  if (!Array.isArray(list)) {
    return [];
  }
  return list
    .filter((w) => typeof w.pid === "number" && typeof w.window_id === "number")
    .map((w) => ({
      pid: w.pid as number,
      windowId: w.window_id as number,
      title: typeof w.title === "string" ? w.title : "",
      minimized: w.minimized === true,
      isOnScreen: w.is_on_screen === true,
    }));
}

/**
 * 挑选猎聘 Chrome 窗口:标题匹配 + 未最小化 + 在屏。
 * 多命中时取 windowId 最小者(稳定选择,便于跨调用一致)。
 */
export function pickChromeWindow(windows: NativeWindow[], titleMatch: RegExp): NativeWindow | null {
  const matches = windows
    .filter((w) => w.title.length > 0 && titleMatch.test(w.title) && !w.minimized && w.isOnScreen)
    .sort((a, b) => a.windowId - b.windowId);
  return matches.length > 0 ? matches[0] : null;
}

/** 枚举窗口(list_windows) */
export async function listWindows(client: DriverClient): Promise<NativeWindow[]> {
  const data = await client.requireOk("list_windows", {});
  return parseWindows(data);
}
