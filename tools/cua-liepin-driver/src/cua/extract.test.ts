import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collectLines,
  dedupeConsecutive,
  extractCandidateRecords,
  extractJobRecords,
  extractResumeNo,
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
import type { SnapshotRef, SnapshotResult } from "./session.js";

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

test("extractWantTitles:联调实测行序(职位→城市列表→薪资→右侧栏噪音)在取值行截断", () => {
  const snap = snapOf([
    "求职意向",
    "海外销售",
    "上海、杭州、苏州",
    "15-20k×14薪",
    "全部行业",
    "获取电话",
    "剩10次权益",
    "工作经历",
    "x",
  ]);
  const result = extractWantTitles(snap);
  assert.equal(result.header, "求职意向");
  assert.deepEqual(result.titles, ["海外销售"]);
  assert.equal(result.wantTitle, "海外销售");
});

test("extractWantTitles:多职位顿号行不被城市列表规则误伤", () => {
  const snap = snapOf(["期望职位", "Java开发、后端开发", "20-30K", "工作经历", "x"]);
  assert.equal(extractWantTitles(snap).wantTitle, "Java开发、后端开发");
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

test("extractResumeNo:预览层「简历编号」序列式与内联式", () => {
  const seq = snapOf(["邵女士", "简历编号", ":", "eb75dde295fdSc7f903cb4428", "请输入备注内容"]);
  const hit = extractResumeNo(seq);
  assert.equal(hit?.value, "eb75dde295fdSc7f903cb4428");
  assert.equal(hit?.ref, "p1:3");

  const inline = snapOf(["简历编号:eb75dde295fdSc7f903cb4428"]);
  assert.equal(extractResumeNo(inline)?.value, "eb75dde295fdSc7f903cb4428");
});

test("extractResumeNo:无编号/值非法时返回 null(宁缺毋滥)", () => {
  assert.equal(extractResumeNo(snapOf(["邵女士", "工作经历"])), null);
  // 值的形状不符(含中文)不采纳
  assert.equal(extractResumeNo(snapOf(["简历编号", ":", "未知编号"])), null);
});

test("字段模式:薪资/年限/学历", () => {
  assert.equal(matchSalary("薪资 20-40K·15薪"), "20-40K·15薪");
  assert.equal(matchSalary("30K"), "30K");
  assert.equal(matchSalary("15-20k×14薪"), "15-20k");
  assert.equal(matchExperience("经验 5-10年"), "5-10年");
  assert.equal(matchEducation("本科及以上"), "本科");
});

function snapRefs(refs: Array<Partial<SnapshotRef> & { name: string | null }>): SnapshotResult {
  return {
    snapshotId: "p1",
    outline: "",
    page: { title: "职位管理", url: "https://lpt.liepin.com/job/manager" },
    refs: refs.map((r, i) => ({
      ref: r.ref ?? `p1:${i}`,
      role: r.role ?? "statictext",
      name: r.name,
      actions: r.actions ?? [],
      visibility: r.visibility ?? "in_viewport",
    })),
  };
}

test("extractJobRecords:真机样本结构(职位名+地点/薪资/刷新/状态)且排除导航 link", () => {
  const snap = snapRefs([
    { name: "人才推荐", role: "link", actions: ["click"] },
    { name: "海外ToB渠道销售（出海品牌）", role: "link", actions: ["click"] },
    { name: "职位管理" },
    { name: "上海-黄浦区" },
    { name: "15-30k" },
    { name: "2026.09.29刷新" },
    { name: "沟通中" },
    { name: "待看/收到简历" },
  ]);
  const records = extractJobRecords(snap);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0], {
    title: "海外ToB渠道销售（出海品牌）",
    city: "上海-黄浦区",
    salary: "15-30k",
    refreshed_at: "2026.09.29刷新",
    status: "沟通中",
  });
});

test("extractJobRecords:多行边界不串行(字段归属各自职位)", () => {
  const snap = snapRefs([
    { name: "海外ToB渠道销售（出海品牌）", role: "link", actions: ["click"] },
    { name: "北京-朝阳区" },
    { name: "20-30k" },
    { name: "Java后端开发工程师", role: "link", actions: ["click"] },
    { name: "深圳-南山区" },
    { name: "25-35k" },
    { name: "2026.09.28刷新" },
    { name: "招聘中" },
  ]);
  const records = extractJobRecords(snap);
  assert.equal(records.length, 2);
  assert.equal(records[0].city, "北京-朝阳区");
  assert.equal(records[0].salary, "20-30k");
  assert.equal(records[0].status, null, "第二行的状态不得归入第一行");
  assert.equal(records[1].title, "Java后端开发工程师");
  assert.equal(records[1].city, "深圳-南山区");
  assert.equal(records[1].salary, "25-35k");
  assert.equal(records[1].status, "招聘中");
});

test("extractJobRecords:待发布行缺字段时置 null(不伪造)", () => {
  const snap = snapRefs([{ name: "销售经理", role: "link", actions: ["click"] }]);
  const records = extractJobRecords(snap);
  assert.deepEqual(records, [{ title: "销售经理", city: null, salary: null, refreshed_at: null, status: null }]);
});

test("extractCandidateRecords:真机样本结构(温女士卡片序列)", () => {
  const snap = snapRefs([
    { name: "温女士" },
    { name: "27岁" },
    { name: "3年" },
    { name: "本科" },
    { name: "济南" },
    { name: "期望：" },
    { name: "墨西哥" },
    { name: "海外销售" },
    { name: "15-20K" },
    { name: "机械/设备" },
  ]);
  const records = extractCandidateRecords(snap);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0], {
    name: "温女士",
    age: "27岁",
    experience: "3年",
    education: "本科",
    location: "济南",
    expect_city: "墨西哥",
    expect_position: "海外销售",
    expect_salary: "15-20K",
  });
});

test("extractCandidateRecords:多卡片边界与缺字段置 null", () => {
  const snap = snapRefs([
    { name: "温女士" },
    { name: "27岁" },
    { name: "3年" },
    { name: "本科" },
    { name: "济南" },
    { name: "期望：" },
    { name: "墨西哥" },
    { name: "海外销售" },
    { name: "15-20K" },
    { name: "陈先生" },
    { name: "33岁" },
    { name: "8年" },
    { name: "硕士" },
    { name: "上海" },
  ]);
  const records = extractCandidateRecords(snap);
  assert.equal(records.length, 2);
  assert.equal(records[0].expect_position, "海外销售");
  assert.equal(records[1].name, "陈先生");
  assert.equal(records[1].location, "上海");
  assert.equal(records[1].expect_city, null, "第二张卡片无期望区,不得串入第一张");
  assert.equal(records[1].expect_salary, null);
});

test("extractCandidateRecords:无姓名节点时返回空数组", () => {
  const snap = snapRefs([{ name: "人才推荐" }, { name: "27岁" }]);
  assert.deepEqual(extractCandidateRecords(snap), []);
});

test("hasAttachmentHint:简历/附件卡片文案", () => {
  assert.equal(hasAttachmentHint(["你好", "张三的简历.pdf"]), true);
  assert.equal(hasAttachmentHint(["在线附件预览"]), true);
  assert.equal(hasAttachmentHint(["你好", "在吗"]), false);
});
