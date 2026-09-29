/**
 * resume - 在线简历详情读取(UI 模式,W3)。
 *
 * 评分链路硬依赖:want_title(期望门禁);其余内容以 raw_text 供 AI 评分消费。
 * expectation_evidence 不在 UI 通道伪造(需 API 响应路径来源串,见抽取契约 §2.1)。
 */

import type { SnapshotResult } from "../cua/session.js";
import { extractWantTitles, rawTextOf, textLinesOf } from "../cua/extract.js";
import type { UiContext } from "../cua/ui-actions.js";
import { navigateChecked, resumeDetailUrl, waitResumePageReady } from "./common.js";

export interface ReadResumeInput {
  resumeId: string;
}

export interface ReadResumeOutcome {
  resume_id: string;
  source: "ui";
  want_title: string;
  name: string | null;
  text_lines: number;
  raw_text: string;
  extraction: {
    url: string;
    want_title_source: string | null;
    unvalidated: string[];
  };
}

/** 姓名启发式:首个短标题行(未验证,联调后校准;宁缺毋滥) */
export function guessName(snap: SnapshotResult): string | null {
  const heading = snap.refs.find(
    (r) => r.role === "heading" && r.name !== null && r.name.trim().length > 0 && r.name.trim().length <= 12,
  );
  return heading?.name?.trim() ?? null;
}

/** 读取在线简历详情(UI 抽取) */
export async function runReadResume(ctx: UiContext, input: ReadResumeInput): Promise<ReadResumeOutcome> {
  await navigateChecked(ctx, resumeDetailUrl(input.resumeId));
  const snap = await waitResumePageReady(ctx);

  const want = extractWantTitles(snap);
  ctx.log(`[简历] 文本行 ${textLinesOf(snap).length};期望职位=${want.wantTitle === "" ? "(未命中)" : want.wantTitle}`);

  return {
    resume_id: input.resumeId,
    source: "ui",
    want_title: want.wantTitle,
    name: guessName(snap),
    text_lines: textLinesOf(snap).length,
    raw_text: rawTextOf(snap),
    extraction: {
      url: snap.page.url,
      want_title_source: want.header,
      unvalidated: want.wantTitle === "" ? ["want_title"] : [],
    },
  };
}
