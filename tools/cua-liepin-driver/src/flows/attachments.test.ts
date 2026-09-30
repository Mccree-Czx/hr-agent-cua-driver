/**
 * W4 附件流程测试:文件校验(真实临时目录)+ 脚本化下载流程(假 DriverClient)。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { DriverClient, type ToolCallResult } from "../cua/driver-client.js";
import {
  ensureAbsoluteDir,
  fileNameOf,
  listDir,
  validateResumeFile,
  waitForNewFile,
} from "../cua/download.js";
import type { BrowserSession, SnapshotResult } from "../cua/session.js";
import type { UiContext } from "../cua/ui-actions.js";
import {
  findAttachmentRef,
  findAttachmentTab,
  moveIntoDir,
  runAttachDownloadUi,
  runAttachFetchUi,
  stripChromeDuplicateSuffix,
} from "./attachments.js";

const PDF_BYTES = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n", "latin1");
const PDF_SHA = createHash("sha256").update(PDF_BYTES).digest("hex");
const CHAT_URL = "https://lpt.liepin.com/chat?imId=abc";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "cua-attach-"));
}

// ---------- 纯函数 / 文件系统层 ----------

test("findAttachmentRef:文件名样式优先,其次简历/附件文案;均需可点击", () => {
  const snap = (names: Array<{ name: string; actions?: string[] }>): SnapshotResult => ({
    snapshotId: "p1",
    outline: "",
    page: { title: "t", url: CHAT_URL },
    refs: names.map((n, i) => ({
      ref: `p1:${i}`,
      role: "statictext",
      name: n.name,
      actions: n.actions ?? [],
    })),
  });

  assert.equal(findAttachmentRef(snap([{ name: "张三的简历.pdf", actions: ["click"] }]))?.name, "张三的简历.pdf");
  assert.equal(findAttachmentRef(snap([{ name: "在线简历" }, { name: "查看附件", actions: ["click"] }]))?.name, "查看附件");
  assert.equal(findAttachmentRef(snap([{ name: "张三的简历.pdf" }])), null, "无 click 动作时不应命中");
  assert.equal(findAttachmentRef(snap([{ name: "你好" }, { name: "在吗" }])), null);
  // 2026-09-30 真机:会话页 UI 词不得误报(筛选项/工具栏)
  assert.equal(
    findAttachmentRef(snap([{ name: "有简历", actions: ["click"] }])),
    null,
    "筛选 tab「有简历」不得误当附件卡片",
  );
  assert.equal(
    findAttachmentRef(snap([{ name: "浏览简历", actions: ["click"] }])),
    null,
    "工具栏「浏览简历」不得误当附件卡片",
  );
  assert.equal(
    findAttachmentRef(snap([{ name: "收到简历", actions: ["click"] }])),
    null,
    "投递通知区「收到简历」不得误当附件卡片",
  );
});

test("findAttachmentRef:列表区通知卡不得误报——范围限定『在线沟通』rootwebarea 之后(2026-09-30 真机)", () => {
  const mk = (refs: Array<{ name: string | null; role?: string; actions?: string[] }>): SnapshotResult => ({
    snapshotId: "p1",
    outline: "",
    page: { title: "t", url: CHAT_URL },
    refs: refs.map((r, i) => ({
      ref: `p1:${i}`,
      role: r.role ?? "statictext",
      name: r.name,
      actions: r.actions ?? [],
    })),
  });

  // 真机形态:列表区通知卡(可点,含"简历")在 rootwebarea 之前;消息区附件卡在其后
  const snapWithNotice = mk([
    { name: null, role: "superscript" },
    { name: "收到了 潘女士、王思又等3人的简历", actions: ["click", "pointer"] },
    { name: "在线沟通", role: "rootwebarea", actions: [] },
    { name: "潘女士的简历", actions: [] },
  ]);
  assert.equal(
    findAttachmentRef(snapWithNotice),
    null,
    "rootwebarea 后的附件卡不可点时不得回退命中列表区通知卡",
  );

  // 消息区的可点附件文案仍应命中
  const snapWithCard = mk([
    { name: "收到了 潘女士、王思又等3人的简历", actions: ["click", "pointer"] },
    { name: "在线沟通", role: "rootwebarea", actions: [] },
    { name: "查看附件", actions: ["click"] },
  ]);
  assert.equal(findAttachmentRef(snapWithCard)?.name, "查看附件");
});

test("findAttachmentTab:仅匹配「附件简历」可点节点", () => {
  const snap = (refs: Array<{ name: string | null; actions?: string[] }>): SnapshotResult => ({
    snapshotId: "p1",
    outline: "",
    page: { title: "t", url: CHAT_URL },
    refs: refs.map((r, i) => ({
      ref: `p1:${i}`,
      role: "statictext",
      name: r.name,
      actions: r.actions ?? [],
    })),
  });
  assert.equal(findAttachmentTab(snap([{ name: "附件简历", actions: ["click"] }]))?.ref, "p1:0");
  assert.equal(findAttachmentTab(snap([{ name: "附件简历" }])), null, "无 click 不命中");
  assert.equal(findAttachmentTab(snap([{ name: "在线简历", actions: ["click"] }])), null);
});

test("stripChromeDuplicateSuffix/moveIntoDir:Chrome 重名后缀规范化(2026-09-30 smoke)", () => {
  assert.equal(stripChromeDuplicateSuffix("邵越-中文简历 (1).pdf"), "邵越-中文简历.pdf");
  assert.equal(stripChromeDuplicateSuffix("a (12).docx"), "a.docx");
  assert.equal(stripChromeDuplicateSuffix("正常名.pdf"), "正常名.pdf");
  assert.equal(stripChromeDuplicateSuffix("无空格(1).pdf"), "无空格(1).pdf", "非 Chrome 格式不动");

  const dl = tempDir();
  const out = tempDir();
  try {
    const src = join(dl, "张三 (3).pdf");
    writeFileSync(src, PDF_BYTES);
    const dest = moveIntoDir(src, out);
    assert.equal(fileNameOf(dest), "张三.pdf", "搬移时应去除 Chrome 去重后缀");
    assert.ok(existsSync(dest));
    assert.ok(!existsSync(src), "源文件应已移除");
  } finally {
    rmSync(dl, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test("validateResumeFile:有效 PDF 返回 bytes/sha256;空文件与非 PDF 拒绝", () => {
  const dir = tempDir();
  try {
    const pdf = join(dir, "ok.pdf");
    writeFileSync(pdf, PDF_BYTES);
    const validated = validateResumeFile(pdf);
    assert.equal(validated.bytes, PDF_BYTES.length);
    assert.equal(validated.sha256, PDF_SHA);
    assert.equal(validated.magic, "%PDF-");

    const empty = join(dir, "empty.pdf");
    writeFileSync(empty, Buffer.alloc(0));
    assert.throws(() => validateResumeFile(empty), /内容为空/);

    const notPdf = join(dir, "x.docx");
    writeFileSync(notPdf, Buffer.from("PK\u0003\u0004fake-docx", "latin1"));
    assert.throws(() => validateResumeFile(notPdf), /非 PDF/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureAbsoluteDir:相对路径拒绝;缺失目录自动创建并返回规范化路径", () => {
  assert.throws(() => ensureAbsoluteDir("relative/dir"), /绝对路径/);
  const base = tempDir();
  try {
    const nested = join(base, "a", "b");
    const canonical = ensureAbsoluteDir(nested);
    assert.ok(existsSync(nested));
    assert.equal(canonical, ensureAbsoluteDir(nested), "重复调用应稳定返回同一规范化路径");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("waitForNewFile:差集识别新文件;超时返回 null", async () => {
  const dir = tempDir();
  try {
    const old = join(dir, "old.pdf");
    writeFileSync(old, PDF_BYTES);
    const before = listDir(dir);

    const fresh = join(dir, "new.pdf");
    writeFileSync(fresh, PDF_BYTES);
    let clock = 0;
    const found = await waitForNewFile(dir, before, {
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    });
    assert.equal(found, fresh, "只应返回差集中的新文件");

    let clock2 = 0;
    const none = await waitForNewFile(dir, listDir(dir), {
      sleep: async (ms) => {
        clock2 += ms;
      },
      now: () => clock2,
    });
    assert.equal(none, null);
    assert.ok(clock2 >= 20_000, "超时应由虚拟时钟推进,实际 " + clock2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("waitForNewFile:排除 .crdownload 临时文件,等待最终重命名(2026-09-30 真机)", async () => {
  const dir = tempDir();
  try {
    const before = listDir(dir);
    // Chrome 未确认下载:先出现 .crdownload(应被忽略)
    writeFileSync(join(dir, "未确认 120431.crdownload"), PDF_BYTES);
    let clock = 0;
    let round = 0;
    const found = await waitForNewFile(dir, before, {
      sleep: async (ms) => {
        clock += ms;
        round += 1;
        if (round === 1) {
          writeFileSync(join(dir, "张三的简历.pdf"), PDF_BYTES); // 模拟 Chrome 完成重命名
        }
      },
      now: () => clock,
    });
    assert.equal(found, join(dir, "张三的简历.pdf"), "应忽略 crdownload,命中最终文件");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("waitForNewFile:仅 .crdownload 时超时返回 null(不交付临时态)", async () => {
  const dir = tempDir();
  try {
    const before = listDir(dir);
    writeFileSync(join(dir, "未确认 999.crdownload"), PDF_BYTES);
    let clock = 0;
    const none = await waitForNewFile(dir, before, {
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    });
    assert.equal(none, null);
    assert.ok(clock >= 20_000, "超时应由虚拟时钟推进");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- 脚本化流程 ----------

interface Entry {
  tool: string;
  payload?: Record<string, unknown>;
  refusal?: { code: string; message: string };
  /** 模拟非零退出(DriverClient.callTool 抛 CuaError,如 background_unavailable) */
  throwMsg?: string;
  onCall?: () => void;
}

