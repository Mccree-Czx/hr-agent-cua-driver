/**
 * W2 外发流程测试:以脚本化的假 DriverClient 驱动步骤机,
 * 验证调用顺序、动作参数与出口语义(dry-run/证据/幂等/保守失败)。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { DriverClient, type ToolCallResult } from "../cua/driver-client.js";
import type { BrowserSession, SnapshotRef } from "../cua/session.js";
import type { UiContext } from "../cua/ui-actions.js";
import { runGreet } from "./greet.js";
import { runRequestResume } from "./request-resume.js";

const RESUME_URL = "https://lpt.liepin.com/resume/detail?resIdEncode=r-1001&sfrom=R_SEARCH_CONDITION";

type Payload = Record<string, unknown>;

interface ScriptEntry {
  tool: string;
  payload: Payload;
}

/** 脚本化调用序列:严格按序应答,队列耗尽且允许重复时重复最后一条(超时路径用) */
class Scenario {
  readonly calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  repeatLast = false;
  private queue: ScriptEntry[] = [];
  private last: ScriptEntry | null = null;

  expect(tool: string, payload: Payload = {}): this {
    this.queue.push({ tool, payload });
    return this;
  }

  nav(): this {
    return this.expect("browser_navigate", {});
  }

  snap(refs: Array<Partial<SnapshotRef> & { name: string | null }>, url = RESUME_URL): this {
    let index = this.calls.length * 10;
    return this.expect("get_browser_state", {
      status: "ok",
      snapshot: { id: `p${this.queue.length + 1}` },
      page: { title: "猎聘", url },
      refs: refs.map((r) => ({
        ref: r.ref ?? `pX:${index++}`,
        role: r.role ?? "button",
        name: r.name,
        actions: r.actions ?? ["click"],
        visibility: r.visibility ?? "in_viewport",
      })),
    });
  }

  click(): this {
    return this.expect("browser_click", { effect: "clicked" });
  }

  type(): this {
    return this.expect("browser_type", {});
  }

