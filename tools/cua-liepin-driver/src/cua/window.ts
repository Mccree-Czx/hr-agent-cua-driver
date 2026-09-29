/**
 * 顶层窗口枚举与猎聘 Chrome 窗口挑选(纯函数便于单测)。
 *
 * `list_windows` 输出兼容两种形状:`_legacy_windows`(当前实测)或 `windows`。
 */

import { spawn } from "node:child_process";
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
 * 挑选猎聘 Chrome 窗口:标题匹配为前提;首选可见(未最小化且在屏),兜底接受最小化窗口
 * (2026-09-29 实测:自动化窗口常被最小化,CDP 驱动并不要求窗口可见;
 * 仅前台升级类动作在最小化时可能不可用,由动作层自行按结构化拒绝处理)。
 * 同级多命中时取 windowId 最小者(稳定选择,便于跨调用一致)。
 */
export function pickChromeWindow(windows: NativeWindow[], titleMatch: RegExp): NativeWindow | null {
  const matches = windows
    .filter((w) => w.title.length > 0 && titleMatch.test(w.title))
    .sort((a, b) => a.windowId - b.windowId);
  const visible = matches.find((w) => !w.minimized && w.isOnScreen);
  if (visible !== undefined) {
    return visible;
  }
  return matches.length > 0 ? matches[0] : null;
}

/** 枚举窗口(list_windows) */
export async function listWindows(client: DriverClient): Promise<NativeWindow[]> {
  const data = await client.requireOk("list_windows", {});
  return parseWindows(data);
}

/** 进程命令行解析(Windows:PowerShell/WMI;失败返回 null) */
export function powershellCmdlineOf(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(
      "powershell",
      ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
      { windowsHide: true },
    );
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.on("error", () => resolve(null));
    child.on("close", () => resolve(out.trim() !== "" ? out.trim() : null));
  });
}

export interface PickBrowserOptions {
  /** 账号 Chrome profile 目录(cfg.profileDir) */
  profileDir?: string | null;
  /** 进程命令行解析(默认 powershellCmdlineOf;测试可注入) */
  cmdlineOf?: (pid: number) => Promise<string | null>;
}

/**
 * 附加目标窗口挑选(2026-09-29 联调修正):
 * 1) 首选:进程命令行包含账号 profile 目录——登录后页面标题会随页面变化
 *    (如"推荐人才"),标题匹配不可靠;profile 目录才是账号级稳定判别;
 * 2) 兜底:标题匹配(兼容未配置 profile 的场景,env 可调)。
 */
export async function pickBrowserWindow(
  windows: NativeWindow[],
  titleMatch: RegExp,
  opts: PickBrowserOptions = {},
): Promise<NativeWindow | null> {
  const { profileDir, cmdlineOf } = opts;
  if (profileDir !== undefined && profileDir !== null && profileDir !== "" && cmdlineOf !== undefined) {
    const ordered = [...windows.filter((w) => !w.minimized), ...windows.filter((w) => w.minimized)];
    for (const w of ordered) {
      const cmd = await cmdlineOf(w.pid);
      if (cmd !== null && cmd.includes(profileDir)) {
        return w;
      }
    }
  }
  return pickChromeWindow(windows, titleMatch);
}
