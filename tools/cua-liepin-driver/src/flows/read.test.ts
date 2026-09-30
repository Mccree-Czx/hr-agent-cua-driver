/**
 * W3 读类流程测试:脚本化假 DriverClient 验证导航/抽取/穿透调用序列与输出字段。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { DriverClient, type ToolCallResult } from "../cua/driver-client.js";
import type { BrowserSession } from "../cua/session.js";
import type { UiContext } from "../cua/ui-actions.js";
import { extractJobRecords } from "../cua/extract.js";
import { captureIdsByClickThrough, readPage, runReadChatMsg, runReadList, runReadSearch } from "./read-pages.js";
import { runReadResume } from "./read-resume.js";

const RESUME_URL = "https://lpt.liepin.com/resume/detail?resIdEncode=r-1&sfrom=R_SEARCH_CONDITION";

interface ScriptEntry {
  tool: string;
  payload: Record<string, unknown>;
  refusal?: { code: string; message: string };
}

class Scenario {
  readonly calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  private queue: ScriptEntry[] = [];

  expect(tool: string, payload: Record<string, unknown> = {}, refusal?: { code: string; message: string }): this {
    this.queue.push({ tool, payload, refusal });
    return this;
  }

  nav(): this {
    return this.expect("browser_navigate", {});
  }

  snap(refs: Array<{ name: string | null; role?: string; ref?: string; actions?: string[]; visibility?: string }>, url = RESUME_URL): this {
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
        visibility: r.visibility ?? "in_viewport",
      })),
    });
  }

  click(): this {
    return this.expect("browser_click", { effect: "clicked" });
  }

  /** 点击被拒(stale 重试场景) */
  clickRefused(code: string): this {
    return this.expect("browser_click", {}, { code, message: `refused (${code}): ref is stale - snapshot superseded` });
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
        if (entry.refusal !== undefined) {
          return {
            tool,
            status: "refused",
            refusalCode: entry.refusal.code,
            refusalMessage: entry.refusal.message,
            data: {},
            raw: "",
          };
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
    minPageLines: 0, // 关闭内容充分性校验(专用用例单独开启)
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
  s.click().snap([{ name: "张三" }], "https://lpt.liepin.com/resume/detail?resIdEncode=cap-1").nav().nav();

  const captures = await captureIdsByClickThrough(makeCtx(s), ["p1:5"], RESUME_URL, "resIdEncode", false);

  assert.equal(captures.length, 1);
  assert.equal(captures[0].id, "cap-1");
  assert.equal(captures[0].id_source, "url");
  assert.equal(captures[0].url, "https://lpt.liepin.com/resume/detail?resIdEncode=cap-1");
  assert.deepEqual(s.tools(), ["browser_click", "get_browser_state", "browser_navigate", "browser_navigate"]);
  assert.equal(s.calls[0].args.ref, "p1:5");
  assert.equal(s.calls[3].args.url, RESUME_URL, "穿透后必须返回列表页");
});

test("captureIdsByClickThrough:URL 无 id 时回退读预览层「简历编号」(联调校准)", async () => {
  const s = new Scenario();
  s.click()
    .snap(
      [
        { name: "邵女士" },
        { name: "简历编号" },
        { name: ":" },
        { name: "eb75dde295fdSc7f903cb4428" },
        { name: "请输入备注内容", role: "textbox" },
      ],
      "https://lpt.liepin.com/chat/im#preview",
    )
    .nav()
    .nav();

  const captures = await captureIdsByClickThrough(makeCtx(s), ["p1:7"], "https://lpt.liepin.com/chat/im", "resIdEncode", false);

  assert.equal(captures[0].id, "eb75dde295fdSc7f903cb4428");
  assert.equal(captures[0].id_source, "preview");
  assert.equal(captures[0].url, "https://lpt.liepin.com/chat/im#preview");
  assert.deepEqual(s.tools(), ["browser_click", "get_browser_state", "browser_navigate", "browser_navigate"]);
});

