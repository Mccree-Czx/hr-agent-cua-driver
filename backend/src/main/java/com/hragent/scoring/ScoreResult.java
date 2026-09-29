package com.hragent.scoring;

import com.fasterxml.jackson.databind.JsonNode;

import java.util.ArrayList;
import java.util.List;

/**
 * 星级评分结果(2026-09-29 星级模型 v2):
 * star 1-5;veto_suspects=疑似命中一票否决点(待人工复核,不直接淘汰);
 * bonus_hits=命中加分点。字段级校验在 fromJson 中完成。
 */
public record ScoreResult(
        int star,
        String summary,
        List<String> reasons,
        List<VetoSuspect> vetoSuspects,
        List<String> bonusHits) {

    /** 疑似命中一票否决点(point=否决点原文,evidence=简历命中依据) */
    public record VetoSuspect(String point, String evidence) {
    }

    /** 打招呼线:≥该星级才主动沟通(与岗位 min_comm_star 默认值一致) */
    public static final int DEFAULT_COMM_STAR = 3;

    /**
     * 从模型输出 JSON 解析并校验(星级模型 v2)。
     * 非法结构/越界星级/缺失字段均抛出 IllegalArgumentException,由调用方决定重试或放弃。
     */
    public static ScoreResult fromJson(JsonNode node) {
        if (node == null || !node.isObject()) {
            throw new IllegalArgumentException("评分输出不是 JSON 对象");
        }
        JsonNode starNode = node.get("star");
        if (starNode == null || !starNode.isInt()) {
            throw new IllegalArgumentException("评分输出缺少合法 star 字段");
        }
        int star = starNode.asInt();
        if (star < 1 || star > 5) {
            throw new IllegalArgumentException("star 越界(应为 1-5): " + star);
        }
        String summary = node.has("summary") ? node.get("summary").asText("") : "";
        List<String> reasons = new ArrayList<>();
        if (node.has("reasons") && node.get("reasons").isArray()) {
            for (JsonNode r : node.get("reasons")) {
                reasons.add(r.asText(""));
            }
        }
        List<VetoSuspect> vetoSuspects = new ArrayList<>();
        if (node.has("veto_suspects") && node.get("veto_suspects").isArray()) {
            for (JsonNode v : node.get("veto_suspects")) {
                if (v.isTextual()) {
                    vetoSuspects.add(new VetoSuspect(v.asText(""), ""));
                } else if (v.isObject()) {
                    vetoSuspects.add(new VetoSuspect(
                            v.path("point").asText(""), v.path("evidence").asText("")));
                }
            }
        }
        List<String> bonusHits = new ArrayList<>();
        if (node.has("bonus_hits") && node.get("bonus_hits").isArray()) {
            for (JsonNode b : node.get("bonus_hits")) {
                bonusHits.add(b.asText(""));
            }
        }
        return new ScoreResult(star, summary, reasons, vetoSuspects, bonusHits);
    }

    /**
     * 星级对应的台账动作状态(2026-09-29 动作矩阵):
     * 疑似否决且星级达标 → HOLD(挂起待人工复核);≥3 星 → PASS;2 星 → KEPT(留库不打扰);1 星 → FAIL(淘汰)。
     */
    public String actionStatus() {
        if (!vetoSuspects.isEmpty() && star >= DEFAULT_COMM_STAR) {
            return "HOLD";
        }
        if (star >= DEFAULT_COMM_STAR) {
            return "PASS";
        }
        return star == 2 ? "KEPT" : "FAIL";
    }
}
