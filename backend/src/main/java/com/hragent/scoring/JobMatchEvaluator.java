package com.hragent.scoring;

import com.fasterxml.jackson.databind.JsonNode;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 期望职能三态判定(设计 4.2):MATCH / MISMATCH / UNKNOWN。
 * 口径(历史沿革自猎聘简历期望字段的 matchJobExpectations,现已内置本模块):
 * - 仅用「明确同义映射」判定,不按"工程师"、行业或关键词包含关系泛化;
 * - 多个期望任一与目标同职能即 MATCH;
 * - 明确分类证据冲突/缺失、期望缺失或格式异常 → UNKNOWN;
 * - 绝不用候选人当前职位充当期望。
 *
 * fail-closed 语义:只有 MATCH 允许继续评分;UNKNOWN 绝不判为通过;MISMATCH 直接排除。
 */
public final class JobMatchEvaluator {

    public enum Status {
        MATCH, MISMATCH, UNKNOWN
    }

    public record Result(Status status, String reason) {

        /** 仅 MATCH 允许继续进入 AI 评分 */
        public boolean canContinueScoring() {
            return status == Status.MATCH;
        }
    }

    private static final String EXPECTATION_SOURCE = "resumeDetailVo.jobWant.jobTitleNames";

    /** 明确支持的职能族(与 CLI 一致) */
    private static final Set<String> KNOWN_FAMILIES =
            Set.of("hardware", "hr", "software", "ecommerce-ops", "sales", "structure", "design");

    /** 明确同义映射,与 CLI TITLE_FAMILIES 完全一致;不泛化 */
    private static final Map<String, String> TITLE_FAMILIES = Map.ofEntries(
            Map.entry("硬件工程师", "hardware"),
            Map.entry("硬件研发工程师", "hardware"),
            Map.entry("高级硬件工程师", "hardware"),
            Map.entry("高级硬件研发工程师", "hardware"),
            Map.entry("人力资源总监", "hr"),
            Map.entry("HR总监", "hr"),
            Map.entry("招聘经理", "hr"),
            Map.entry("软件工程师", "software"),
            // 2026-09-28 晚职能映射扩展(解锁岗位 7-10,按真实期望分布覆盖头部;边界项不收保持 UNKNOWN)
            Map.entry("资深亚马逊运营", "ecommerce-ops"),
            Map.entry("跨境电商运营", "ecommerce-ops"),
            Map.entry("电商运营", "ecommerce-ops"),
            Map.entry("运营经理/主管", "ecommerce-ops"),
            Map.entry("运营专员", "ecommerce-ops"),
            Map.entry("商家运营", "ecommerce-ops"),
            Map.entry("品类运营", "ecommerce-ops"),
            Map.entry("海外运营", "ecommerce-ops"),
            Map.entry("海外ToB渠道销售（出海品牌）", "sales"),
            Map.entry("渠道经理", "sales"),
            Map.entry("海外销售", "sales"),
            Map.entry("大客户销售", "sales"),
            Map.entry("销售经理/主管", "sales"),
            Map.entry("销售代表", "sales"),
            Map.entry("外贸经理/主管", "sales"),
            Map.entry("外贸专员/助理", "sales"),
            Map.entry("区域销售经理/主管", "sales"),
            Map.entry("销售总监", "sales"),
            Map.entry("销售运营", "sales"),
            Map.entry("高级结构工程师", "structure"),
            Map.entry("机械结构工程师", "structure"),
            Map.entry("家电/3C结构工程师", "structure"),
            Map.entry("结构工程师", "structure"),
            Map.entry("资深工业设计师", "design"),
            Map.entry("工业/产品设计", "design"),
            Map.entry("设计经理/主管", "design"),
            Map.entry("设计总监", "design"),
            Map.entry("汽车造型设计", "design"),
            Map.entry("工业设计", "design"),
            Map.entry("产品设计", "design"));

    private JobMatchEvaluator() {
    }

    /** 无人工分类证据的判定(仅用明确同义映射) */
    public static Result evaluate(List<String> expectations, String targetJobTitle) {
        return evaluate(expectations, Map.of(), targetJobTitle);
    }

    /**
     * 三态职能判定。
     *
     * @param expectations           期望职能标题(来源 candidate.snapshot 的期望字段,绝不用当前职位代替)
     * @param classificationEvidence 已核实并归一化、且可追溯的分类证据:职位标题 → 职能族(hardware/hr/software);
     *                               为空表示无人工证据,仅用明确同义映射;含未知族或与明确映射冲突 → UNKNOWN。
     *                               调用方只应放入自带追溯来源(categorySource)的证据
     * @param targetJobTitle         目标岗位名称
     */
    public static Result evaluate(List<String> expectations, Map<String, String> classificationEvidence,
                                  String targetJobTitle) {
        return evaluate(expectations, classificationEvidence, Set.of(), targetJobTitle);
    }

