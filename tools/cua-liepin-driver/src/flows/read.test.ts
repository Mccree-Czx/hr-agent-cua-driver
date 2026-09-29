/**
 * W3 读类流程测试:脚本化假 DriverClient 验证导航/抽取/穿透调用序列与输出字段。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { DriverClient, type ToolCallResult } from "../cua/driver-client.js";
import type { BrowserSession } from "../cua/session.js";
import type { UiContext } from "../cua/ui-actions.js";
import { captureIdsByClickThrough, runReadChatMsg } from "./read-pages.js";
import { runReadResume } from "./read-resume.js";

const RESUME_URL = "https://lpt.liepin.com/resume/detail?resIdEncode=r-1&sfrom=R_SEARCH_CONDITION";

interface ScriptEntry {
  tool: string;
  payload: Record<string, unknown>;
}

class Scenario {
  readonly calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  private queue: ScriptEntry[] = [];

  expect(tool: string, payload: Record<string, unknown> = {}): this {
    this.queue.push({ tool, payload });
    return this;
  }

  nav(): this {
    return this.expect("browser_navigate", {});
  }

  snap(refs: Array<{ name: string | null; role?: string; ref?: string; actions?: string[] }>, url = RESUME_URL): this {
    const index = this.calls.length * 10;
    return this.expect("get_browser_state", {
      status: "ok",
      snapshot: { id: `p${this.queue.length + 1}` },
      page: { title: "猎聘", url },
      refs: refs.map((r, i) => ({
        ref: r.ref ?? `pX:${index + i}`,
        role: r.role ?? "statictext",
        name: r.name,
        actions: r.actions ?? [],
      })),
    });
  }

  click(): this {
    return this.expect("browser_click", { effect: "clicked" });
  }

  client(): DriverClient {
    const client = new DriverClient({ bin: "fake", session: "test", timeoutMs: 1000 });
    (client as unknown as { callTool: (tool: string, args: Record<string, unknown>) => Promise<ToolCallResult> }).callTool =
      async (tool, args) => {
        this.calls.push({ tool, args });
        const entry = this.queue.shift();
        if (entry === undefined) {
          throw new Error(`未预期的调用: ${tool}`);
        }
        if (entry.tool !== tool) {
          throw new Error(`调用顺序不符: 期望 ${entry.tool}, 实际 ${tool}`);
        }
        return { tool, status: "ok", data: entry.payload, raw: JSON.stringify(entry.payload) };
      };
    return client;
  }

  tools(): string[] {
    return this.calls.map((c) => c.tool);
  }
}

const FAKE_SESSION: BrowserSession = {
  targetId: "bt-1",
  activeTabId: "tab-1",
  pageUrl: "",
  window: { pid: 1, windowId: 2, title: "猎聘", minimized: false, isOnScreen: true },
};

function makeCtx(s: Scenario): UiContext {
  let clock = 0;
  return {
    client: s.client(),
    session: FAKE_SESSION,
    dryRun: false,
    log: () => undefined,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  };
}

test("runReadResume:导航→就绪→抽取 want_title 与 raw_text", async () => {
  const s = new Scenario();
  s.nav()
    .snap([{ name: "工作经历" }])
    .snap([
      { name: "张三", role: "heading" },
      { name: "期望职位" },
      { name: "Java开发" },
      { name: "后端开发" },
      { name: "期望薪资" },
      { name: "20-30K" },
      { name: "工作经历" },
      { name: "某公司" },
    ]);

  const outcome = await runReadResume(makeCtx(s), { resumeId: "r-1" });

  assert.equal(outcome.resume_id, "r-1");
  assert.equal(outcome.source, "ui");
  assert.equal(outcome.want_title, "Java开发、后端开发");
  assert.equal(outcome.name, "张三");
  assert.equal(outcome.extraction.want_title_source, "期望职位");
  assert.deepEqual(outcome.extraction.unvalidated, []);
  assert.ok(outcome.raw_text.includes("Java开发"));
  assert.deepEqual(s.tools(), ["browser_navigate", "get_browser_state", "get_browser_state"]);
});

test("runReadResume:无期望区块时标记 unvalidated 且不伪造数据", async () => {
  const s = new Scenario();
  s.nav()
    .snap([{ name: "工作经历" }])
    .snap([{ name: "工作经历" }, { name: "某公司" }]);

  const outcome = await runReadResume(makeCtx(s), { resumeId: "r-2" });

  assert.equal(outcome.want_title, "");
  assert.equal(outcome.name, null);
  assert.deepEqual(outcome.extraction.unvalidated, ["want_title"]);
});

test("captureIdsByClickThrough:点击→读 URL→返回列表页", async () => {
  const s = new Scenario();
  s.click().snap([{ name: "张三" }], "https://lpt.liepin.com/resume/detail?resIdEncode=cap-1").nav();

  const captures = await captureIdsByClickThrough(makeCtx(s), ["p1:5"], RESUME_URL, "resIdEncode", false);

  assert.equal(captures.length, 1);
  assert.equal(captures[0].id, "cap-1");
  assert.equal(captures[0].url, "https://lpt.liepin.com/resume/detail?resIdEncode=cap-1");
  assert.deepEqual(s.tools(), ["browser_click", "get_browser_state", "browser_navigate"]);
  assert.equal(s.calls[0].args.ref, "p1:5");
  assert.equal(s.calls[2].args.url, RESUME_URL, "穿透后必须返回列表页");
});

test("captureIdsByClickThrough:dry-run 不点击、只报告 ref", async () => {
  const s = new Scenario();
  const captures = await captureIdsByClickThrough(makeCtx(s), ["p1:5", "p1:6"], RESUME_URL, "resIdEncode", true);

  assert.deepEqual(captures, [
    { ref: "p1:5", url: "", id: null },
    { ref: "p1:6", url: "", id: null },
  ]);
  assert.equal(s.calls.length, 0, "dry-run 必须零调用");
});

test("runReadChatMsg:附件卡片文案迹象检测", async () => {
  const s = new Scenario();
  const url = "https://lpt.liepin.com/chat?imId=abc";
  s.nav()
    .snap([{ name: "你好" }], url)
    .snap([{ name: "你好" }, { name: "张三的简历.pdf" }, { name: "在吗" }], url);

  const outcome = await runReadChatMsg(makeCtx(s), { pageUrl: url, imId: "abc", dryRun: false });

  assert.equal(outcome.attachment_hint, true);
  assert.ok(outcome.steps.some((l) => l.includes("附件卡片")));
  assert.deepEqual(s.tools(), ["browser_navigate", "get_browser_state", "get_browser_state"]);
});
