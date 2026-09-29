import { test } from "node:test";
import assert from "node:assert/strict";
import { isDebugConsentPrompt, parseWindows, pickBrowserWindow, pickChromeWindow, type NativeWindow } from "./window.js";

const TITLE_MATCH = /猎聘|liepin/i;

function win(partial: Partial<NativeWindow>): NativeWindow {
  return {
    pid: 1,
    windowId: 100,
    title: "【猎聘】-招聘_找工作 - Google Chrome",
    minimized: false,
    isOnScreen: true,
    ...partial,
  };
}

test("parseWindows:兼容 _legacy_windows 形状并过滤脏数据", () => {
  const parsed = parseWindows({
    _legacy_windows: [
      { pid: 22928, window_id: 20252380, title: "猎聘 - Google Chrome", minimized: false, is_on_screen: true },
      { pid: "bad", window_id: 1, title: "x" },
      { pid: 1 },
    ],
  });
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0], {
    pid: 22928,
    windowId: 20252380,
    title: "猎聘 - Google Chrome",
    minimized: false,
    isOnScreen: true,
  });
});

test("parseWindows:windows 形状与空输入", () => {
  assert.equal(parseWindows({ windows: [{ pid: 1, window_id: 2, title: "猎聘" }] }).length, 1);
  assert.deepEqual(parseWindows({}), []);
});

test("pickChromeWindow:标题匹配 + 未最小化 + 在屏", () => {
  const picked = pickChromeWindow(
    [
      win({ windowId: 5, title: "Edge - liepin.com" }), // 标题匹配也接受(配置决定)
      win({ windowId: 3, minimized: true }),
      win({ windowId: 2, isOnScreen: false }),
      win({ windowId: 9 }),
      win({ windowId: 4 }),
    ],
    TITLE_MATCH,
  );
  assert.equal(picked?.windowId, 4);
});

test("pickChromeWindow:全部候选均最小化时兜底返回(CDP 驱动不要求窗口可见)", () => {
  const picked = pickChromeWindow(
    [win({ windowId: 7, minimized: true, isOnScreen: false }), win({ windowId: 3, minimized: true, isOnScreen: false })],
    TITLE_MATCH,
  );
  assert.equal(picked?.windowId, 3);
});

test("pickChromeWindow:无匹配返回 null", () => {
  assert.equal(pickChromeWindow([win({ title: "设置" })], TITLE_MATCH), null);
  assert.equal(pickChromeWindow([], TITLE_MATCH), null);
});

test("pickBrowserWindow:优先按 profile 目录匹配进程命令行(标题不匹配也能命中)", async () => {
  const windows = [
    win({ pid: 11, windowId: 1, title: "推荐人才 - Google Chrome" }),
    win({ pid: 12, windowId: 2, title: "另一个窗口" }),
  ];
  const cmdlines: Record<number, string> = {
    11: "\"C:\\chrome.exe\" --user-data-dir=C:\\profiles\\account-1",
    12: "\"C:\\edge.exe\" --user-data-dir=C:\\profiles\\other",
  };
  const picked = await pickBrowserWindow(windows, TITLE_MATCH, {
    profileDir: "C:\\profiles\\account-1",
    cmdlineOf: async (pid) => cmdlines[pid] ?? null,
  });
  assert.equal(picked?.windowId, 1);
});

test("pickBrowserWindow:profile 未命中时回退标题匹配", async () => {
  const windows = [
    win({ pid: 21, windowId: 5, title: "推荐人才 - Google Chrome" }),
    win({ pid: 22, windowId: 6, title: "猎聘企业版 - Google Chrome" }),
  ];
  const picked = await pickBrowserWindow(windows, TITLE_MATCH, {
    profileDir: "C:\\profiles\\account-1",
    cmdlineOf: async () => null,
  });
  assert.equal(picked?.windowId, 6);
});

test("pickBrowserWindow:未配置 profile 时直接走标题匹配", async () => {
  const windows = [win({ pid: 31, windowId: 7, title: "推荐人才 - Google Chrome" })];
  const picked = await pickBrowserWindow(windows, TITLE_MATCH, { profileDir: null });
  assert.equal(picked, null, "标题不含 猎聘/liepin 时不命中");
});

test("isDebugConsentPrompt:识别 Chrome 调试授权确认框(中英文)", () => {
  assert.equal(isDebugConsentPrompt(win({ title: "要允许远程调试吗?" })), true);
  assert.equal(isDebugConsentPrompt(win({ title: "Allow remote debugging?" })), true);
  assert.equal(isDebugConsentPrompt(win({ title: "职位管理 - Google Chrome" })), false);
  assert.equal(isDebugConsentPrompt(win({ title: "" })), false);
});
