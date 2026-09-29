import { test } from "node:test";
import assert from "node:assert/strict";
import { findAnyText, matchRef, type NameMatcher } from "./ui-actions.js";
import type { SnapshotResult } from "./session.js";

function snap(refs: Array<{ name: string | null; role?: string; actions?: string[]; ref?: string }>): SnapshotResult {
  return {
    snapshotId: "p1",
    outline: "",
    page: { title: "t", url: "https://lpt.liepin.com/x" },
    refs: refs.map((r, i) => ({
      ref: r.ref ?? `p1:${i}`,
      role: r.role ?? "button",
      name: r.name,
      actions: r.actions ?? ["click"],
    })),
  };
}

test("matchRef:按候选名顺序优先(第一个命中即返回)", () => {
  const s = snap([
    { name: "立即沟通按钮", ref: "p1:0" },
    { name: "打招呼", ref: "p1:1" },
  ]);
  const matcher: NameMatcher = { names: ["立即沟通", "打招呼"] };
  assert.equal(matchRef(s, matcher)?.ref, "p1:0", "先声明的候选名优先");
});

test("matchRef:excludeNames / roles / actions 约束", () => {
  const s = snap([
    { name: "继续沟通", ref: "p1:0" },
    { name: "打招呼", ref: "p1:1", actions: ["click", "pointer"] },
    { name: "打招呼", ref: "p1:2", role: "statictext" },
  ]);
  const matcher: NameMatcher = {
    names: ["继续沟通", "打招呼"],
    excludeNames: ["继续沟通"],
    roles: ["button"],
    actions: ["click"],
  };
  assert.equal(matchRef(s, matcher)?.ref, "p1:1");
});

test("matchRef:无命中返回 null;name 为 null 不参与匹配", () => {
  assert.equal(matchRef(snap([{ name: null }, { name: "其他" }]), { names: ["打招呼"] }), null);
  assert.equal(matchRef(snap([]), { names: ["打招呼"] }), null);
});

test("findAnyText:返回首个命中的候选文本", () => {
  const s = snap([{ name: "已索要" }, { name: "继续沟通" }]);
  assert.equal(findAnyText(s, ["继续沟通", "已索要"]), "继续沟通");
  assert.equal(findAnyText(s, ["不存在"]), null);
});
