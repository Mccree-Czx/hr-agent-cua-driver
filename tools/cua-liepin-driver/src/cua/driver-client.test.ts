import { test } from "node:test";
import assert from "node:assert/strict";
import { CuaError } from "../contract.js";
import { DriverClient } from "./driver-client.js";
import type { ProcessRunner, RunOptions } from "./process.js";

interface Recorded {
  cmd: string;
  args: string[];
  opts: RunOptions;
}

function fakeRunner(result: {
  code?: number | null;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
}): { runner: ProcessRunner; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const runner: ProcessRunner = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return {
      code: result.code === undefined ? 0 : result.code,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      timedOut: result.timedOut ?? false,
    };
  };
  return { runner, calls };
}

function client(runner: ProcessRunner): DriverClient {
  return new DriverClient({ bin: "cua-driver", session: "hr-agent-test", timeoutMs: 1234, runner });
}

test("callTool:成功解析 + session/参数经 stdin JSON 传递", async () => {
  const { runner, calls } = fakeRunner({
    stdout: JSON.stringify({ status: "ok", target_id: "bt-1", tabs: [] }),
  });
  const result = await client(runner).callTool("get_browser_state", { pid: 42, window_id: 7 });

  assert.equal(result.status, "ok");
  assert.equal(result.data.target_id, "bt-1");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ["call", "get_browser_state"]);
  assert.equal(calls[0].opts.timeoutMs, 1234);
  const stdin = JSON.parse(calls[0].opts.stdin ?? "{}");
  assert.equal(stdin.session, "hr-agent-test");
  assert.equal(stdin.pid, 42);
  assert.equal(stdin.window_id, 7);
});

test("callTool:结构化拒绝(exit 0)解析 refusal", async () => {
  const { runner } = fakeRunner({
    stdout: JSON.stringify({
      status: "refused",
      refusal: { code: "browser_consent_required", message: "requires --grant existing-profile" },
    }),
  });
  const result = await client(runner).callTool("browser_prepare", {});
  assert.equal(result.status, "refused");
  assert.equal(result.refusalCode, "browser_consent_required");
  assert.match(result.refusalMessage ?? "", /existing-profile/);
});

test("callTool:无 status 字段的裸输出视为成功(list_windows 形状)", async () => {
  const { runner } = fakeRunner({
    stdout: JSON.stringify({ _legacy_windows: [{ pid: 1, window_id: 2, title: "猎聘" }] }),
  });
  const result = await client(runner).callTool("list_windows", {});
  assert.equal(result.status, "ok");
  assert.ok(Array.isArray((result.data as { _legacy_windows?: unknown[] })._legacy_windows));
});

test("callTool:effect=refused 形状解析 error.code(browser_click)", async () => {
  const { runner } = fakeRunner({
    stdout: JSON.stringify({
      effect: "refused",
      error: { code: "browser_ref_stale", hint: "ref is not a browser page ref" },
      summary: "refused (browser_ref_stale)",
    }),
  });
  const result = await client(runner).callTool("browser_click", {});
  assert.equal(result.status, "refused");
  assert.equal(result.refusalCode, "browser_ref_stale");
});

test("callTool:isError 形状抛 CuaError", async () => {
  const { runner } = fakeRunner({
    stdout: JSON.stringify({
      isError: true,
      structuredContent: { code: "background_unavailable", message: "occluded" },
    }),
  });
  await assert.rejects(client(runner).callTool("click", {}), /background_unavailable/);
});

test("callTool:非零退出抛 CuaError(附 stderr)", async () => {
  const { runner } = fakeRunner({ code: 1, stderr: "unknown tool" });
  await assert.rejects(client(runner).callTool("nope", {}), (err: unknown) => {
    assert.ok(err instanceof CuaError);
    assert.match((err as CuaError).message, /非零退出.*unknown tool/);
    return true;
  });
});

test("callTool:输出非 JSON 抛 CuaError", async () => {
  const { runner } = fakeRunner({ stdout: "not-json" });
  await assert.rejects(client(runner).callTool("x", {}), /输出非 JSON/);
});

