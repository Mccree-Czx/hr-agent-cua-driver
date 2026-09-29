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

import { CuaError } from "../contract.js";
import type { DriverConfig } from "../config.js";
import type { DriverClient } from "./driver-client.js";
import { listWindows, pickBrowserWindow, powershellCmdlineOf, type NativeWindow } from "./window.js";

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
