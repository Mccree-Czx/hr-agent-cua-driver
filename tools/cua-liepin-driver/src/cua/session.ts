/**
 * 浏览器会话:附加 existing-profile → 绑定原生窗口 → 快照/查询/点击。
 *
 * 流程与不变量(W0 spike 验证):
 * - prepare(browser_prepare)一次性授权并启用受控 DevTools 端点,拒绝码
 *   `browser_consent_required` 表示守护进程未带 --grant existing-profile 启动;
 * - bind(get_browser_state pid+window_id)签发 target_id/tab_id;
 * - 任何新快照使旧 ref 失效;动作后必须用新快照验证状态;
 * - 点击默认 trusted 路由(真实输入事件、后台投递不抢焦点),拒绝则抛出以便上层决策。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { CuaError } from "../contract.js";
import type { DriverConfig } from "../config.js";
import type { DriverClient } from "./driver-client.js";
import {
  isDebugConsentPrompt,
  listWindows,
  pickBrowserWindow,
  powershellCmdlineOf,
  type NativeWindow,
} from "./window.js";

export interface BrowserSession {
  targetId: string;
  activeTabId: string;
  pageUrl: string;
  window: NativeWindow;
}

export interface SnapshotRef {
  ref: string;
  role: string;
  name: string | null;
  actions: string[];
  visibility?: string;
}

export interface SnapshotResult {
  snapshotId: string;
  refs: SnapshotRef[];
  outline: string;
  page: { title: string; url: string };
}

interface BindTab {
  active?: unknown;
  tab_id?: unknown;
  title?: unknown;
  url?: unknown;
}

/**
 * 附加并绑定猎聘 Chrome 窗口。
 * 窗口挑选:优先按账号 profile 目录匹配进程命令行(标题不稳定),标题匹配兜底。
 * 找不到窗口时抛 CuaError(提示先启动浏览器;自动启动属浏览器生命周期,W5 落地)。
 */
export async function attachBrowserSession(
  client: DriverClient,
  cfg: DriverConfig,
): Promise<BrowserSession> {
  const windows = await listWindows(client);
  const window = await pickBrowserWindow(windows, cfg.windowTitleMatch, {
    profileDir: cfg.profileDir,
    cmdlineOf: powershellCmdlineOf,
  });
  if (window === null) {
    throw new CuaError(
      "failed",
      `未找到猎聘浏览器窗口(profile=${cfg.profileDir ?? "未配置"},标题匹配=${cfg.windowTitleMatch});` +
        "请先启动账号 Chrome(浏览器自动启动在 W5 落地)",
    );
  }

  const prepare = await client.callTool("browser_prepare", {
    pid: window.pid,
    window_id: window.windowId,
    strategy: { kind: "existing_profile" },
  });
  if (prepare.status === "refused") {
    if (prepare.refusalCode === "browser_consent_required") {
      throw new CuaError(
        "failed",
        "existing-profile 附加被拒绝:守护进程需以 `cua-driver serve --grant existing-profile` 启动",
      );
    }
    throw new CuaError(
      "failed",
      `browser_prepare 被拒绝(${prepare.refusalCode}): ${prepare.refusalMessage ?? ""}`.trim(),
    );
  }

  const bound = await client.requireOk("get_browser_state", {
    pid: window.pid,
    window_id: window.windowId,
  });
  const tabs = (bound.tabs ?? []) as BindTab[];
  const active = tabs.find((t) => t.active === true) ?? tabs[0];
  if (typeof bound.target_id !== "string" || typeof active?.tab_id !== "string") {
    throw new CuaError("failed", "绑定结果缺少 target_id/tab_id: " + JSON.stringify(bound).slice(0, 200));
  }

  return {
    targetId: bound.target_id,
    activeTabId: active.tab_id,
    pageUrl: typeof active.url === "string" ? active.url : "",
    window,
  };
}

/** Chrome 可执行文件探测(CHROME_PATH → 常见安装路径);未找到返回 null */
export function resolveChromePath(cfg: DriverConfig, exists: (p: string) => boolean = existsSync): string | null {
  if (cfg.chromePath !== null && cfg.chromePath !== "") {
    return cfg.chromePath;
  }
  const local = process.env.LOCALAPPDATA ?? "";
  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    local !== "" ? `${local}\\Google\\Chrome\\Application\\chrome.exe` : "",
  ].filter((p) => p !== "");
  for (const c of candidates) {
    if (exists(c)) {
      return c;
    }
  }
  return null;
}

