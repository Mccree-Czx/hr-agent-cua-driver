/**
 * 读类抽取框架(W3):从语义快照中提取文本行、区块与结构化字段。
 *
 * 设计原则(见 docs/superpowers/specs/2026-09-29-ui-extraction-contract.md):
 * - 快照 refs 是扁平列表(DOM 顺序),区块抽取基于"标题行 + 后继行直到下一标题"启发式;
 * - 字段抽取优先可验证的模式(期望职位/薪资/年限等固定文案),不确定的字段宁缺毋滥;
 * - 所有函数为纯函数,便于用快照 fixture 单测。
 */

import type { SnapshotRef, SnapshotResult } from "./session.js";

/** 一行文本(ref 与角色保留,便于诊断与后续动作定位) */
export interface TextLine {
  ref: string;
  role: string;
  text: string;
}

/** 收集非空文本行(DOM 顺序;角色无关) */
export function collectLines(snap: SnapshotResult): TextLine[] {
  return snap.refs
    .filter((r) => r.name !== null && r.name.trim() !== "")
    .map((r) => ({ ref: r.ref, role: r.role, text: (r.name as string).trim() }));
}

/** 折叠连续重复行(同一文案的 statictext 常出现多次) */
export function dedupeConsecutive(lines: TextLine[]): TextLine[] {
  const out: TextLine[] = [];
  for (const line of lines) {
    if (out.length === 0 || out[out.length - 1].text !== line.text) {
      out.push(line);
    }
  }
  return out;
}

/** 全部文本(去连续重复,换行连接)——评分提示词消费的主载荷 */
export function rawTextOf(snap: SnapshotResult): string {
  return dedupeConsecutive(collectLines(snap))
    .map((l) => l.text)
    .join("\n");
}

/** 文本行数组(去连续重复) */
export function textLinesOf(snap: SnapshotResult): string[] {
  return dedupeConsecutive(collectLines(snap)).map((l) => l.text);
}

/** 首个匹配行的文案(可限定起始下标) */
export function findFirst(
  lines: string[],
  pattern: RegExp,
  from = 0,
): { index: number; text: string } | null {
  for (let i = from; i < lines.length; i++) {
    if (pattern.test(lines[i])) {
      return { index: i, text: lines[i] };
    }
  }
  return null;
}

/**
 * 区块抽取:定位标题行(包含任一 header 候选)后,收集后继行直到遇到任一 stop 标题
 * 或达到 maxLines。返回 { header, headerIndex, body }。
 */
export function sectionAfter(
  lines: string[],
  headers: string[],
  stops: string[],
  maxLines = 12,
): { header: string; headerIndex: number; body: string[] } | null {
  const stopRe = stops.length > 0 ? new RegExp(stops.join("|")) : null;
  for (let i = 0; i < lines.length; i++) {
    const header = headers.find((h) => lines[i].includes(h));
    if (header === undefined) {
      continue;
    }
    const body: string[] = [];
    for (let j = i + 1; j < lines.length && body.length < maxLines; j++) {
      if (stopRe !== null && stopRe.test(lines[j])) {
        break;
      }
      body.push(lines[j]);
    }
    return { header, headerIndex: i, body };
  }
  return null;
}

/** 行内形如 "期望职位:Java开发"(冒号后直接取值)的提取 */
export function valueAfterColon(text: string, label: string): string | null {
  const re = new RegExp(`${label}\\s*[:：]\\s*(.+)$`);
  const m = re.exec(text);
  return m !== null && m[1].trim() !== "" ? m[1].trim() : null;
}

/** 简历页区块标题(用于区块边界) */
export const RESUME_SECTION_HEADERS = [
  "基本信息", "期望职位", "求职意向", "期望岗位", "期望职业", "工作经历", "工作经验",
  "项目经历", "教育经历", "教育背景", "专业技能", "技能特长", "自我评价", "个人优势",
  "证书奖项", "语言能力", "联系方式",
];

/** 期望职位区块的行级噪音(标签/辅助信息,不视为职位名) */
const WANT_TITLE_NOISE = /^(期望薪资|期望城市|期望行业|期望地点|期望地区|到岗时间|工作性质|求职类型|薪资|城市|行业|地点|全职|兼职|随时到岗|面议|全部行业)/;

/** 标签式行(值可能在下一行,如 "期望城市" + "北京"):跳过标签行与其取值行 */
const WANT_TITLE_LABEL = /^(期望薪资|期望城市|期望行业|期望地点|期望地区|到岗时间|工作性质|求职类型)\s*$/;

/**
 * 取值行(职位名之后的非职位字段):出现即停止收集。
 * 联调实测(2026-09-29):求职意向区块实际行序为[职位名, 城市列表, 薪资, 行业...],
 * 且右侧动作栏文案会混入后继行;因此遇到数值/薪资/纯城市列表行立即截断。
 */