class Scenario {
  readonly calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  private queue: Entry[] = [];

  push(entry: Entry): this {
    this.queue.push(entry);
    return this;
  }

  nav(url: string): this {
    return this.push({ tool: "browser_navigate", payload: {} }) && this.push({
      tool: "get_browser_state",
      payload: snapPayload([{ name: "你好" }], url),
    });
  }

  snap(names: string[], url = CHAT_URL, withClick = false): this {
    return this.push({
      tool: "get_browser_state",
      payload: snapPayload(names.map((n) => ({ name: n })), url, withClick),
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
        entry.onCall?.();
        if (entry.throwMsg !== undefined) {
          throw new Error(entry.throwMsg);
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
        return { tool, status: "ok", data: entry.payload ?? {}, raw: "" };
      };
    return client;
  }
}

function snapPayload(
  refs: Array<{ name: string }>,
  url: string,
  withClick = false,
): Record<string, unknown> {
  return {
    status: "ok",
    snapshot: { id: "p1" },
    page: { title: "猎聘", url },
    refs: refs.map((r, i) => ({
      ref: `p1:${i}`,
      role: "statictext",
      name: r.name,
      actions: withClick ? ["click"] : [],
    })),
  };
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

test("attach-fetch 无附件:三态 no-attachment,不触发下载", async () => {
  const s = new Scenario();
  s.nav(CHAT_URL).snap(["你好", "在吗"]);

  const outDir = tempDir();
  try {
    const outcome = await runAttachFetchUi(makeCtx(s), { pageUrl: CHAT_URL, outDir, dryRun: false });
    assert.equal(outcome.found, false);
    assert.equal(outcome.success, false);
    assert.equal(outcome.reason, "no-attachment");
    assert.ok(!s.calls.some((c) => c.tool === "browser_download"));
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("attach-fetch 成功:页签检出→弹窗截图→坐标点击→Downloads 差集→搬移→PDF 校验", async () => {
  const s = new Scenario();
  const outDir = tempDir();
  const dlDir = tempDir();
  const oldEnv = process.env.LIEPIN_DOWNLOAD_DIR;
  process.env.LIEPIN_DOWNLOAD_DIR = dlDir;
  try {
    s.nav(CHAT_URL).snap(["附件简历"], CHAT_URL, true);
    s.push({ tool: "browser_click", payload: { effect: "clicked" } }); // 点页签开弹窗
    s.push({ tool: "get_window_state", payload: { screenshot_width: 3072, capture_id: "cap-1" } });
    s.push({
      tool: "click",
      payload: { effect: "clicked" },
      onCall: () => writeFileSync(join(dlDir, "张三的简历.pdf"), PDF_BYTES),
    }); // 坐标点击下载按钮+模拟原生下载落盘

    const outcome = await runAttachFetchUi(makeCtx(s), { pageUrl: CHAT_URL, outDir, dryRun: false });

    assert.equal(outcome.found, true);
    assert.equal(outcome.success, true);
    assert.equal(outcome.sha256, PDF_SHA);
    assert.equal(outcome.fileName, "张三的简历.pdf");
    assert.equal(outcome.bytes, PDF_BYTES.length);
    assert.equal(outcome.sourceOrigin, "ui-download");
    assert.ok(!existsSync(join(dlDir, "张三的简历.pdf")), "Downloads 文件应已搬走");
    assert.ok(existsSync(join(ensureAbsoluteDir(outDir), "张三的简历.pdf")), "文件应位于 outDir");

    // 坐标=窗口宽-右缘偏移(3072-738=2334),y=430;capture_id 锚定截图
    const clickCall = s.calls.find((c) => c.tool === "click");
    assert.ok(clickCall !== undefined);
    assert.equal(clickCall.args.x, 2334);
    assert.equal(clickCall.args.y, 430);
    assert.equal(clickCall.args.capture_id, "cap-1");
    assert.equal(clickCall.args.delivery_mode, undefined, "background 成功不得升级 foreground");
  } finally {
    if (oldEnv === undefined) {
      delete process.env.LIEPIN_DOWNLOAD_DIR;
    } else {
      process.env.LIEPIN_DOWNLOAD_DIR = oldEnv;
    }
    rmSync(outDir, { recursive: true, force: true });
    rmSync(dlDir, { recursive: true, force: true });
  }
});

test("attach-fetch 点击未成功:download-click-failed 且不静默吞错", async () => {
  const s = new Scenario();
  const outDir = tempDir();
  const dlDir = tempDir();
  const oldEnv = process.env.LIEPIN_DOWNLOAD_DIR;
  process.env.LIEPIN_DOWNLOAD_DIR = dlDir;
  try {
    s.nav(CHAT_URL).snap(["附件简历"], CHAT_URL, true);
    s.push({ tool: "browser_click", payload: {} }); // 点页签
    s.push({ tool: "get_window_state", payload: { screenshot_width: 3072 } });
    s.push({ tool: "click", refusal: { code: "refused", message: "click refused" } });

    const outcome = await runAttachFetchUi(makeCtx(s), { pageUrl: CHAT_URL, outDir, dryRun: false });
    assert.equal(outcome.found, true);
    assert.equal(outcome.success, false);
    assert.equal(outcome.reason, "download-click-failed");
  } finally {
    if (oldEnv === undefined) {
      delete process.env.LIEPIN_DOWNLOAD_DIR;
    } else {
      process.env.LIEPIN_DOWNLOAD_DIR = oldEnv;
    }
    rmSync(outDir, { recursive: true, force: true });
    rmSync(dlDir, { recursive: true, force: true });
  }
});

test("attach-fetch background 被丢弃:foreground 升级重试成功", async () => {
  const s = new Scenario();
  const outDir = tempDir();
  const dlDir = tempDir();
  const oldEnv = process.env.LIEPIN_DOWNLOAD_DIR;
  process.env.LIEPIN_DOWNLOAD_DIR = dlDir;
  try {
    s.nav(CHAT_URL).snap(["附件简历"], CHAT_URL, true);
    s.push({ tool: "browser_click", payload: {} }); // 点页签
    s.push({ tool: "get_window_state", payload: { screenshot_width: 3072 } });
    s.push({
      tool: "click",
      throwMsg: 'cua-driver call click 非零退出 code=1: {"code":"background_unavailable","escalation":{"recommended":"foreground"}}',
    });
    s.push({
      tool: "click",
      payload: { effect: "clicked" },
      onCall: () => writeFileSync(join(dlDir, "张三的简历.pdf"), PDF_BYTES),
    });

    const outcome = await runAttachFetchUi(makeCtx(s), { pageUrl: CHAT_URL, outDir, dryRun: false });
    assert.equal(outcome.success, true, "foreground 升级后应成功");
    const clicks = s.calls.filter((c) => c.tool === "click");
    assert.equal(clicks.length, 2, "应有一次 background 与一次 foreground 调用");
    assert.equal(clicks[1].args.delivery_mode, "foreground");
    assert.equal(clicks[1].args.capture_id, undefined, "foreground 升级不带 capture_id");
  } finally {
    if (oldEnv === undefined) {
      delete process.env.LIEPIN_DOWNLOAD_DIR;
    } else {
      process.env.LIEPIN_DOWNLOAD_DIR = oldEnv;
    }
    rmSync(outDir, { recursive: true, force: true });
    rmSync(dlDir, { recursive: true, force: true });
  }
});

test("attach-fetch dry-run:只检出不上传下载", async () => {
  const s = new Scenario();
  const outDir = tempDir();
  try {
    s.nav(CHAT_URL).snap(["附件简历"], CHAT_URL, true);
    const outcome = await runAttachFetchUi(makeCtx(s), { pageUrl: CHAT_URL, outDir, dryRun: true });
    assert.equal(outcome.found, true);
    assert.equal(outcome.reason, "dry-run");
    assert.ok(
      !s.calls.some((c) => c.tool === "click" || c.tool === "get_window_state"),
      "dry-run 不得点页签/截图/点下载",
    );
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("attach-download 严格契约:无附件必须抛错(非零退出)", async () => {
  const s = new Scenario();
  s.nav(CHAT_URL).snap(["你好"]);
  const outDir = tempDir();
  try {
    await assert.rejects(
      runAttachDownloadUi(makeCtx(s), { pageUrl: CHAT_URL, outDir, dryRun: false }),
      /附件下载失败\(no-attachment\)/,
    );
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("attach-download 成功路径输出 success 形态", async () => {
  const s = new Scenario();
  const outDir = tempDir();
  const dlDir = tempDir();
  const oldEnv = process.env.LIEPIN_DOWNLOAD_DIR;
  process.env.LIEPIN_DOWNLOAD_DIR = dlDir;
  try {
    s.nav(CHAT_URL).snap(["附件简历"], CHAT_URL, true);
    s.push({ tool: "browser_click", payload: {} }); // 点页签开弹窗
    s.push({ tool: "get_window_state", payload: { screenshot_width: 3072 } });
    s.push({
      tool: "click",
      payload: {},
      onCall: () => writeFileSync(join(dlDir, "简历.pdf"), PDF_BYTES),
    });

    const outcome = await runAttachDownloadUi(makeCtx(s), { pageUrl: CHAT_URL, outDir, dryRun: false });
    assert.equal(outcome.success, true);
    assert.equal(outcome.sha256, PDF_SHA);
    assert.ok(relative(outDir, outcome.file ?? "") !== "", "file 应位于下载目录下");
  } finally {
    if (oldEnv === undefined) {
      delete process.env.LIEPIN_DOWNLOAD_DIR;
    } else {
      process.env.LIEPIN_DOWNLOAD_DIR = oldEnv;
    }
    rmSync(outDir, { recursive: true, force: true });
    rmSync(dlDir, { recursive: true, force: true });
  }
});

test("attach-fetch --name 会话名键模式:导航会话页→点开会话→页签检出→坐标下载校验", async () => {
  const s = new Scenario();
  const outDir = tempDir();
  const dlDir = tempDir();
  const oldEnv = process.env.LIEPIN_DOWNLOAD_DIR;
  process.env.LIEPIN_DOWNLOAD_DIR = dlDir;
  try {
    s.push({ tool: "browser_navigate", payload: {} }) // about:blank 清场
      .push({ tool: "browser_navigate", payload: {} }) // 目标页导航
      .snap(["邵女士"], CHAT_URL, true) // 会话行快照
      .push({ tool: "browser_click", payload: {} }) // 点开会话
      .snap(["附件简历"], CHAT_URL, true); // 附件入口(页签)快照
    s.push({ tool: "browser_click", payload: {} }); // 点页签开弹窗
    s.push({ tool: "get_window_state", payload: { screenshot_width: 3072 } });
    s.push({
      tool: "click",
      payload: {},
      onCall: () => writeFileSync(join(dlDir, "邵越-中文简历.pdf"), PDF_BYTES),
    });

    const outcome = await runAttachFetchUi(makeCtx(s), { name: "邵女士", outDir, dryRun: false });

    assert.equal(outcome.found, true);
    assert.equal(outcome.success, true);
    assert.equal(outcome.fileName, "邵越-中文简历.pdf");
    assert.equal(outcome.sha256, PDF_SHA);
    assert.ok(outcome.steps.some((l) => l.includes("会话行")), "应记录会话行定位");
    assert.ok(outcome.steps.some((l) => l.includes("检出附件入口")), "应检出附件入口");
    assert.deepEqual(
      s.calls.map((c) => c.tool),
      [
        "browser_navigate",
        "browser_navigate",
        "get_browser_state",
        "browser_click",
        "get_browser_state",
        "browser_click",
        "get_window_state",
        "click",
      ],
    );
  } finally {
    if (oldEnv === undefined) {
      delete process.env.LIEPIN_DOWNLOAD_DIR;
    } else {
      process.env.LIEPIN_DOWNLOAD_DIR = oldEnv;
    }
    rmSync(outDir, { recursive: true, force: true });
    rmSync(dlDir, { recursive: true, force: true });
  }
});

test("attach --name 降级通道:列表不可用但目标会话已打开时继续附件检出", async () => {
  const s = new Scenario();
  const outDir = tempDir();
  const dlDir = tempDir();
  const oldEnv = process.env.LIEPIN_DOWNLOAD_DIR;
  process.env.LIEPIN_DOWNLOAD_DIR = dlDir;
  const url = "https://lpt.liepin.com/chat/im";
  try {
    for (let i = 0; i < 6; i++) {
      s.push({ tool: "browser_navigate", payload: {} }); // about:blank 清场
      s.push({ tool: "browser_navigate", payload: {} }); // 目标页导航
      s.snap(["其他人"], CHAT_URL, true); // 列表快照始终不含会话行
    }
    // 降级检查:右侧详情区含目标名(特征伴随 26岁/硕士);会话已打开→直接找附件入口
    s.snap(["邵女士", "26岁", "硕士"], CHAT_URL, true)
      .snap(["附件简历"], CHAT_URL, true); // 附件入口(页签)快照
    s.push({ tool: "browser_click", payload: {} }); // 点页签开弹窗
    s.push({ tool: "get_window_state", payload: { screenshot_width: 3072 } });
    s.push({
      tool: "click",
      payload: {},
      onCall: () => writeFileSync(join(dlDir, "邵越-中文简历.pdf"), PDF_BYTES),
    });

    const outcome = await runAttachFetchUi(makeCtx(s), { name: "邵女士", outDir, dryRun: false });

    assert.equal(outcome.success, true);
    assert.equal(outcome.fileName, "邵越-中文简历.pdf");
    assert.ok(outcome.steps.some((l) => l.includes("降级通道")), "应标记降级通道");
  } finally {
    if (oldEnv === undefined) {
      delete process.env.LIEPIN_DOWNLOAD_DIR;
    } else {
      process.env.LIEPIN_DOWNLOAD_DIR = oldEnv;
    }
    rmSync(outDir, { recursive: true, force: true });
    rmSync(dlDir, { recursive: true, force: true });
  }
});

test("attach --name 会话未找到时报明确错误(清场重试 6 次后放弃)", async () => {
  const s = new Scenario();
  const outDir = tempDir();
  const url = "https://lpt.liepin.com/chat/im";
  try {
    for (let i = 0; i < 6; i++) {
      s.push({ tool: "browser_navigate", payload: {} }); // about:blank 清场
      s.push({ tool: "browser_navigate", payload: {} }); // 目标页导航
      s.snap(["其他人"], CHAT_URL, true);
    }
    s.snap(["其他人"], CHAT_URL, true); // 降级检查:当前会话名(无详情特征)

    await assert.rejects(
      runAttachFetchUi(makeCtx(s), { name: "邵女士", outDir, dryRun: false }),
      /未找到「邵女士」.*已重试 6 次/,
    );
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