/**
 * 启动账号 Chrome(detached,不阻塞 CLI 退出)。
 * 终态约束:无 CDP 参数(--remote-debugging-port 已退出运行路径),仅账号 profile + 常规参数。
 */
export function launchChrome(cfg: DriverConfig, initialUrl = "https://lpt.liepin.com/"): number {
  if (cfg.profileDir === null || cfg.profileDir === "") {
    throw new CuaError("failed", "未配置 LIEPIN_USER_DATA_DIR,无法启动账号浏览器");
  }
  const bin = resolveChromePath(cfg);
  if (bin === null) {
    throw new CuaError("failed", "未找到 Chrome 可执行文件(可用 CHROME_PATH 显式指定)");
  }
  const child = spawn(
    bin,
    [
      `--user-data-dir=${cfg.profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      initialUrl,
    ],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
  return child.pid ?? 0;
}

/**
 * 处理 Chrome 调试授权确认框(点「允许」)。
 * 2026-09-29 联调实测:新调试目标偶发弹出"要允许远程调试吗?"原生框,
 * 多个共存时 browser_prepare 会以 browser_wrong_target_refused 拒绝,必须先清障。
 * 返回处理数;单框失败不阻断(下一次轮询会重试)。
 */
export async function dismissDebugConsentPrompts(client: DriverClient): Promise<number> {
  const windows = await listWindows(client);
  const prompts = windows.filter(isDebugConsentPrompt);
  let handled = 0;
  for (const p of prompts) {
    try {
      const state = await client.requireOk("get_window_state", { pid: p.pid, window_id: p.windowId });
      const elements = (Array.isArray(state.elements) ? state.elements : []) as Array<Record<string, unknown>>;
      const allow = elements.find(
        (e) => typeof e.label === "string" && /^允许$/.test(e.label) && typeof e.element_token === "string",
      );
      if (allow === undefined) {
        continue;
      }
      const res = await client.callTool("click", {
        pid: p.pid,
        window_id: p.windowId,
        element_token: allow.element_token,
      });
      if (res.status !== "refused") {
        handled++;
      }
    } catch {
      /* 单框处理失败不阻断 */
    }
  }
  return handled;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 桌面可交互性探测(2026-09-30 软化:desktop_unlocked 存在唤醒场景假阴性)。
 * desktop_unlocked=false 时不再硬拦截,改为告警并由快照质量兜底:
 * 真锁屏/渲染冻结时页面 refs 骤减(骨架)、查找类动作自然失败且不产生副作用;
 * 假阴性(实测:系统唤醒后 driver 仍报 false,但桌面/窗口快照完整、Chrome is_on_screen=true)可正常继续。
 * 检查本身失败不阻断。返回 true=已检查且报告未锁/false=false 或无法判定。
 */
export async function assertDesktopUnlocked(client: DriverClient): Promise<boolean> {
  let unlocked: unknown;
  try {
    const res = await client.callTool("start_session", {});
    unlocked = res.data.desktop_unlocked;
  } catch {
    return false; // 检查失败不阻断主流程(attach 自身会处理 session 问题)
  }
  if (unlocked === false) {
    console.error(
      "[warn] desktop_unlocked=false(可能锁屏,也可能唤醒后误报);继续执行,以快照/抽取质量为准",
    );
    return false;
  }
  return true;
}

/**
 * 附加浏览器会话(含生命周期):
 * 1) 先清 consent 干扰窗;
 * 2) attach;失败且允许启动时:启动账号 Chrome → 轮询等待窗口就绪(默认 30s)。
 */
export async function ensureBrowserSession(
  client: DriverClient,
  cfg: DriverConfig,
  opts: { launchIfMissing?: boolean; waitMs?: number } = {},
): Promise<BrowserSession> {
  // 桌面可交互性探测(软告警:desktop_unlocked 唤醒场景有假阴性,以快照质量为准)
  await assertDesktopUnlocked(client);
  await dismissDebugConsentPrompts(client).catch(() => 0);
  try {
    return await attachBrowserSession(client, cfg);
  } catch (err) {
    if (opts.launchIfMissing !== true) {
      throw err;
    }
    launchChrome(cfg);
    const deadline = Date.now() + (opts.waitMs ?? 30_000);
    while (Date.now() < deadline) {
      await sleep(2_000);
      try {
        await dismissDebugConsentPrompts(client).catch(() => 0);
        return await attachBrowserSession(client, cfg);
      } catch {
        /* 窗口未就绪,继续等待 */
      }
    }
    throw new CuaError("failed", "启动账号 Chrome 后等待窗口就绪超时");
  }
}

/**
 * 合并快照节点:refs(动作/内容引用)与 content_refs 都要收集,按 ref 去重
 * (2026-09-29 联调实测:300 节点预算下两部分各占一部分,只读 refs 会丢失正文节点)。
 */
export function mergeSnapshotRefs(data: Record<string, unknown>): SnapshotRef[] {
  const seen = new Set<string>();
  const result: SnapshotRef[] = [];
  for (const source of [data.refs, data.content_refs]) {
    const list = (Array.isArray(source) ? source : []) as Array<Record<string, unknown>>;
    for (const r of list) {
      if (typeof r.ref !== "string" || seen.has(r.ref)) {
        continue;
      }
      seen.add(r.ref);
      result.push({
        ref: r.ref,
        role: typeof r.role === "string" ? r.role : "",
        name: typeof r.name === "string" ? r.name : null,
        actions: Array.isArray(r.actions) ? (r.actions as string[]) : [],
        visibility: typeof r.visibility === "string" ? r.visibility : undefined,
      });
    }
  }
  return result;
}

/** 续页上限(默认最多再拉 3 页;防止超大页面耗时失控) */
const MAX_SNAPSHOT_PAGES = 3;

/**
 * 语义快照(semantic_v2);传入 query 时仅返回匹配节点及其祖先链。
 * 联调强化(2026-09-29):
 * - 合并 refs + content_refs;
 * - 全量模式下 snapshot.complete=false 时跟随 continuation 续页(最多 3 页),
 *   保证长页面(简历详情/推荐列表)正文不被 300 节点预算挤出。
 */
export async function snapshot(
  client: DriverClient,
  session: BrowserSession,
  query?: string,
): Promise<SnapshotResult> {
  const args: Record<string, unknown> = {
    target_id: session.targetId,
    tab_id: session.activeTabId,
    snapshot_format: "semantic_v2",
    // 2026-09-30 真机突破:include_screenshot 强制 tab 视口捕获,实测显著提升语义树完整度
    // (无此项时同页反复导航+快照 12 轮均只得残缺"导航壳";开启后首尝试即 245 refs/95 named),
    // 代价为响应携带 PNG(约 700KB/次),以完整度优先
    include_screenshot: true,
  };
  if (query !== undefined && query !== "") {
    args.query = query;
  }

  let data = await client.requireOk("get_browser_state", args);
  let refs = mergeSnapshotRefs(data);
  let pages = 0;
  while (query === undefined && pages < MAX_SNAPSHOT_PAGES) {
    const snapInfo = (data.snapshot ?? {}) as Record<string, unknown>;
    const continuation = snapInfo.continuation;
    if (snapInfo.complete !== false || typeof continuation !== "string" || continuation === "") {
      break;
    }
    const next = await client.requireOk("get_browser_state", { ...args, continuation });
    const merged = mergeSnapshotRefs(next);
    const known = new Set(refs.map((r) => r.ref));
    refs = [...refs, ...merged.filter((r) => !known.has(r.ref))];
    data = next;
    pages++;
  }

  const snap = (data.snapshot ?? {}) as Record<string, unknown>;
  const page = (data.page ?? {}) as Record<string, unknown>;

  return {
    snapshotId: typeof snap.id === "string" ? snap.id : "",
    refs,
    outline: typeof data.outline === "string" ? data.outline : "",
    page: {
      title: typeof page.title === "string" ? page.title : "",
      url: typeof page.url === "string" ? page.url : "",
    },
  };
}

/** 在快照结果中按名称/角色定位元素;namePredicate 做包含匹配 */
export function findRef(
  snap: SnapshotResult,
  nameIncludes: string,
  role?: string,
): SnapshotRef | null {
  const match = snap.refs.find(
    (r) =>
      r.name !== null &&
      r.name.includes(nameIncludes) &&
      (role === undefined || r.role === role),
  );
  return match ?? null;
}

/** 点击 ref(trusted 输入路由;拒绝抛出) */
export async function clickRef(
  client: DriverClient,
  session: BrowserSession,
  ref: string,
): Promise<Record<string, unknown>> {
  const result = await client.callTool("browser_click", {
    target_id: session.targetId,
    tab_id: session.activeTabId,
    ref,
  });
  if (result.status === "refused") {
    throw new CuaError(
      "failed",
      `browser_click 被拒绝(${result.refusalCode}): ${result.refusalMessage ?? ""}`.trim(),
    );
  }
  return result.data;
}