function isValueStopLine(stripped: string): boolean {
  if (/^\d/.test(stripped)) {
    return true;
  }
  if (matchSalary(stripped) !== null) {
    return true;
  }
  // 纯城市列表:如 "上海、杭州、苏州"(每段 2-3 字,无其它内容)
  return /^(?:[\u4e00-\u9fa5]{2,3}[、·])+[\u4e00-\u9fa5]{2,3}$/.test(stripped);
}

export interface WantTitleResult {
  /** 拼接后的期望职位(顿号分隔);无则空串 */
  wantTitle: string;
  /** 命中的区块标题(诊断/校准用) */
  header: string | null;
  titles: string[];
}

/**
 * 抽取期望职位:定位"期望职位/求职意向"区块并过滤标签噪音行;
 * 同时支持标题行自带取值("期望职位:Java开发")。
 */
export function extractWantTitles(snap: SnapshotResult): WantTitleResult {
  const lines = textLinesOf(snap);
  const section = sectionAfter(
    lines,
    ["期望职位", "求职意向", "期望岗位", "期望从事职业", "期望职业"],
    RESUME_SECTION_HEADERS.filter((h) => !["期望职位", "求职意向", "期望岗位", "期望从事职业", "期望职业"].includes(h)),
    8,
  );
  if (section === null) {
    return { wantTitle: "", header: null, titles: [] };
  }
  const inline = valueAfterColon(lines[section.headerIndex], section.header);
  const raw = inline !== null ? [inline, ...section.body] : section.body;

  const titles: string[] = [];
  let skipNextAsValue = false; // 上一行为标签行 → 本行视为其取值,跳过
  for (const line of raw) {
    if (skipNextAsValue) {
      skipNextAsValue = false;
      continue;
    }
    // 清理 "职位:xxx" / "期望职位:xxx" 前缀后判断
    const stripped = line.replace(/^[^:：]{0,8}[:：]\s*/, "").trim();
    if (stripped === "") {
      continue;
    }
    // 裸标签行(如 "期望城市"/"期望薪资"):行内无取值则跳过下一行的取值
    if (WANT_TITLE_LABEL.test(stripped)) {
      skipNextAsValue = true;
      continue;
    }
    // 取值行(数值/薪资/纯城市列表)→ 职位名收集到此为止
    if (isValueStopLine(stripped)) {
      break;
    }
    if (WANT_TITLE_NOISE.test(stripped)) {
      continue;
    }
    // 过长的行大概率是整段描述而非职位名,截断保护
    titles.push(stripped.slice(0, 40));
  }
  return {
    wantTitle: Array.from(new Set(titles)).join("、"),
    header: section.header,
    titles,
  };
}

/** URL 查询参数解析(resIdEncode 等;不做 decode 混淆,取原始值) */
export function queryParam(url: string, key: string): string | null {
  try {
    const parsed = new URL(url);
    const value = parsed.searchParams.get(key);
    return value !== null && value !== "" ? value : null;
  } catch {
    return null;
  }
}

/** 从详情页 URL 解析 resume_id(公式:resume/detail?resIdEncode=...,已验证) */
export function parseResumeIdFromUrl(url: string): string | null {
  return queryParam(url, "resIdEncode");
}

/** 「简历编号」值命中(值 + 所在 ref,ref 供诊断) */
export interface ResumeNoHit {
  value: string;
  ref: string;
}

/**
 * 抽取「简历编号」值(resIdEncode 的 UI 获取路径;联调验证 2026-09-29,
 * 实测值 eb75dde295fdSc7f903cb4428 导航 resume/detail 打开目标候选人简历)。
 *
 * 预览层(#preview)中为 statictext 序列:[简历编号] [冒号] [<值>];
 * 也兼容同节点形如 "简历编号:xxx" 的写法。值限定为字母数字串。
 */
export function extractResumeNo(snap: SnapshotResult): ResumeNoHit | null {
  const refs = snap.refs;
  for (let i = 0; i < refs.length; i++) {
    const r = refs[i];
    if (r.name === null) {
      continue;
    }
    const inline = /^简历编号\s*[:：]\s*([A-Za-z0-9]{8,64})$/.exec(r.name);
    if (inline !== null) {
      return { value: inline[1], ref: r.ref };
    }
    if (!/^简历编号\s*[:：]?$/.test(r.name)) {
      continue;
    }
    for (let j = i + 1; j < Math.min(i + 6, refs.length); j++) {
      const v = refs[j];
      if (v.role === "statictext" && v.name !== null && /^[A-Za-z0-9]{8,64}$/.test(v.name)) {
        return { value: v.name, ref: v.ref };
      }
    }
  }
  return null;
}

