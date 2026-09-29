package com.hragent.scoring;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 期望职能三态判定纯函数测试(与 CLI resume.ts 的用例集对齐,证明口径一致):
 * MATCH / MISMATCH / UNKNOWN,且 UNKNOWN/MISMATCH 一律 canContinueScoring=false。
 */
class JobMatchEvaluatorTest {

    private final ObjectMapper objectMapper = new ObjectMapper();

    private JobMatchEvaluator.Status status(List<String> expectations, String target) {
        return JobMatchEvaluator.evaluate(expectations, target).status();
    }

    @Test
    void higherHardwareMatchesHardwareTarget() {
        assertEquals(JobMatchEvaluator.Status.MATCH, status(List.of("高级硬件工程师"), "硬件研发工程师"));
    }

    @Test
    void hrExpectationMismatchesHardwareTarget() {
        assertEquals(JobMatchEvaluator.Status.MISMATCH, status(List.of("人力资源总监"), "硬件工程师"));
    }

    @Test
    void multipleExpectationsAnyMatchPasses() {
        assertEquals(JobMatchEvaluator.Status.MATCH,
                status(List.of("人力资源总监", "高级硬件工程师"), "硬件研发工程师"));
    }

    @Test
    void multipleExplicitExpectationsAllMismatch() {
        assertEquals(JobMatchEvaluator.Status.MISMATCH,
                status(List.of("人力资源总监", "招聘经理"), "硬件工程师"));
    }

    @Test
    void unmappedEngineerNotGeneralized() {
        assertEquals(JobMatchEvaluator.Status.UNKNOWN, status(List.of("工程师"), "硬件工程师"));
    }

    @Test
    void softwareExpectationMismatchesHardwareTarget() {
        assertEquals(JobMatchEvaluator.Status.MISMATCH, status(List.of("软件工程师"), "硬件工程师"));
    }

    @Test
    void unknownDirectionCannotAssertAllMismatch() {
        assertEquals(JobMatchEvaluator.Status.UNKNOWN,
                status(List.of("招聘经理", "未映射方向"), "硬件工程师"));
    }

    @Test
    void emptyOrMissingExpectationsAreUnknown() {
        assertEquals(JobMatchEvaluator.Status.UNKNOWN, status(List.of(), "硬件工程师"));
        assertEquals(JobMatchEvaluator.Status.UNKNOWN, status(null, "硬件工程师"));
    }

    @Test
    void emptyOrUnmappedTargetIsUnknown() {
        assertEquals(JobMatchEvaluator.Status.UNKNOWN, status(List.of("高级硬件工程师"), ""));
        assertEquals(JobMatchEvaluator.Status.UNKNOWN, status(List.of("高级硬件工程师"), "产品经理"));
    }

    @Test
    void classificationEvidenceConflictIsUnknown() {
        // 已核实分类与明确职位映射冲突 → UNKNOWN(不能被另一个匹配覆盖)
        assertEquals(JobMatchEvaluator.Status.UNKNOWN,
                JobMatchEvaluator.evaluate(List.of("高级硬件工程师"), Map.of("高级硬件工程师", "hr"), "硬件工程师").status());
        assertEquals(JobMatchEvaluator.Status.UNKNOWN,
                JobMatchEvaluator.evaluate(List.of("硬件工程师"), Map.of("硬件工程师", "hr"), "硬件工程师").status());
    }

    @Test
    void onlyMatchAllowsContinueScoring() {
        assertTrue(JobMatchEvaluator.evaluate(List.of("高级硬件工程师"), "硬件研发工程师").canContinueScoring());
        assertFalse(JobMatchEvaluator.evaluate(List.of("人力资源总监"), "硬件工程师").canContinueScoring());
        assertFalse(JobMatchEvaluator.evaluate(List.of("工程师"), "硬件工程师").canContinueScoring());
    }

    @Test
    void snapshotWantTitleDrivesMatch() throws Exception {
        var snapshot = objectMapper.readTree(
                "{\"title\":\"硬件工程师\",\"current_title\":\"硬件工程师\",\"want_title\":\"高级硬件工程师\"}");
        assertEquals(JobMatchEvaluator.Status.MATCH,
                JobMatchEvaluator.evaluateFromSnapshot(snapshot, "硬件研发工程师").status());
    }

    @Test
    void snapshotCurrentTitleNeverSubstitutesExpectation() throws Exception {
        var snapshot = objectMapper.readTree("{\"title\":\"硬件工程师\",\"current_title\":\"硬件工程师\"}");
        assertEquals(JobMatchEvaluator.Status.UNKNOWN,
                JobMatchEvaluator.evaluateFromSnapshot(snapshot, "硬件工程师").status());
    }

    @Test
    void snapshotMalformedExpectationsAreUnknown() throws Exception {
        var notArray = objectMapper.readTree("{\"expectation_evidence\":{\"entries\":\"高级硬件工程师\"}}");
        assertEquals(JobMatchEvaluator.Status.UNKNOWN,
                JobMatchEvaluator.evaluateFromSnapshot(notArray, "硬件工程师").status());

        var brokenEntry = objectMapper.readTree("{\"expectation_evidence\":{\"entries\":[{\"title\":42}]}}");
        assertEquals(JobMatchEvaluator.Status.UNKNOWN,
                JobMatchEvaluator.evaluateFromSnapshot(brokenEntry, "硬件工程师").status());
    }