test("callTool:超时抛 CuaError", async () => {
  const { runner } = fakeRunner({ timedOut: true });
  await assert.rejects(client(runner).callTool("x", {}), /超时/);
});

test("requireOk:拒绝时抛错并携带拒绝码", async () => {
  const { runner } = fakeRunner({
    stdout: JSON.stringify({ status: "refused", refusal: { code: "browser_ref_stale", message: "stale" } }),
  });
  await assert.rejects(client(runner).requireOk("browser_click", {}), /browser_ref_stale/);
});

test("version:解析 --version 输出", async () => {
  const { runner, calls } = fakeRunner({ stdout: "cua-driver 0.30.4\n" });
  assert.equal(await client(runner).version(), "cua-driver 0.30.4");
  assert.deepEqual(calls[0].args, ["--version"]);
});

/** 按序应答的运行器(超出长度后重复最后一条) */
function sequencedRunner(
  results: Array<{ code?: number | null; stdout?: string; stderr?: string; timedOut?: boolean }>,
): { runner: ProcessRunner; calls: Recorded[] } {
  const calls: Recorded[] = [];
  let index = 0;
  const runner: ProcessRunner = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const r = results[Math.min(index++, results.length - 1)];
    return {
      code: r.code === undefined ? 0 : r.code,
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      timedOut: r.timedOut ?? false,
    };
  };
  return { runner, calls };
}

test("callTool:session 结束后自动 start_session 复活并重试一次", async () => {
  const { runner, calls } = sequencedRunner([
    { code: 1, stderr: "session has ended; tool call 'list_windows' was rejected. Call start_session with session 'hr-agent-test'" },
    { code: 0, stdout: "{\"status\":\"ok\"}" },
    { code: 0, stdout: "{\"_legacy_windows\":[]}" },
  ]);
  const result = await client(runner).callTool("list_windows", {});

  assert.equal(result.status, "ok");
  assert.deepEqual(calls.map((c) => c.args[1]), ["list_windows", "start_session", "list_windows"]);
  const reviveStdin = JSON.parse(calls[1].opts.stdin ?? "{}");
  assert.equal(reviveStdin.session, "hr-agent-test", "复活调用必须携带同一 session 标签");
});

test("callTool:会话复活失败时原样抛错且不无限重试", async () => {
  const { runner, calls } = sequencedRunner([
    { code: 1, stderr: "session has ended ...was rejected" },
    { code: 1, stderr: "start_session failed" },
  ]);
  await assert.rejects(client(runner).callTool("list_windows", {}), /session has ended/);
  assert.equal(calls.length, 5, "1 次原调用 + 1 次复活(base) + 3 次派生(共 4 次 start_session),不得循环");
});

test("callTool:标签不可复活(session_unavailable) → 派生 base-1 成功并重试", async () => {
  const { runner, calls } = sequencedRunner([
    { code: 1, stderr: "{\"code\": \"session_unavailable\"}" },
    { code: 1, stderr: "session_unavailable" }, // 复活 base 失败
    { code: 0, stdout: "{\"session\":\"hr-agent-test-1\",\"active\":true}" }, // 派生 -1 成功
    { code: 0, stdout: "{\"_legacy_windows\":[]}" }, // 重试成功
  ]);
  const c = client(runner);
  const result = await c.callTool("list_windows", {});

  assert.equal(result.status, "ok");
  assert.deepEqual(calls.map((x) => x.args[1]), ["list_windows", "start_session", "start_session", "list_windows"]);
  const deriveStdin = JSON.parse(calls[2].opts.stdin ?? "{}");
  assert.equal(deriveStdin.session, "hr-agent-test-1", "派生档位必须为 base-1");
  const retryStdin = JSON.parse(calls[3].opts.stdin ?? "{}");
  assert.equal(retryStdin.session, "hr-agent-test-1", "重试必须用派生后的标签");
  assert.equal(c.sessionLabel, "hr-agent-test-1");
});
