import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWindows, pickChromeWindow, type NativeWindow } from "./window.js";

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

test("pickChromeWindow:无匹配返回 null", () => {
  assert.equal(pickChromeWindow([win({ title: "设置" })], TITLE_MATCH), null);
  assert.equal(pickChromeWindow([], TITLE_MATCH), null);
});