test("captureIdsByClickThrough:预览层也无编号时不伪造 id", async () => {
  const s = new Scenario();
  s.click().snap([{ name: "温女士" }, { name: "简历备注" }], "https://lpt.liepin.com/recommend#preview").nav().nav();

  const captures = await captureIdsByClickThrough(makeCtx(s), ["p1:9"], "https://lpt.liepin.com/recommend", "resIdEncode", false);

  assert.equal(captures[0].id, null);
  assert.equal(captures[0].id_source, "url");
  assert.equal(captures[0].url, "https://lpt.liepin.com/recommend#preview");
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

test("runReadChatMsg --name 模式:点开命名会话并抽取消息(会话名键替代 im_id)", async () => {
  const s = new Scenario();
  const url = "https://lpt.liepin.com/chat/im";
  const row = { name: "邵女士", role: "statictext", actions: ["click"] };
  s.nav()
    .snap([row]) // checkPageState
    .snap([row, { name: "你好~我这里有个职位很适合你", role: "statictext" }]) // 会话列表
    .click() // 点开会话
    .snap([row, { name: "邵女士的简历.pdf", role: "statictext" }]); // 消息区(含附件卡)

  const outcome = await runReadChatMsg(makeCtx(s), { pageUrl: url, name: "邵女士", dryRun: false });

  assert.equal(outcome.attachment_hint, true);
  assert.ok(outcome.steps.some((l) => l.includes("会话行")));
  assert.deepEqual(s.tools(), [
    "browser_navigate",
    "get_browser_state",
    "get_browser_state",
    "browser_click",
    "get_browser_state",
  ]);
});

test("runReadChatMsg --name 模式:会话未找到时报明确错误", async () => {
  const s = new Scenario();
  s.nav()
    .snap([{ name: "其他人", role: "statictext", actions: ["click"] }])
    .snap([{ name: "其他人", role: "statictext", actions: ["click"] }]);

  await assert.rejects(
    runReadChatMsg(makeCtx(s), { pageUrl: "https://lpt.liepin.com/chat/im", name: "邵女士", dryRun: false }),
    /未找到「邵女士」/,
  );
});

test("runReadChatMsg url 模式:附件卡片文案迹象检测", async () => {
  const s = new Scenario();
  const url = "https://lpt.liepin.com/chat?imId=abc";
  s.nav().nav().snap([{ name: "你好" }, { name: "张三的简历.pdf" }, { name: "在吗" }], url); // 清场+导航+快照

  const outcome = await runReadChatMsg(makeCtx(s), { pageUrl: url, imId: "abc", dryRun: false });

  assert.equal(outcome.attachment_hint, true);
  assert.ok(outcome.steps.some((l) => l.includes("附件卡片")));
  assert.deepEqual(s.tools(), ["browser_navigate", "browser_navigate", "get_browser_state"]);
});

test("runReadList:autoCaptureRows 逐行穿透并把 job_id 合并进 records(joblist --with-ids)", async () => {
  const s = new Scenario();
  const row = { name: "销售经理", role: "link", actions: ["click"] };
  s.nav()
    .nav() // about:blank 清场
    .snap([row]) // 快照(行)
    .click() // 穿透点击
    .snap([{ name: "销售经理" }], "https://lpt.liepin.com/job/detail/preview?ejob_id=J9")
    .nav() // about:blank 清场(预览层 frame 残留防护)
    .nav() // 回列表
    .snap([row]);

  const outcome = await runReadList(makeCtx(s), {
    pageUrl: "https://lpt.liepin.com/job/manager",
    captureRefs: [],
    idParam: "ejob_id",
    dryRun: false,
    label: "职位列表页",
    recordsExtractor: (snap) => extractJobRecords(snap),
    autoCaptureRows: true,
  });

  const records = outcome.records as Array<Record<string, unknown>>;
  assert.equal(records.length, 1);
  assert.equal(records[0].title, "销售经理");
  assert.equal(records[0].jobId, "J9");
  assert.equal(outcome.extraction_status, "validated");
  assert.ok(outcome.steps.some((l) => l.includes("自动穿透 1 行")));
});

test("runReadList:stale 点击被拒→重新快照同序重试成功(2026-09-30)", async () => {
  const s = new Scenario();
  const row = { name: "销售经理", role: "link", actions: ["click"] };
  s.nav()
    .nav() // about:blank 清场
    .snap([row]) // 列表快照
    .clickRefused("browser_ref_stale") // 第 1 次点击被拒(stale)
    .snap([row]) // resolveRefs 重新快照
    .click() // 重试点击成功
    .snap([{ name: "销售经理" }], "https://lpt.liepin.com/job/detail/preview?ejob_id=J9")
    .nav() // about:blank 清场
    .nav(); // 回列表

  const outcome = await runReadList(makeCtx(s), {
    pageUrl: "https://lpt.liepin.com/job/manager",
    captureRefs: [],
    idParam: "ejob_id",
    dryRun: false,
    label: "职位列表页",
    recordsExtractor: (snap) => extractJobRecords(snap),
    autoCaptureRows: true,
  });

  const records = outcome.records as Array<Record<string, unknown>>;
  assert.equal(records[0].jobId, "J9", "stale 重试后应成功取到 ID");
  assert.ok(outcome.steps.some((l) => l.includes("自动穿透 1 行,解析到 ID 1 个")));
});

test("runReadSearch:key参数预填→点'搜索'提交→结果 records(2026-09-30 真机校准)", async () => {
  const s = new Scenario();
  const card = [
    { name: "温女士" },
    { name: "27岁" },
    { name: "3年" },
    { name: "本科" },
    { name: "济南" },
    { name: "期望：" },
    { name: "墨西哥" },
    { name: "海外销售" },
    { name: "15-20K" },
  ];
  s.nav()
    .nav() // about:blank 清场
    .snap([{ name: "搜索", role: "button", actions: ["click"] }]) // 搜索页(含提交按钮)
    .click() // 提交搜索
    .snap(card); // 结果页

  const outcome = await runReadSearch(makeCtx(s), { keywords: "海外销售", captureRefs: [], dryRun: false });

  const records = outcome.records as Array<Record<string, unknown>>;
  assert.equal(records.length, 1);
  assert.equal(records[0].name, "温女士");
  assert.equal(records[0].expect_position, "海外销售");
  assert.equal(outcome.extraction_status, "validated");
  assert.ok(outcome.steps.some((l) => l.includes("已提交")), "应记录已提交");
});

test("runReadSearch:引导卡出现时先关闭再提交", async () => {
  const s = new Scenario();
  s.nav()
    .nav() // about:blank 清场
    .snap([{ name: "我知道了", role: "button", actions: ["click"] }]) // 引导卡
    .click() // 关闭引导
    .snap([{ name: "搜索", role: "button", actions: ["click"] }]) // 搜索页
    .click() // 提交
    .snap([{ name: "李女士" }, { name: "30岁" }, { name: "5年" }, { name: "硕士" }, { name: "北京" }]);

  const outcome = await runReadSearch(makeCtx(s), { keywords: "测试", captureRefs: [], dryRun: false });
  const records = outcome.records as Array<Record<string, unknown>>;
  assert.equal(records.length, 1);
  assert.equal(records[0].name, "李女士");
  assert.ok(outcome.steps.some((l) => l.includes("引导卡已关闭")));
});

test("readPage 语义残缺重试:首次壳(3行)→清场重导航后完整(30行)成功", async () => {
  const s = new Scenario();
  const shell = Array.from({ length: 3 }, (_, i) => ({ name: `壳${i}` }));
  const full = Array.from({ length: 30 }, (_, i) => ({ name: `内容${i}` }));
  // 每轮(含首轮) = about:blank 清场 + 目标页导航 + 单快照
  s.nav().nav().snap(shell).nav().nav().snap(full);

  const ctx = { ...makeCtx(s), minPageLines: 26 };
  const { lines } = await readPage(ctx, "https://lpt.liepin.com/chat/im");

  assert.equal(lines.length, 30, "重试后应拿到完整文本");
  assert.deepEqual(s.tools(), [
    "browser_navigate", // about:blank 清场(首轮)
    "browser_navigate",
    "get_browser_state",
    "browser_navigate", // 第二轮清场
    "browser_navigate",
    "get_browser_state",
  ]);
});

test("readPage 残缺时调用 rotateSession(第 2 轮起轮换标签)", async () => {
  const s = new Scenario();
  const shell = [{ name: "壳" }];
  const full = Array.from({ length: 30 }, (_, i) => ({ name: `内容${i}` }));
  s.nav().nav().snap(shell).nav().nav().snap(full);

  let rotated = 0;
  const ctx = {
    ...makeCtx(s),
    minPageLines: 26,
    rotateSession: async () => {
      rotated += 1;
      return true;
    },
  };
  const { lines } = await readPage(ctx, "https://lpt.liepin.com/chat/im");
  assert.equal(lines.length, 30);
  assert.equal(rotated, 1, "第 2 轮应触发一次标签轮换");
});

test("readPage 持续残缺:清场重试 6 次后抛明确错误(不交付残缺数据)", async () => {
  const s = new Scenario();
  const shell = [{ name: "壳" }];
  for (let i = 0; i < 6; i++) {
    s.nav().nav().snap(shell); // 每轮=清场+导航+快照
  }

  const ctx = { ...makeCtx(s), minPageLines: 26 };
  await assert.rejects(
    readPage(ctx, "https://lpt.liepin.com/chat/im"),
    /页面内容不足\(文本行 1 < 26,已重试 6 次\)/,
  );
  assert.equal(s.tools().length, 18, "6 轮 × (清场导航 + 目标导航 + 快照)");
});