/** 薪资模式:"20-40K" / "30-50K·15薪" / "25K" (取首段原文) */
export function matchSalary(text: string): string | null {
  const m = /(\d{1,3}\s*-\s*\d{1,3}\s*[Kk]|[1-9]\d{1,2}\s*[Kk])[·\s]?\d{0,2}薪?/.exec(text);
  return m !== null ? m[0].replace(/\s+/g, "") : null;
}

/** 工作年限模式:"5年" / "5-10年" / "10年以上" */
export function matchExperience(text: string): string | null {
  const m = /(\d{1,2}\s*-\s*\d{1,2}\s*年|\d{1,2}\s*年以上|[1-9]\d?\s*年经验)/.exec(text);
  return m !== null ? m[0].replace(/\s+/g, "") : null;
}

/** 学历模式 */
export function matchEducation(text: string): string | null {
  const m = /(博士|硕士|MBA|本科|大专|专科|高中|中专)/.exec(text);
  return m !== null ? m[1] : null;
}

/** 附件卡片文案迹象(chatmsg 附件检测;旧 API 路线需解 bizType=7 载荷,UI 更直观) */
export function hasAttachmentHint(lines: string[]): boolean {
  return lines.some((l) => /简历|附件/.test(l) && /\.(pdf|docx?|doc)|附件|简历/.test(l));
}

/** 职位行与字段抽取(joblist 结构化 records;2026-09-29 真机样本推导) */

/** 职位行 link 排除名单(导航/分页/入口按钮等非职位行) */
export const JOB_ROW_EXCLUDE = [
  "人才推荐", "职位管理", "搜索人才", "沟通", "人才管理",
  "猎头服务", "提效服务", "问 Lily", "意向人选", "急聘置顶", "火爆刷",
];

/** 单条职位记录(UI 抽取契约:v1 不含 jobId——列表行文本层无法获得,
 *  id 由点击穿透(captureIdsByClickThrough)补充) */
export interface JobRecord {
  name: string;
  location: string | null;
  salary: string | null;
  refreshed_at: string | null;
  status: string | null;
}

/** 是否职位行 link(与 jobdelete 的行识别语义一致) */
function isJobRow(ref: SnapshotRef): boolean {
  return (
    ref.role === "link" &&
    ref.name !== null &&
    ref.name.length >= 4 &&
    ref.name.length <= 40 &&
    (ref.visibility === "in_viewport" || ref.visibility === "near_viewport") &&
    !JOB_ROW_EXCLUDE.some((n) => (ref.name as string).includes(n)) &&
    !/^\d+\s*\/\s*\d+$/.test(ref.name)
  );
}

/** 定位职位行 link 的索引(DOM 序,用于 records 行边界划分) */
export function jobRowIndexes(refs: SnapshotRef[]): number[] {
  const out: number[] = [];
  refs.forEach((r, i) => {
    if (isJobRow(r)) {
      out.push(i);
    }
  });
  return out;
}

/**
 * 抽取职位记录列表。
 * 真机样本(2026-09-29)单行结构:职位名(link) … 地点("上海-黄浦区") →
 * 薪资("15-30k") → 刷新时间("2026.09.29刷新") → 状态("沟通中");
 * 行边界 = 下一个职位行 link 索引(无则向后最多 60 节点);
 * 字段在区间内各取首个匹配,缺失为 null(不伪造)。
 */
export function extractJobRecords(snap: SnapshotResult): JobRecord[] {
  const refs = snap.refs;
  const idxs = jobRowIndexes(refs);
  const records: JobRecord[] = [];
  for (let k = 0; k < idxs.length; k++) {
    const start = idxs[k];
    const end = k + 1 < idxs.length ? idxs[k + 1] : Math.min(refs.length, start + 60);
    const record: JobRecord = {
      name: refs[start].name as string,
      location: null,
      salary: null,
      refreshed_at: null,
      status: null,
    };
    for (let i = start + 1; i < end; i++) {
      const name = refs[i].name;
      if (name === null) {
        continue;
      }
      const text = name.trim();
      if (record.location === null && /^[\u4e00-\u9fa5]{2,10}-[\u4e00-\u9fa5]{2,10}$/.test(text)) {
        record.location = text;
      } else if (record.salary === null && matchSalary(text) !== null) {
        record.salary = matchSalary(text);
      } else if (record.refreshed_at === null && /\d{4}\.\d{2}\.\d{2}\s*刷新$/.test(text)) {
        record.refreshed_at = text;
      } else if (record.status === null && /^(沟通中|已下线|招聘中|待审核|审核中|已结束|已关闭)$/.test(text)) {
        record.status = text;
      }
    }
    records.push(record);
  }
  return records;
}
