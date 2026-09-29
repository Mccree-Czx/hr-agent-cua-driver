import { test } from "node:test";
import assert from "node:assert/strict";
import { CuaError, EXIT_AUTH_EXPIRED, EXIT_FAILED, EXIT_RISK_CONTROL, checkRiskMarkers, exitCodeOf } from "./contract.js";

test("CuaError 退出码映射", () => {
  assert.equal(new CuaError("failed", "x").exitCode, EXIT_FAILED);
  assert.equal(new CuaError("auth-expired", "x").exitCode, EXIT_AUTH_EXPIRED);
  assert.equal(new CuaError("risk-control", "x").exitCode, EXIT_RISK_CONTROL);
  assert.equal(exitCodeOf(new Error("plain")), EXIT_FAILED);
  assert.equal(exitCodeOf(new CuaError("auth-expired", "x")), EXIT_AUTH_EXPIRED);
});

test("风控标记扫描:结构性标记全路径命中风控", () => {
  assert.throws(() => checkRiskMarkers("redirected to safe.liepin.com captchaPage"), (err: unknown) => {
    assert.ok(err instanceof CuaError);
    assert.equal((err as CuaError).kind, "risk-control");
    return true;
  });
});

test("风控标记扫描:软标记仅失败路径命中(成功路径不误伤简历文本)", () => {
  const resumeText = "候选人简历:负责安全验证相关模块开发";
  assert.doesNotThrow(() => checkRiskMarkers(resumeText));
  assert.throws(() => checkRiskMarkers(resumeText, { failed: true }), (err: unknown) => {
    assert.ok(err instanceof CuaError);
    assert.equal((err as CuaError).kind, "risk-control");
    return true;
  });
});

test("风控标记扫描:登录态失效命中 auth-expired", () => {
  assert.throws(() => checkRiskMarkers("请先登录后再操作"), (err: unknown) => {
    assert.ok(err instanceof CuaError);
    assert.equal((err as CuaError).kind, "auth-expired");
    return true;
  });
});

test("风控标记扫描:正常文本不误报", () => {
  assert.doesNotThrow(() => checkRiskMarkers("已发起沟通(使用职位预设招呼语)"));
  assert.doesNotThrow(() => checkRiskMarkers("已发起沟通", { failed: false }));
});