    @Test
    void snapshotWrongEvidenceSourceIsUnknown() throws Exception {
        var snapshot = objectMapper.readTree(
                "{\"expectation_evidence\":{\"source\":\"baseInfo.title\",\"entries\":[{\"title\":\"高级硬件工程师\"}]}}");
        assertEquals(JobMatchEvaluator.Status.UNKNOWN,
                JobMatchEvaluator.evaluateFromSnapshot(snapshot, "硬件研发工程师").status());
    }

    /** 评审 Important-3:来源缺失/非文本不得当作可信证据(与 CLI 同口径) */
    @Test
    void snapshotMissingEvidenceSourceIsUnknown() throws Exception {
        var snapshot = objectMapper.readTree(
                "{\"expectation_evidence\":{\"entries\":[{\"title\":\"高级硬件工程师\"}]}}");
        assertEquals(JobMatchEvaluator.Status.UNKNOWN,
                JobMatchEvaluator.evaluateFromSnapshot(snapshot, "硬件研发工程师").status());

        var nonTextual = objectMapper.readTree(
                "{\"expectation_evidence\":{\"source\":42,\"entries\":[{\"title\":\"高级硬件工程师\"}]}}");
        assertEquals(JobMatchEvaluator.Status.UNKNOWN,
                JobMatchEvaluator.evaluateFromSnapshot(nonTextual, "硬件研发工程师").status());
    }

    /** 评审 Important-3:携带 reviewedFamily 但无 categorySource 追溯字段 → 不可采信 → UNKNOWN */
    @Test
    void snapshotReviewedFamilyWithoutCategorySourceIsUnknown() throws Exception {
        var snapshot = objectMapper.readTree(
                "{\"expectation_evidence\":{\"source\":\"resumeDetailVo.jobWant.jobTitleNames\","
                        + "\"entries\":[{\"title\":\"高级硬件工程师\",\"reviewedFamily\":\"hardware\"}]}}");
        assertEquals(JobMatchEvaluator.Status.UNKNOWN,
                JobMatchEvaluator.evaluateFromSnapshot(snapshot, "硬件研发工程师").status());
    }

    /** 自带 categorySource 追溯字段的分类证据仍可参与匹配(未被本次收紧误伤) */
    @Test
    void snapshotTraceableReviewedFamilyStillMatches() throws Exception {
        var snapshot = objectMapper.readTree(
                "{\"expectation_evidence\":{\"source\":\"resumeDetailVo.jobWant.jobTitleNames\","
                        + "\"entries\":[{\"title\":\"未映射职位\",\"reviewedFamily\":\"hardware\","
                        + "\"categorySource\":\"mock-reviewed-taxonomy\"}]}}");
        assertEquals(JobMatchEvaluator.Status.MATCH,
                JobMatchEvaluator.evaluateFromSnapshot(snapshot, "硬件工程师").status());
    }

    // ---------- 职能映射扩展(2026-09-28 晚,解锁岗位 7-10) ----------

    @Test
    void ecommerceOpsFamilyMatchesAmazonOperatorTarget() {
        assertEquals(JobMatchEvaluator.Status.MATCH, status(List.of("跨境电商运营"), "资深亚马逊运营"));
        assertEquals(JobMatchEvaluator.Status.MATCH, status(List.of("电商运营"), "资深亚马逊运营"));
    }

    @Test
    void salesFamilyMatchesOverseasChannelSalesTarget() {
        assertEquals(JobMatchEvaluator.Status.MATCH, status(List.of("渠道经理"), "海外ToB渠道销售（出海品牌）"));
        assertEquals(JobMatchEvaluator.Status.MATCH, status(List.of("海外销售"), "海外ToB渠道销售（出海品牌）"));
    }

    @Test
    void structureFamilyMatchesSeniorStructureEngineerTarget() {
        assertEquals(JobMatchEvaluator.Status.MATCH, status(List.of("机械结构工程师"), "高级结构工程师"));
        assertEquals(JobMatchEvaluator.Status.MATCH, status(List.of("家电/3C结构工程师"), "高级结构工程师"));
    }

    @Test
    void designFamilyMatchesIndustrialDesignerTarget() {
        assertEquals(JobMatchEvaluator.Status.MATCH, status(List.of("工业/产品设计"), "资深工业设计师"));
        assertEquals(JobMatchEvaluator.Status.MATCH, status(List.of("汽车造型设计"), "资深工业设计师"));
    }

    @Test
    void newFamiliesCrossMismatch() {
        assertEquals(JobMatchEvaluator.Status.MISMATCH, status(List.of("跨境电商运营"), "高级结构工程师"));
        assertEquals(JobMatchEvaluator.Status.MISMATCH,
                status(List.of("工业/产品设计"), "海外ToB渠道销售（出海品牌）"));
        assertEquals(JobMatchEvaluator.Status.MISMATCH, status(List.of("跨境电商运营"), "硬件工程师"));
    }

    @Test
    void borderlineTitlesRemainUnknown() {
        assertEquals(JobMatchEvaluator.Status.UNKNOWN, status(List.of("机械工程师"), "高级结构工程师"));
        assertEquals(JobMatchEvaluator.Status.UNKNOWN, status(List.of("产品经理"), "资深工业设计师"));
        assertEquals(JobMatchEvaluator.Status.UNKNOWN, status(List.of("媒介投放"), "资深亚马逊运营"));
    }
}