  client(): DriverClient {
    const client = new DriverClient({ bin: "fake", session: "test", timeoutMs: 1000 });
    (client as unknown as { callTool: (tool: string, args: Record<string, unknown>) => Promise<ToolCallResult> }).callTool =
      async (tool, args) => {
        this.calls.push({ tool, args });
        let entry = this.queue.shift();
        if (entry === undefined) {
          if (this.repeatLast && this.last !== null) {
            entry = this.last;
          } else {
            throw new Error(`未预期的调用: ${tool} ${JSON.stringify(args).slice(0, 120)}`);
          }
        }
        if (entry.tool !== tool) {
          throw new Error(`调用顺序不符: 期望 ${entry.tool}, 实际 ${tool}`);
        }
        this.last = entry;
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
  window: { pid: 1, windowId: 2, title: "猎聘 - Google Chrome", minimized: false, isOnScreen: true },
};

function makeCtx(scenario: Scenario, dryRun = false): { ctx: UiContext; logs: string[] } {
  let clock = 0;
  const logs: string[] = [];
  const ctx: UiContext = {
    client: scenario.client(),
    session: FAKE_SESSION,
    dryRun,
    log: (m) => logs.push(m),
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  };
  return { ctx, logs };
}

// ---------- greet ----------

test("greet 快乐路径:导航→定位打招呼→点击→证据确认;不打无准备之弹窗", async () => {
  const s = new Scenario();
  s.nav()
    .snap([{ name: "工作经历", role: "statictext", actions: [] }]) // 1) 导航后页面检查
    .snap([{ name: "打招呼", ref: "p2:5" }, { name: "工作经历", role: "statictext", actions: [] }]) // 2) 页面就绪
    .snap([{ name: "打招呼", ref: "p3:9" }]) // 3) 定位打招呼
    .click() // 点击
    .snap([{ name: "工作经历", role: "statictext", actions: [] }]) // 4) 弹窗检查(无弹窗)
    .snap([{ name: "继续沟通", ref: "p5:11" }]); // 5) 成功证据

  const { ctx } = makeCtx(s);
  const outcome = await runGreet(ctx, { usercId: "r-1001", ejobId: "42" });

  assert.equal(outcome.success, true);
  assert.equal(outcome.alreadyChatted, false);
  assert.equal(outcome.evidence, "继续沟通");
  assert.deepEqual(s.tools(), [
    "browser_navigate",
    "get_browser_state",
    "get_browser_state",
    "get_browser_state",
    "browser_click",
    "get_browser_state",
    "get_browser_state",
  ]);
  const nav = s.calls[0].args;
  assert.match(String(nav.url), /resIdEncode=r-1001/);
  const click = s.calls[4].args;
  assert.equal(click.ref, "p3:9");
});

test("greet 弹窗路径:按 jobTitleHint 选择职位并确认", async () => {
  const s = new Scenario();
  s.nav()
    .snap([{ name: "打招呼", ref: "p1:1" }])
    .snap([{ name: "打招呼", ref: "p2:1" }])
    .snap([{ name: "打招呼", ref: "p3:1" }])
    .click()
    .snap([
      { name: "选择职位", role: "statictext", actions: [] },
      { name: "高级 Java 工程师", role: "button", actions: ["click"], ref: "p4:20" },
      { name: "产品经理", role: "button", actions: ["click"], ref: "p4:21" },
    ])
    .snap([{ name: "高级 Java 工程师", role: "button", actions: ["click"], ref: "p5:30" }])
    .click()
    .snap([{ name: "确定", role: "button", actions: ["click"], ref: "p6:31" }])
    .click()
    .snap([{ name: "继续沟通", ref: "p7:40" }]);

  const { ctx } = makeCtx(s);
  const outcome = await runGreet(ctx, { usercId: "r-1001", ejobId: "42", jobTitleHint: "高级 Java" });

  assert.equal(outcome.evidence, "继续沟通");
  const clicks = s.calls.filter((c) => c.tool === "browser_click").map((c) => c.args.ref);
  assert.deepEqual(clicks, ["p3:1", "p5:30", "p6:31"]);
});

test("greet 无 hint 多候选:保守失败并列出现场候选", async () => {
  const s = new Scenario();
  s.nav()
    .snap([{ name: "打招呼", ref: "p1:1" }])
    .snap([{ name: "打招呼", ref: "p2:1" }])
    .snap([{ name: "打招呼", ref: "p3:1" }])
    .click()
    .snap([
      { name: "选择职位", role: "statictext", actions: [] },
      { name: "高级 Java 工程师", role: "button", actions: ["click"], ref: "p4:20" },
      { name: "产品经理", role: "button", actions: ["click"], ref: "p4:21" },
    ]);

  const { ctx } = makeCtx(s);
  await assert.rejects(runGreet(ctx, { usercId: "r-1001", ejobId: "42" }), /无法确定目标职位.*jobTitle/s);
});

test("greet 未找到入口:轮询超时后失败(虚拟时钟)", async () => {
  const s = new Scenario();
  s.nav()
    .snap([{ name: "工作经历", role: "statictext", actions: [] }])
    .snap([{ name: "工作经历", role: "statictext", actions: [] }])
    .snap([{ name: "工作经历", role: "statictext", actions: [] }]);
  s.repeatLast = true;

  const { ctx } = makeCtx(s);
  await assert.rejects(runGreet(ctx, { usercId: "r-1001", ejobId: "42" }), /未找到「打招呼\/立即沟通」入口/);
  assert.ok(!s.tools().includes("browser_click"), "未定位到入口时不得发生点击");
});

test("greet dry-run:只定位不点击、不导航", async () => {
  const s = new Scenario();
  s.snap([{ name: "打招呼", ref: "p1:7" }]).snap([{ name: "打招呼", ref: "p2:7" }]);

  const { ctx, logs } = makeCtx(s, true);
  const outcome = await runGreet(ctx, { usercId: "r-1001", ejobId: "42" });

  assert.equal(outcome.evidence, "dry-run");
  assert.equal(s.tools().includes("browser_click"), false);
  assert.equal(s.tools().includes("browser_navigate"), false);
  assert.ok(logs.some((l) => l.includes("dry-run:不点击")));
});

test("greet 已存在会话:跳过打招呼(继续沟通在场)", async () => {
  const s = new Scenario();
  s.nav()
    .snap([{ name: "继续沟通", ref: "p1:2" }, { name: "工作经历", role: "statictext", actions: [] }]) // 导航检查
    .snap([{ name: "继续沟通", ref: "p2:2" }, { name: "工作经历", role: "statictext", actions: [] }]); // 页面就绪

  const { ctx } = makeCtx(s);
  const outcome = await runGreet(ctx, { usercId: "r-1001", ejobId: "42" });

  assert.equal(outcome.alreadyChatted, true);
  assert.equal(s.tools().includes("browser_click"), false);
});

// ---------- request-resume ----------

function scriptOpenIm(s: Scenario): Scenario {
  return s
    .snap([{ name: "工作经历", role: "statictext", actions: [] }]) // IM 前置检查(输入框不在)
    .snap([{ name: "在线沟通", ref: "pX:7" }]) // 定位 IM 入口
    .click()
    .snap([{ name: "发送消息", role: "textbox", actions: ["type"], ref: "pX:8" }]); // 输入框就绪
}

test("request-resume 快乐路径:打开 IM→点击索要→无二次弹窗→证据确认", async () => {
  const s = new Scenario();
  s.nav()
    .snap([{ name: "工作经历", role: "statictext", actions: [] }]) // 导航检查
    .snap([{ name: "工作经历", role: "statictext", actions: [] }]); // 页面就绪
  scriptOpenIm(s);
  s.snap([{ name: "工作经历", role: "statictext", actions: [] }]) // 点击前幂等检查(未索要)
    .snap([{ name: "索要简历", ref: "pY:12" }]) // 定位索要按钮
    .click()
    .snap([{ name: "工作经历", role: "statictext", actions: [] }]) // 弹窗检查(无)
    .snap([{ name: "已索要", ref: "pZ:13" }]); // 确认证据

  const { ctx } = makeCtx(s);
  const outcome = await runRequestResume(ctx, { resumeId: "r-1001", imId: "im-9" });

  assert.equal(outcome.success, true);
  assert.equal(outcome.confirmed, true);
  assert.equal(outcome.evidence, "已索要");
  const clicks = s.calls.filter((c) => c.tool === "browser_click").map((c) => c.args.ref);
  assert.deepEqual(clicks, ["pX:7", "pY:12"], "应依次点击:IM 入口 → 索要简历");
});

test("request-resume 未观察到证据:严格模式抛错,放行模式 confirmed=false", async () => {
  function buildScenario(): Scenario {
    const s = new Scenario();
    s.nav()
      .snap([{ name: "工作经历", role: "statictext", actions: [] }])
      .snap([{ name: "工作经历", role: "statictext", actions: [] }]);
    scriptOpenIm(s);
    s.snap([{ name: "工作经历", role: "statictext", actions: [] }])
      .snap([{ name: "索要简历", ref: "pY:12" }])
      .click()
      .snap([{ name: "工作经历", role: "statictext", actions: [] }])
      .snap([{ name: "工作经历", role: "statictext", actions: [] }]); // 无确认证据
    s.repeatLast = true;
    return s;
  }

  const strict = buildScenario();
  await assert.rejects(
    runRequestResume(makeCtx(strict).ctx, { resumeId: "r-1001" }),
    /未观察到确认/,
  );

  const lenient = buildScenario();
  const outcome = await runRequestResume(makeCtx(lenient).ctx, { resumeId: "r-1001", allowUnverified: true });
  assert.equal(outcome.success, true);
  assert.equal(outcome.confirmed, false);
  assert.equal(outcome.evidence, "unverified");
});

test("request-resume 幂等:已处于已索要状态时直接返回,不再点击", async () => {
  const s = new Scenario();
  s.nav()
    .snap([{ name: "工作经历", role: "statictext", actions: [] }])
    .snap([{ name: "工作经历", role: "statictext", actions: [] }]);
  scriptOpenIm(s);
  s.snap([{ name: "已索要", ref: "pW:5" }]); // 幂等检查命中

  const { ctx } = makeCtx(s);
  const outcome = await runRequestResume(ctx, { resumeId: "r-1001" });

  assert.equal(outcome.confirmed, true);
  assert.match(outcome.message, /先前已发出/);
  assert.equal(s.tools().filter((t) => t === "browser_click").length, 1, "仅应点击过一次 IM 入口");
});
