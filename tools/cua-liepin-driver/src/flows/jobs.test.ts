/**
 * W5 管理类流程测试:jobpublish(填写+保存/发布+校验反馈)与
 * jobdelete(穿透映射+安全闸+全选结束)的步骤机与出口语义。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { DriverClient, type ToolCallResult } from "../cua/driver-client.js";
import type { BrowserSession, SnapshotRef } from "../cua/session.js";
import type { UiContext } from "../cua/ui-actions.js";
import {
  collectFeedback,
  findTitleInput,
  parsePublishData,
  runJobpublish,
} from "./jobpublish.js";
import { findJobRows, findSelectAll, runJobdelete } from "./jobdelete.js";

type Payload = Record<string, unknown>;

interface ScriptEntry {
  tool: string;
  payload: Payload;
}

class Scenario {
  readonly calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  private queue: ScriptEntry[] = [];

  expect(tool: string, payload: Payload = {}): this {
    this.queue.push({ tool, payload });
    return this;
  }

  nav(): this {
    return this.expect("browser_navigate", {});
  }

  snap(refs: Array<Partial<SnapshotRef> & { name: string | null }>, url = "https://lpt.liepin.com/job/publish?ejobActionType=publish"): this {
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

  type(): this {
    return this.expect("browser_type", {});
  }

  client(): DriverClient {
    const client = new DriverClient({ bin: "fake", session: "test", timeoutMs: 1000 });
    (client as unknown as { callTool: (tool: string, args: Record<string, unknown>) => Promise<ToolCallResult> }).callTool =
      async (tool, args) => {
        this.calls.push({ tool, args });
        const entry = this.queue.shift();
        if (entry === undefined) {
          throw new Error(`未预期的调用: ${tool} ${JSON.stringify(args).slice(0, 100)}`);
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

function makeCtx(s: Scenario, dryRun = false): UiContext {
  let clock = 0;
  return {
    client: s.client(),
    session: FAKE_SESSION,
    dryRun,
    log: () => undefined,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  };
}

const JOB_MANAGER = "https://lpt.liepin.com/job/manager";
const JOB_ROW = { name: "海外ToB渠道销售（出海品牌）", role: "link", actions: ["click", "pointer"] };
const NAV_LINKS = [
  { name: "人才推荐", role: "link", actions: ["click"] },
  { name: "职位管理", role: "link", actions: ["click"] },
  { name: "搜索人才", role: "link", actions: ["click"] },
];
const SELECT_ALL = { name: null, role: "labeltext", actions: ["click", "pointer"] };
const END_DISABLED = { name: "minus-square 结束", role: "button", actions: [] };
const END_ENABLED = { name: "minus-square 结束", role: "button", actions: ["click", "pointer"] };

// ---------- jobpublish ----------

test("parsePublishData:必填校验", () => {
  const ok = parsePublishData('{"title":"T","jobCategory":"N000330","description":"D"}');
  assert.equal(ok.title, "T");
  assert.throws(() => parsePublishData(""), /缺少 --data/);
  assert.throws(() => parsePublishData("not-json"), /不是合法 JSON/);
  assert.throws(() => parsePublishData('{"jobCategory":"N1","description":"D"}'), /title/);
  assert.throws(() => parsePublishData('{"title":"T","description":"D"}'), /jobCategory/);
  assert.throws(() => parsePublishData('{"title":"T","jobCategory":"N1"}'), /description/);
});

test("findTitleInput:combobox+type,in_viewport 优先", () => {
  const snap = {
    snapshotId: "p1",
    outline: "",
    page: { title: "t", url: "u" },
    refs: [
      { ref: "a", role: "combobox", name: null, actions: ["type"], visibility: "offscreen" },
      { ref: "b", role: "statictext", name: "职位名称", actions: [] },
      { ref: "c", role: "combobox", name: null, actions: ["click", "type"], visibility: "in_viewport" },
    ],
  };
  assert.equal(findTitleInput(snap)?.ref, "c");
});

test("collectFeedback:校验提示与成功文案提取", () => {
  const snap = {
    snapshotId: "p1",
    outline: "",
    page: { title: "t", url: "u" },
    refs: [
      { ref: "a", role: "statictext", name: "请选择所属部门", actions: [] },
      { ref: "b", role: "statictext", name: "发布成功", actions: [] },
      { ref: "c", role: "statictext", name: "普通文案", actions: [] },
    ],
  };
  const { validation, success } = collectFeedback(snap);
  assert.deepEqual(validation, ["请选择所属部门"]);
  assert.deepEqual(success, ["发布成功"]);
});

test("runJobpublish:dry-run 只定位不输入不提交", async () => {
  const s = new Scenario();
  s.snap([
    { name: null, role: "combobox", actions: ["click", "type"] },
    { name: "保 存", role: "button", actions: ["click"] },
    { name: "发布职位", role: "button", actions: ["click"] },
  ]);

  const outcome = await runJobpublish(makeCtx(s, true), {
    data: { title: "T", jobCategory: "N1", description: "D" },
    draftOnly: true,
  });

  assert.equal(outcome.status, "dry_run");
  assert.equal(outcome.success, false);
  assert.deepEqual(s.tools(), ["get_browser_state"], "dry-run 不导航、不输入、不点击");
  assert.ok(outcome.unvalidated_fields.some((f) => f.includes("jobCategory")));
});

test("runJobpublish:校验未过 → validation_blocked(不谎报成功)", async () => {
  const s = new Scenario();
  s.nav()
    .snap([{ name: "职位名称" }]) // checkPageState
    .snap([
      { name: null, role: "combobox", actions: ["click", "type"] },
      { name: "保 存", role: "button", actions: ["click"] },
    ])
    .type()
    .snap([{ name: "保 存", role: "button", actions: ["click"] }])
    .click()
    .snap([{ name: "请选择所属部门" }])
    .snap([{ name: "请选择所属部门" }])
    .snap([{ name: "请选择所属部门" }]);

  const outcome = await runJobpublish(makeCtx(s), {
    data: { title: "T", jobCategory: "N1", description: "D" },
    draftOnly: true,
  });

  assert.equal(outcome.success, false);
  assert.equal(outcome.status, "validation_blocked");
  assert.deepEqual(outcome.feedback, ["请选择所属部门"]);
  assert.ok(s.tools().includes("browser_type"));
  assert.ok(s.tools().includes("browser_click"));
});

test("runJobpublish:成功文案命中 → published", async () => {
  const s = new Scenario();
  s.nav()
    .snap([{ name: "职位名称" }])
    .snap([
      { name: null, role: "combobox", actions: ["type"] },
      { name: "发布职位", role: "button", actions: ["click"] },
    ])
    .type()
    .snap([{ name: "发布职位", role: "button", actions: ["click"] }])
    .click()
    .snap([{ name: "发布成功" }]);

  const outcome = await runJobpublish(makeCtx(s), {
    data: { title: "T", jobCategory: "N1", description: "D" },
    draftOnly: false,
  });

  assert.equal(outcome.success, true);
  assert.equal(outcome.status, "published");
});

// ---------- jobdelete ----------

test("findJobRows:过滤导航/分页,仅保留职位行 link", () => {
  const snap = {
    snapshotId: "p1",
    outline: "",
    page: { title: "t", url: JOB_MANAGER },
    refs: [
      ...NAV_LINKS.map((r, i) => ({ ref: `n${i}`, role: r.role, name: r.name, actions: r.actions, visibility: "in_viewport" })),
      { ref: "pg", role: "link", name: "0 /1", actions: ["click"], visibility: "in_viewport" },
      { ref: "row1", role: "link", name: "海外ToB渠道销售（出海品牌）", actions: ["click"], visibility: "in_viewport" },
    ],
  };
  const rows = findJobRows(snap);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ref, "row1");
});

test("findSelectAll:取列表区最后一个可点击 labeltext", () => {
  const snap = {
    snapshotId: "p1",
    outline: "",
    page: { title: "t", url: JOB_MANAGER },
    refs: [
      { ref: "l1", role: "labeltext", name: null, actions: ["click"] },
      { ref: "l2", role: "labeltext", name: null, actions: ["click"] },
      { ref: "x", role: "labeltext", name: null, actions: [] },
    ],
  };
  assert.equal(findSelectAll(snap)?.ref, "l2");
});

test("runJobdelete:dry-run 仅报告行,不点击不映射", async () => {
  const s = new Scenario();
  s.nav().snap([JOB_ROW, SELECT_ALL, END_DISABLED]);

  const outcome = await runJobdelete(makeCtx(s, true), { jobIds: ["J1"], confirmDestructive: true });

  assert.equal(outcome.status, "dry_run");
  assert.equal(outcome.mapping.length, 1);
  assert.equal(outcome.mapping[0].ejobId, null);
  assert.deepEqual(s.tools(), ["browser_navigate", "get_browser_state"]);
});

test("runJobdelete:未提供二次确认闸 → 拦截为 dry_run", async () => {
  const s = new Scenario();
  s.nav().snap([JOB_ROW]);

  const outcome = await runJobdelete(makeCtx(s), { jobIds: ["J1"], confirmDestructive: false });

  assert.equal(outcome.status, "dry_run");
  assert.ok(outcome.steps.some((t) => t.includes("confirm-destructive")));
});

test("runJobdelete:目标≠全部行 → need_manual(拒绝全选误伤)", async () => {
  const otherRow = { name: "Java后端开发工程师", role: "link", actions: ["click"] };
  const s = new Scenario();
  s.nav()
    .snap([JOB_ROW, otherRow]) // runJobdelete 列表
    .snap([JOB_ROW, otherRow]) // mapRowsToIds first
    .click()
    .snap([{ name: "海外ToB渠道销售（出海品牌）" }], `${JOB_MANAGER.replace("/manager", "/detail/preview")}?ejob_id=J1`)
    .nav()
    .snap([JOB_ROW, otherRow])
    .click()
    .snap([{ name: "Java后端开发工程师" }], `${JOB_MANAGER.replace("/manager", "/detail/preview")}?ejob_id=J2`)
    .nav()
    .snap([JOB_ROW, otherRow]);

  const outcome = await runJobdelete(makeCtx(s), { jobIds: ["J1"], confirmDestructive: true });

  assert.equal(outcome.status, "need_manual");
  assert.equal(outcome.mapping.length, 2);
  assert.equal(outcome.mapping[0].ejobId, "J1");
  assert.equal(outcome.mapping[1].ejobId, "J2");
});

test("runJobdelete:目标=全部行 → 全选→结束→确认 → ended_deletion_pending", async () => {
  const detailUrl = "https://lpt.liepin.com/job/detail/preview?ejob_id=J1";
  const s = new Scenario();
  s.nav()
    .snap([JOB_ROW, SELECT_ALL, END_DISABLED]) // runJobdelete 列表
    .snap([JOB_ROW, SELECT_ALL, END_DISABLED]) // mapRowsToIds first
    .click() // 点击行
    .snap([{ name: "职位详情" }], detailUrl)
    .nav() // 回列表
    .snap([JOB_ROW, SELECT_ALL, END_DISABLED])
    .snap([JOB_ROW, SELECT_ALL, END_DISABLED]) // snap2 取全选
    .click() // 全选
    .snap([JOB_ROW, SELECT_ALL, END_ENABLED]) // snap3 结束就绪
    .click() // 结束
    .snap([{ name: "确定", role: "button", actions: ["click"] }]) // snap4 确认弹窗
    .click() // 确认
    .snap([{ name: "职位已结束" }]); // 成功反馈

  const outcome = await runJobdelete(makeCtx(s), { jobIds: ["J1"], confirmDestructive: true });

  assert.equal(outcome.status, "ended_deletion_pending");
  assert.equal(outcome.deletion_pending, true);
  assert.deepEqual(outcome.ended, ["J1"]);
  assert.deepEqual(outcome.deleted, []);
  assert.ok(outcome.steps.some((t) => t.includes("已点击「minus-square 结束」")));
});

test("runJobdelete:目标数超上限 → 零调用拒绝", async () => {
  const s = new Scenario();
  const outcome = await runJobdelete(makeCtx(s), {
    jobIds: ["1", "2", "3", "4", "5", "6"],
    confirmDestructive: true,
  });
  assert.equal(outcome.status, "need_manual");
  assert.equal(s.calls.length, 0);
});

test("runJobdelete:招聘中未匹配 → 切待发布 → 全选删除 → deleted(联调路径)", async () => {
  const pendingRow = { name: "销售经理", role: "link", actions: ["click"] };
  const otherRow = { name: "Java后端开发工程师", role: "link", actions: ["click"] };
  const pendingTab = { name: "待发布", role: "statictext", actions: ["click"] };
  const delBtn = { name: "delete 删除", role: "button", actions: ["click"] };
  const dialogText = { name: "删除职位会将对应职位下的应聘简历也一起删除，您确定要删除？" };

  const s = new Scenario();
  s.nav()
    .snap([otherRow, pendingTab]) // runJobdelete 列表(招聘中)
    .snap([otherRow, pendingTab]) // map first(招聘中)
    .click()
    .snap([{ name: "Java后端开发工程师" }], "https://lpt.liepin.com/job/detail/preview?ejob_id=J2")
    .nav()
    .snap([otherRow, pendingTab])
    .snap([pendingRow, pendingTab]) // switchTab 快照 → 点待发布
    .click()
    .snap([pendingRow, pendingTab]) // map first(待发布)
    .click()
    .snap([{ name: "销售经理" }], "https://lpt.liepin.com/job/detail/preview?ejob_id=J1")
    .nav()
    .snap([pendingRow, pendingTab]) // 回列表
    .snap([pendingRow, SELECT_ALL]) // snap2 全选
    .click()
    .snap([pendingRow, delBtn]) // snap3 删除就绪
    .click()
    .snap([dialogText, delBtn]) // snap4 确认弹窗
    .click()
    .snap([{ name: "操作成功" }]); // 成功反馈

  const outcome = await runJobdelete(makeCtx(s), { jobIds: ["J1"], confirmDestructive: true });

  assert.equal(outcome.status, "deleted");
  assert.equal(outcome.success, true);
  assert.deepEqual(outcome.deleted, ["J1"]);
  assert.equal(outcome.deletion_pending, false);
  assert.ok(outcome.steps.some((t) => t.includes("待发布")));
});

test("runJobdelete:两个页签都无匹配 → not_found", async () => {
  const otherRow = { name: "Java后端开发工程师", role: "link", actions: ["click"] };
  const pendingTab = { name: "待发布", role: "statictext", actions: ["click"] };

  const s = new Scenario();
  s.nav()
    .snap([otherRow, pendingTab])
    .snap([otherRow, pendingTab])
    .click()
    .snap([{ name: "Java后端开发工程师" }], "https://lpt.liepin.com/job/detail/preview?ejob_id=J2")
    .nav()
    .snap([otherRow, pendingTab])
    .snap([pendingTab]) // switchTab
    .click()
    .snap([pendingTab]); // 待发布无行 → mapping 空

  const outcome = await runJobdelete(makeCtx(s), { jobIds: ["J9"], confirmDestructive: true });

  assert.equal(outcome.status, "not_found");
  assert.equal(outcome.success, false);
});
