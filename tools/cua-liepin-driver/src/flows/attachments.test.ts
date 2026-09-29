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
  listDir,
  validateResumeFile,
  waitForNewFile,
} from "../cua/download.js";
import type { BrowserSession, SnapshotResult } from "../cua/session.js";
import type { UiContext } from "../cua/ui-actions.js";
import { findAttachmentRef, runAttachDownloadUi, runAttachFetchUi } from "./attachments.js";

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

// ---------- 脚本化流程 ----------

interface Entry {
  tool: string;
  payload?: Record<string, unknown>;
  refusal?: { code: string; message: string };
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

  download(onCall: () => void): this {
    return this.push({ tool: "browser_download", payload: { success: true }, onCall });
  }

  downloadRefused(code: string): this {
    return this.push({ tool: "browser_download", refusal: { code, message: "destructive approval missing" } });
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

test("attach-fetch 成功:检出→下载→差集识别→PDF 校验(sha256 一致)", async () => {
  const s = new Scenario();
  const outDir = tempDir();
  try {
    s.nav(CHAT_URL).snap(["张三的简历.pdf"], CHAT_URL, true);
    s.download(() => writeFileSync(join(outDir, "张三的简历.pdf"), PDF_BYTES));

    const outcome = await runAttachFetchUi(makeCtx(s), { pageUrl: CHAT_URL, outDir, dryRun: false });

    assert.equal(outcome.found, true);
    assert.equal(outcome.success, true);
    assert.equal(outcome.sha256, PDF_SHA);
    assert.equal(outcome.fileName, "张三的简历.pdf");
    assert.equal(outcome.bytes, PDF_BYTES.length);
    assert.equal(outcome.sourceOrigin, "ui-download");

    const downloadCall = s.calls.find((c) => c.tool === "browser_download");
    assert.ok(downloadCall !== undefined);
    assert.equal(downloadCall.args.ref, "p1:0");
    assert.equal(downloadCall.args.destination_root, ensureAbsoluteDir(outDir));
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("attach-fetch 下载被拒绝:download-refused 且不静默吞错", async () => {
  const s = new Scenario();
  const outDir = tempDir();
  try {
    s.nav(CHAT_URL).snap(["张三的简历.pdf"], CHAT_URL, true);
    s.downloadRefused("browser_download_needs_approval");

    const outcome = await runAttachFetchUi(makeCtx(s), { pageUrl: CHAT_URL, outDir, dryRun: false });
    assert.equal(outcome.found, true);
    assert.equal(outcome.success, false);
    assert.equal(outcome.reason, "download-refused");
    assert.match(outcome.detail ?? "", /browser_download_needs_approval/);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("attach-fetch dry-run:只检出不上传下载", async () => {
  const s = new Scenario();
  const outDir = tempDir();
  try {
    s.nav(CHAT_URL).snap(["张三的简历.pdf"], CHAT_URL, true);
    const outcome = await runAttachFetchUi(makeCtx(s), { pageUrl: CHAT_URL, outDir, dryRun: true });
    assert.equal(outcome.found, true);
    assert.equal(outcome.reason, "dry-run");
    assert.ok(!s.calls.some((c) => c.tool === "browser_download"));
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
  try {
    s.nav(CHAT_URL).snap(["简历.pdf"], CHAT_URL, true);
    s.download(() => writeFileSync(join(outDir, "简历.pdf"), PDF_BYTES));

    const outcome = await runAttachDownloadUi(makeCtx(s), { pageUrl: CHAT_URL, outDir, dryRun: false });
    assert.equal(outcome.success, true);
    assert.equal(outcome.sha256, PDF_SHA);
    assert.ok(relative(outDir, outcome.file ?? "") !== "", "file 应位于下载目录下");
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
