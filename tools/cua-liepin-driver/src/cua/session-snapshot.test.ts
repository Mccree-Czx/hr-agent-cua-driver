/**
 * 快照层测试(联调强化):refs+content_refs 合并、continuation 续页、query 模式不续页。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { DriverClient, type ToolCallResult } from "./driver-client.js";
import { mergeSnapshotRefs, resolveChromePath, snapshot, type BrowserSession } from "./session.js";
import type { DriverConfig } from "../config.js";

const SESSION: BrowserSession = {
  targetId: "bt-1",
  activeTabId: "tab-1",
  pageUrl: "",
  window: { pid: 1, windowId: 2, title: "t", minimized: false, isOnScreen: true },
};

test("resolveChromePath:CHROME_PATH 显式优先;未命中返回 null", () => {
  const base: DriverConfig = {
    bin: "cua-driver",
    session: "t",
    profileDir: "C:\\p",
    windowTitleMatch: /x/,
    callTimeoutMs: 1000,
    chromePath: null,
  };
  assert.equal(resolveChromePath({ ...base, chromePath: "C:\\custom\\chrome.exe" }, () => false), "C:\\custom\\chrome.exe");
  assert.equal(resolveChromePath(base, (p) => p.includes("Program Files\\Google")), "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe");
  assert.equal(resolveChromePath(base, () => false), null);
});

interface ScriptEntry {
  payload: Record<string, unknown>;
}

function scriptedClient(entries: ScriptEntry[]): {
  client: DriverClient;
  calls: Array<Record<string, unknown>>;
} {
  const calls: Array<Record<string, unknown>> = [];
  const client = new DriverClient({ bin: "fake", session: "test", timeoutMs: 1000 });
  let index = 0;
  (client as unknown as { callTool: (t: string, a: Record<string, unknown>) => Promise<ToolCallResult> }).callTool =
    async (tool, args) => {
      calls.push(args);
      const entry = entries[Math.min(index++, entries.length - 1)];
      return { tool, status: "ok", data: entry.payload, raw: "" };
    };
  return { client, calls };
}

function ref(r: string, name: string): Record<string, unknown> {
  return { ref: r, role: "statictext", name, actions: [] };
}

test("mergeSnapshotRefs:合并 refs 与 content_refs 并按 ref 去重", () => {
  const merged = mergeSnapshotRefs({
    refs: [ref("p1:1", "A"), ref("p1:2", "B")],
    content_refs: [ref("p1:2", "B-重复"), ref("p1:3", "C"), { ref: 123 }],
  });
  assert.deepEqual(merged.map((r) => r.ref), ["p1:1", "p1:2", "p1:3"]);
  assert.equal(merged[1].name, "B", "重复 ref 保留先出现者");
});

test("snapshot:complete=false 时跟随 continuation 续页并合并", async () => {
  const { client, calls } = scriptedClient([
    {
      payload: {
        status: "ok",
        snapshot: { id: "p1", complete: false, continuation: "c-1" },
        page: { title: "t", url: "u" },
        refs: [ref("p1:1", "A")],
      },
    },
    {
      payload: {
        status: "ok",
        snapshot: { id: "p2", complete: true, continuation: null },
        page: { title: "t", url: "u" },
        refs: [ref("p2:1", "B")],
        content_refs: [ref("p2:2", "C")],
      },
    },
  ]);

  const result = await snapshot(client, SESSION);

  assert.deepEqual(result.refs.map((r) => r.ref), ["p1:1", "p2:1", "p2:2"]);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].continuation, "c-1", "续页必须回传 continuation 游标");
});

test("snapshot:query 模式不续页(单次返回)", async () => {
  const { client, calls } = scriptedClient([
    {
      payload: {
        status: "ok",
        snapshot: { id: "p1", complete: false, continuation: "c-1" },
        page: { title: "t", url: "u" },
        refs: [ref("p1:9", "命中")],
      },
    },
  ]);

  const result = await snapshot(client, SESSION, "命中");

  assert.deepEqual(result.refs.map((r) => r.ref), ["p1:9"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].query, "命中");
});

test("snapshot:complete 缺省或 true 时不做续页", async () => {
  const { client, calls } = scriptedClient([
    {
      payload: { status: "ok", snapshot: { id: "p1" }, page: { title: "t", url: "u" }, refs: [ref("p1:1", "A")] },
    },
  ]);
  await snapshot(client, SESSION);
  assert.equal(calls.length, 1);
});