    /**
     * 三态职能判定(可标记不可采信的分类证据)。
     *
     * @param untraceableCategories 携带 reviewedFamily 但缺少 categorySource 追溯字段的标题集合;
     *                              这类分类证据不可采信,按冲突处理 → UNKNOWN(与 CLI 同口径)
     */
    static Result evaluate(List<String> expectations, Map<String, String> classificationEvidence,
                           Set<String> untraceableCategories, String targetJobTitle) {
        if (expectations == null || expectations.isEmpty()) {
            return unknown("缺少可靠的求职期望或字段格式异常");
        }
        Set<String> untraceable = untraceableCategories == null ? Set.of() : untraceableCategories;
        Classification wanted = classify(targetJobTitle, familyOf(classificationEvidence, targetJobTitle),
                untraceable.contains(key(targetJobTitle)));
        List<Classification> entries = new ArrayList<>();
        for (String title : expectations) {
            entries.add(classify(title, familyOf(classificationEvidence, title), untraceable.contains(key(title))));
        }
        if (wanted.conflict() || entries.stream().anyMatch(Classification::conflict)) {
            return unknown("职能分类证据缺失或与明确职位映射冲突");
        }
        if (wanted.family() == null) {
            return unknown("目标岗位职能尚无可靠映射");
        }
        if (entries.stream().anyMatch(e -> wanted.family().equals(e.family()))) {
            return new Result(Status.MATCH, "至少一个明确期望方向同职能；级别、管理职责及岗位门槛仍需评分");
        }
        if (entries.stream().anyMatch(e -> e.family() == null)) {
            return unknown("存在无法确定职能的期望方向");
        }
        return new Result(Status.MISMATCH, "所有明确期望方向均与目标岗位不同职能");
    }

    /** 从候选人快照提取期望并判定;缺期望/字段异常 → UNKNOWN */
    public static Result evaluateFromSnapshot(JsonNode snapshot, String targetJobTitle) {
        Evidence evidence = extractEvidence(snapshot);
        if (evidence.malformed()) {
            return unknown("缺少可靠的求职期望或字段格式异常");
        }
        return evaluate(evidence.titles(), evidence.reviewedFamilies(),
                evidence.untraceableCategories(), targetJobTitle);
    }

    /** 从候选人快照提取期望职能标题(仅取期望字段,绝不回退当前职位) */
    public static List<String> extractExpectations(JsonNode snapshot) {
        return extractEvidence(snapshot).titles();
    }

    record Evidence(List<String> titles, Map<String, String> reviewedFamilies,
                    Set<String> untraceableCategories, boolean malformed) {
    }

    static Evidence extractEvidence(JsonNode snapshot) {
        List<String> titles = new ArrayList<>();
        Map<String, String> reviewedFamilies = new LinkedHashMap<>();
        Set<String> untraceableCategories = new HashSet<>();
        boolean malformed = false;
        if (snapshot != null) {
            JsonNode evidence = snapshot.get("expectation_evidence");
            if (evidence != null && evidence.isObject()) {
                JsonNode source = evidence.get("source");
                if (source == null || !source.isTextual() || !EXPECTATION_SOURCE.equals(source.asText().trim())) {
                    // 来源缺失/非文本/不可信 → 视为字段异常,拒绝匹配(与 CLI 同口径)
                    return new Evidence(List.of(), Map.of(), Set.of(), true);
                }
                if (evidence.path("malformed").asBoolean(false)) {
                    malformed = true;
                }
                JsonNode entries = evidence.get("entries");
                if (entries != null) {
                    if (!entries.isArray()) {
                        malformed = true;
                    } else {
                        for (JsonNode entry : entries) {
                            JsonNode titleNode = entry.path("title");
                            if (!titleNode.isTextual() || titleNode.asText().isBlank()) {
                                malformed = true;
                                continue;
                            }
                            String title = titleNode.asText().trim();
                            titles.add(title);
                            JsonNode family = entry.get("reviewedFamily");
                            if (family != null && family.isTextual() && !family.asText().isBlank()) {
                                if (hasTraceableCategorySource(entry)) {
                                    reviewedFamilies.put(title, family.asText().trim());
                                } else {
                                    // 携带 reviewedFamily 但无 categorySource 追溯字段 → 分类证据不可采信
                                    untraceableCategories.add(title);
                                }
                            }
                        }
                    }
                }
            }
            if (titles.isEmpty() && !malformed) {
                // 回退:扁平期望字段 want_title(由 resume 详情命令展开)
                JsonNode wantTitle = snapshot.path("want_title");
                if (wantTitle.isTextual() && !wantTitle.asText().isBlank()) {
                    for (String part : wantTitle.asText().split("[、,，/]")) {
                        String t = part.trim();
                        if (!t.isBlank()) {
                            titles.add(t);
                        }
                    }
                }
            }
        }
        return new Evidence(titles, reviewedFamilies, untraceableCategories, malformed);
    }

    /** 分类证据须自带 categorySource 追溯字段方可采信(与 CLI 同口径) */
    private static boolean hasTraceableCategorySource(JsonNode entry) {
        JsonNode categorySource = entry.get("categorySource");
        return categorySource != null && categorySource.isTextual() && !categorySource.asText().isBlank();
    }

    private static String familyOf(Map<String, String> evidence, String title) {
        if (evidence == null) {
            return null;
        }
        return evidence.get(key(title));
    }

    private static String key(String title) {
        return title == null ? "" : title.trim();
    }

    private static Classification classify(String title, String reviewedFamily, boolean untraceable) {
        String alias = TITLE_FAMILIES.get(key(title));
        boolean verified = reviewedFamily != null && !reviewedFamily.isBlank();
        if (untraceable || (verified && !KNOWN_FAMILIES.contains(reviewedFamily))) {
            // 分类证据不可采信(缺追溯字段/族不在已知集合) → 冲突
            return new Classification(null, true);
        }
        String family = verified ? reviewedFamily : alias;
        boolean conflict = verified && alias != null && !reviewedFamily.equals(alias);
        return new Classification(family, conflict);
    }

    private static Result unknown(String reason) {
        return new Result(Status.UNKNOWN, reason);
    }

    private record Classification(String family, boolean conflict) {
    }
}
