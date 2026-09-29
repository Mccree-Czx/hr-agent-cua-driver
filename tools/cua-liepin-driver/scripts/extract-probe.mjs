/**
 * 抽取验证(联调校准工具):对已保存的页面快照 JSON 跑读类抽取,观察命中情况。
 * 用法: node scripts/extract-probe.mjs <snapshot.json>
 */

import { readFileSync } from "node:fs";
import { extractWantTitles, rawTextOf, textLinesOf } from "../dist/cua/extract.js";

const raw = JSON.parse(readFileSync(process.argv[2], "utf8"));
const snap = {
  snapshotId: raw.snapshotId ?? "probe",
  outline: "",
  page: raw.page ?? { title: "", url: "" },
  refs: raw.refs ?? [],
};

const want = extractWantTitles(snap);
console.log(`lines=${textLinesOf(snap).length}`);
console.log(`want_title=[${want.wantTitle}]`);
console.log(`header=${want.header}`);
console.log(`titles=${JSON.stringify(want.titles)}`);
console.log(`raw_text 前 400 字:\n${rawTextOf(snap).slice(0, 400)}`);
