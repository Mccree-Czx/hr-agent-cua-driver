import { test } from "node:test";
import assert from "node:assert/strict";
import { flagValue, parseArgs } from "./args.js";

test("位置参数与 --key value", () => {
  const parsed = parseArgs(["abc123", "--ejobId", "42", "--json"]);
  assert.deepEqual(parsed.positional, ["abc123"]);
  assert.equal(parsed.flags.ejobId, "42");
  assert.equal(parsed.flags.json, true);
  assert.equal(flagValue(parsed, "ejobId"), "42");
  assert.equal(flagValue(parsed, "json"), null);
});

test("--key=value 形式", () => {
  const parsed = parseArgs(["--query=打招呼", "--limit=50"]);
  assert.equal(parsed.flags.query, "打招呼");
  assert.equal(parsed.flags.limit, "50");
});

test("连续布尔 flag 不被吞掉", () => {
  const parsed = parseArgs(["--attach", "--json"]);
  assert.equal(parsed.flags.attach, true);
  assert.equal(parsed.flags.json, true);
});
