package com.hragent.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.hragent.ai.AiClient;
import com.hragent.common.BizException;
import com.hragent.entity.Jd;
import com.hragent.repository.JdMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.transaction.annotation.Transactional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.when;

/**
 * 岗位门槛 AI 建议与人工确认测试(设计 3.3):
 * - suggest:调 AI 生成建议并落库(格式 建议{N}分:{理由});AI 失败不落半成品
 * - confirm:校验 1..100 后写 scoreThreshold + confirmedBy/At
 */
@SpringBootTest
@ActiveProfiles("test")
@Transactional
class JdThresholdServiceTest {

    @Autowired
    private JdThresholdService thresholdService;

    @Autowired
    private JdMapper jdMapper;

    @MockitoBean
    private AiClient aiClient;

    @BeforeEach
    void setUp() {
        jdMapper.delete(new LambdaQueryWrapper<>());
    }

    private Jd createJd() {
        Jd jd = new Jd();
        jd.setTitle("Java 后端工程师");
        jd.setExternalJd("负责后端服务开发");
        jd.setSalaryMin(20000);
        jd.setSalaryMax(35000);
        jdMapper.insert(jd);
        return jd;
    }

    @Test
    void suggestPersistsSuggestionTextWithoutConfirming() {
        when(aiClient.chat(anyString(), anyString()))
                .thenReturn("{\"threshold\":60,\"reason\":\"薪资带宽偏窄,建议60分\"}");

        Jd jd = createJd();
        String suggestion = thresholdService.suggest(jd.getId());

        assertEquals("建议60分:薪资带宽偏窄,建议60分", suggestion);
        Jd after = jdMapper.selectById(jd.getId());
        assertEquals("建议60分:薪资带宽偏窄,建议60分", after.getThresholdSuggestion());
        // 仅建议,不构成确认:门槛值/确认人/确认时间仍为空
        assertNull(after.getScoreThreshold(), "suggest 不得写入已确认门槛");
        assertNull(after.getThresholdConfirmedAt(), "suggest 不得标记已确认");
    }

    @Test
    void suggestAiFailureThrowsAndPersistsNothing() {
        when(aiClient.chat(anyString(), anyString()))
                .thenThrow(new RuntimeException("AI 服务不可用"));

        Jd jd = createJd();
        assertThrows(BizException.class, () -> thresholdService.suggest(jd.getId()));
        assertNull(jdMapper.selectById(jd.getId()).getThresholdSuggestion(), "AI 失败不得落半成品");
    }

    @Test
    void suggestInvalidOutputThrowsAndPersistsNothing() {
        when(aiClient.chat(anyString(), anyString())).thenReturn("这不是 JSON");

        Jd jd = createJd();
        assertThrows(BizException.class, () -> thresholdService.suggest(jd.getId()));
        assertNull(jdMapper.selectById(jd.getId()).getThresholdSuggestion());
    }

    @Test
    void suggestOutOfRangeThresholdThrowsAndPersistsNothing() {
        when(aiClient.chat(anyString(), anyString()))
                .thenReturn("{\"threshold\":120,\"reason\":\"越界\"}");

        Jd jd = createJd();
        assertThrows(BizException.class, () -> thresholdService.suggest(jd.getId()));
        assertNull(jdMapper.selectById(jd.getId()).getThresholdSuggestion());
    }

    @Test
    void suggestJdNotFoundThrows() {
        assertThrows(BizException.class, () -> thresholdService.suggest(999999L));
    }

    @Test
    void confirmWritesThresholdAndAuditFields() {
        Jd jd = createJd();
        thresholdService.confirm(jd.getId(), 75, 9L);

        Jd after = jdMapper.selectById(jd.getId());
        assertEquals(75, after.getScoreThreshold());
        assertEquals(9L, after.getThresholdConfirmedBy());
        assertNotNull(after.getThresholdConfirmedAt(), "确认后应记录确认时间(外发门禁依据)");
    }

    @Test
    void confirmRejectsOutOfRange() {
        Jd jd = createJd();
        assertThrows(BizException.class, () -> thresholdService.confirm(jd.getId(), 0, 9L));
        assertThrows(BizException.class, () -> thresholdService.confirm(jd.getId(), 101, 9L));

        Jd after = jdMapper.selectById(jd.getId());
        assertNull(after.getThresholdConfirmedAt(), "越界值不得写入确认");
        assertNull(after.getScoreThreshold());
    }

    @Test
    void confirmJdNotFoundThrows() {
        BizException e = assertThrows(BizException.class, () -> thresholdService.confirm(999999L, 60, 9L));
        assertTrue(e.getMessage().contains("岗位"));
    }
}
