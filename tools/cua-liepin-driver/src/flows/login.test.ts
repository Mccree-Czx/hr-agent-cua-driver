/**
 * W5 登录流程测试:登录态判定纯函数 + 复用/等待/超时 三条出口路径。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { DriverClient, type ToolCallResult } from "../cua/driver-client.js";
import type { BrowserSession } from "../cua/session.js";
import type { UiContext } from "../cua/ui-actions.js";
import { classifyLoginPage, runLogin } from "./login.js";

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

  snap(names: string[], url = "https://lpt.liepin.com/"): this {
    return this.expect("get_browser_state", {
      status: "ok",
      snapshot: { id: `p${this.queue.length + 1}` },
      page: { title: "猎聘", url },
      refs: names.map((name, i) => ({
        ref: `pX:${i}`,
        role: "statictext",
        name,
        actions: [],
      })),
    });
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

test("classifyLoginPage:工作台导航=ok;登录页/登录文案=anonymous;安全验证=risk", () => {
  assert.equal(classifyLoginPage("https://lpt.liepin.com/", ["人才推荐", "职位管理"]), "ok");
  assert.equal(classifyLoginPage("https://lpt.liepin.com/login", ["登录"]), "anonymous");
  assert.equal(
    classifyLoginPage("https://lpt.liepin.com/", ["安全验证", "请完成滑块验证"]),
    "risk",
  );
  assert.equal(classifyLoginPage("https://safe.liepin.com/x", ["招聘"]), "risk");
  // 风控页即便含"招聘"字样,缺工作台双特征仍判 risk(上游教训)
  assert.equal(classifyLoginPage("https://lpt.liepin.com/", ["专业招聘平台"]), "anonymous");
});

test("runLogin:登录态有效 → 复用(仅 1 次导航 + 1 次快照)", async () => {
  const s = new Scenario();
  s.nav().snap(["人才推荐", "职位管理"]);

  const outcome = await runLogin(makeCtx(s), { timeoutMs: 10_000 });

  assert.equal(outcome.success, true);
  assert.equal(outcome.reused, true);
  assert.ok(outcome.message.includes("登录态仍然有效"));
  assert.deepEqual(s.tools(), ["browser_navigate", "get_browser_state"]);
});

test("runLogin:首探未登录 → 轮询命中工作台特征 → 登录成功", async () => {
  const s = new Scenario();
  s.nav()
    .snap(["扫码登录"], "https://lpt.liepin.com/login")
    .nav()
    .snap(["人才推荐", "职位管理"]);

  const outcome = await runLogin(makeCtx(s), { timeoutMs: 60_000 });

  assert.equal(outcome.success, true);
  assert.equal(outcome.reused, false);
  assert.equal(outcome.message, "登录成功");
  assert.ok(outcome.elapsed_ms >= 5_000, "等待了一轮探测间隔");
});

test("runLogin:持续未登录 → 超时失败(不谎报)", async () => {
  const s = new Scenario();
  s.nav()
    .snap(["扫码登录"], "https://lpt.liepin.com/login")
    .nav()
    .snap(["扫码登录"], "https://lpt.liepin.com/login")
    .nav()
    .snap(["扫码登录"], "https://lpt.liepin.com/login");

  const outcome = await runLogin(makeCtx(s), { timeoutMs: 11_000 });

  assert.equal(outcome.success, false);
  assert.equal(outcome.message, "登录超时");
});
