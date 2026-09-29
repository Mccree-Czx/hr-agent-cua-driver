import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collectLines,
  dedupeConsecutive,
  extractWantTitles,
  hasAttachmentHint,
  matchEducation,
  matchExperience,
  matchSalary,
  parseResumeIdFromUrl,
  queryParam,
  rawTextOf,
  sectionAfter,
  textLinesOf,
  valueAfterColon,
} from "./extract.js";
import type { SnapshotResult } from "./session.js";

function snapOf(names: Array<string | null>, roles?: string[]): SnapshotResult {
  return {
    snapshotId: "p1",
    outline: "",
    page: { title: "t", url: "https://lpt.liepin.com/resume/detail?resIdEncode=r-1" },
    refs: names.map((name, i) => ({
      ref: `p1:${i}`,
      role: roles?.[i] ?? "statictext",
      name,
      actions: [],
    })),
  };
}

test("collectLines/dedupe/rawText:过滤空名、折叠连续重复", () => {
  const snap = snapOf(["张三", null, "张三", "Java开发", "Java开发", ""]);
  assert.equal(collectLines(snap).length, 4);
  assert.deepEqual(textLinesOf(snap), ["张三", "Java开发"]);
  assert.equal(rawTextOf(snap), "张三\nJava开发");
  assert.equal(dedupeConsecutive(collectLines(snap)).length, 2);
});

test("sectionAfter:标题后收集到 stop 标题为止", () => {
  const lines = ["张三", "期望职位", "Java开发", "后端开发", "工作经历", "某公司"];
  const section = sectionAfter(lines, ["期望职位"], ["工作经历"]);
  assert.equal(section?.header, "期望职位");
  assert.deepEqual(section?.body, ["Java开发", "后端开发"]);
});

test("valueAfterColon:中英文冒号均可", () => {
  assert.equal(valueAfterColon("期望职位:Java开发", "期望职位"), "Java开发");
  assert.equal(valueAfterColon("期望职位：Java开发", "期望职位"), "Java开发");
  assert.equal(valueAfterColon("期望职位", "期望职位"), null);
});

test("extractWantTitles:区块列表式 + 噪音过滤(标签/薪资行)", () => {
  const snap = snapOf([
    "张三",
    "期望职位",
    "Java开发",
    "后端开发",
    "期望薪资",
    "20-30K",
    "期望城市",
    "北京",
    "工作经历",
    "某某公司",
  ]);
  const result = extractWantTitles(snap);
  assert.equal(result.wantTitle, "Java开发、后端开发");
  assert.equal(result.header, "期望职位");
});

test("extractWantTitles:标题行内联取值", () => {
  const snap = snapOf(["期望职位:Java开发", "工作经历", "x"]);
  assert.equal(extractWantTitles(snap).wantTitle, "Java开发");
});

test("extractWantTitles:无期望区块返回空", () => {
  const snap = snapOf(["张三", "工作经历", "x"]);
  const result = extractWantTitles(snap);
  assert.equal(result.wantTitle, "");
  assert.equal(result.header, null);
});

test("queryParam/parseResumeIdFromUrl:仅直接参数可解析(不猜 backurl)", () => {
  assert.equal(parseResumeIdFromUrl("https://lpt.liepin.com/resume/detail?resIdEncode=abc123&sfrom=R"), "abc123");
  assert.equal(queryParam("https://lpt.liepin.com/login?backurl=%2Fresume%2Fdetail%3FresIdEncode%3Dx", "resIdEncode"), null);
  assert.equal(queryParam("not-a-url", "resIdEncode"), null);
});

test("字段模式:薪资/年限/学历", () => {
  assert.equal(matchSalary("薪资 20-40K·15薪"), "20-40K·15薪");
  assert.equal(matchSalary("30K"), "30K");
  assert.equal(matchExperience("经验 5-10年"), "5-10年");
  assert.equal(matchEducation("本科及以上"), "本科");
});

test("hasAttachmentHint:简历/附件卡片文案", () => {
  assert.equal(hasAttachmentHint(["你好", "张三的简历.pdf"]), true);
  assert.equal(hasAttachmentHint(["在线附件预览"]), true);
  assert.equal(hasAttachmentHint(["你好", "在吗"]), false);
});
