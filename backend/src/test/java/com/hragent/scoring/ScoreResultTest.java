package com.hragent.scoring;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 星级评分结果解析与动作矩阵(2026-09-29 星级模型 v2)。
 */
class ScoreResultTest {

    private final ObjectMapper objectMapper = new ObjectMapper();

    @Test
    void parseValidJson() throws Exception {
        var node = objectMapper.readTree(
                "{\"star\":4,\"summary\":\"匹配良好\",\"reasons\":[\"技能吻合\",\"薪资有交集\"],"
                        + "\"veto_suspects\":[],\"bonus_hits\":[\"大厂背景\"]}");
        ScoreResult result = ScoreResult.fromJson(node);
        assertEquals(4, result.star());
        assertEquals("匹配良好", result.summary());
        assertEquals(2, result.reasons().size());
        assertEquals(1, result.bonusHits().size());
        assertTrue(result.vetoSuspects().isEmpty());
    }

    @Test
    void rejectMissingStar() throws Exception {
        var node = objectMapper.readTree("{\"summary\":\"x\",\"reasons\":[]}");
        assertThrows(IllegalArgumentException.class, () -> ScoreResult.fromJson(node));
    }

    @Test
    void rejectStarOutOfRange() throws Exception {
        assertThrows(IllegalArgumentException.class,
                () -> ScoreResult.fromJson(objectMapper.readTree("{\"star\":0}")));
        assertThrows(IllegalArgumentException.class,
                () -> ScoreResult.fromJson(objectMapper.readTree("{\"star\":6}")));
        assertThrows(IllegalArgumentException.class,
                () -> ScoreResult.fromJson(objectMapper.readTree("{\"star\":\"三\"}")));
    }

    @Test
    void parseVetoSuspectsObjectAndStringForms() throws Exception {
        var node = objectMapper.readTree(
                "{\"star\":3,\"veto_suspects\":[{\"point\":\"不接受外包背景\",\"evidence\":\"近五年均在外包公司\"},\"纯外包\"]}");
        ScoreResult result = ScoreResult.fromJson(node);
        assertEquals(2, result.vetoSuspects().size());
        assertEquals("不接受外包背景", result.vetoSuspects().get(0).point());
        assertEquals("近五年均在外包公司", result.vetoSuspects().get(0).evidence());
        assertEquals("纯外包", result.vetoSuspects().get(1).point());
    }

    @Test
    void missingOptionalFieldsTolerated() throws Exception {
        ScoreResult result = ScoreResult.fromJson(objectMapper.readTree("{\"star\":2}"));
        assertEquals(2, result.star());
        assertTrue(result.vetoSuspects().isEmpty());
        assertTrue(result.bonusHits().isEmpty());
        assertTrue(result.reasons().isEmpty());
    }

    @Test
    void actionStatusFollowsStarMatrix() throws Exception {
        assertEquals("FAIL", actionStatusOf("{\"star\":1}"));
        assertEquals("KEPT", actionStatusOf("{\"star\":2}"));
        assertEquals("PASS", actionStatusOf("{\"star\":3}"));
        assertEquals("PASS", actionStatusOf("{\"star\":4}"));
        assertEquals("PASS", actionStatusOf("{\"star\":5}"));
    }

    @Test
    void vetoSuspectWithQualifiedStarHoldsForReview() throws Exception {
        // 疑似否决且星级达标(≥3) → HOLD 挂起待人工复核,不直接淘汰
        assertEquals("HOLD", actionStatusOf(
                "{\"star\":4,\"veto_suspects\":[{\"point\":\"不接受外包\"}]}"));
        // 疑似否决但星级本来就不达标 → 按星级走(1星 FAIL / 2星 KEPT)
        assertEquals("FAIL", actionStatusOf(
                "{\"star\":1,\"veto_suspects\":[{\"point\":\"不接受外包\"}]}"));
        assertEquals("KEPT", actionStatusOf(
                "{\"star\":2,\"veto_suspects\":[{\"point\":\"不接受外包\"}]}"));
    }

    private String actionStatusOf(String json) throws Exception {
        return ScoreResult.fromJson(objectMapper.readTree(json)).actionStatus();
    }
}
