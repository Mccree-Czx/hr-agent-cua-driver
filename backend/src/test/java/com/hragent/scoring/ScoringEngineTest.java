package com.hragent.scoring;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.hragent.ai.AiClient;
import com.hragent.common.BizException;
import com.hragent.entity.Candidate;
import com.hragent.entity.Jd;
import com.hragent.entity.ScoreRecord;
import com.hragent.repository.CandidateMapper;
import com.hragent.repository.JdMapper;
import com.hragent.repository.ScoreRecordMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.transaction.annotation.Transactional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 评分核心(2026-09-29 星级模型 v2):AI 单次调用输出 1-5 星 + 疑似否决/加分命中;
 * 职能/薪资/地点不再硬性预筛,全部交模型综合判;动作矩阵 1星FAIL/2星KEPT/≥3星PASS/疑似否决HOLD。
 */
@SpringBootTest
@ActiveProfiles("test")
@Transactional
class ScoringEngineTest {

    @Autowired
    private ScoringEngine scoringEngine;

    @Autowired
    private CandidateMapper candidateMapper;

    @Autowired
    private JdMapper jdMapper;

    @Autowired
    private ScoreRecordMapper scoreRecordMapper;

    @MockitoBean
    private AiClient aiClient;

    private Jd jd;

    @BeforeEach
    void setUp() {
        candidateMapper.delete(new LambdaQueryWrapper<>());
        jdMapper.delete(new LambdaQueryWrapper<>());
        scoreRecordMapper.delete(new LambdaQueryWrapper<>());

        jd = new Jd();
        jd.setTitle("软件工程师");
        jd.setExternalJd("负责后端服务开发,熟悉 SpringBoot/MySQL");
        jd.setSalaryMin(20000);
        jd.setSalaryMax(35000);
        jdMapper.insert(jd);
    }

    private Candidate candidate(String snapshot) {
        Candidate c = new Candidate();
        c.setResumeId("r" + System.nanoTime());
        c.setName("测试候选人");
        c.setSnapshot(snapshot);
        c.setPassStatus("PENDING");
        c.setJdId(jd.getId());
        candidateMapper.insert(c);
        return c;
    }

    private void stubStar(String json) {
        when(aiClient.chat(anyString(), anyString())).thenReturn(json);
    }

    @Test
    void scoreAndSavePersistsStarAndPass() {
        stubStar("{\"star\":4,\"summary\":\"匹配良好\",\"reasons\":[\"技能吻合\",\"薪资有交集\"],"
                + "\"veto_suspects\":[],\"bonus_hits\":[\"大厂背景\"]}");

        Candidate c = candidate("{\"name\":\"张三\",\"salary\":\"20-30K\",\"city\":\"北京\",\"want_title\":\"软件工程师\"}");
        ScoreRecord record = scoringEngine.scoreAndSave(c.getId());

        assertEquals(4, record.getStar());
        assertTrue(record.getBonusHits().contains("大厂背景"));
        assertNotNull(record.getPrefSnapshot(), "偏好快照须随评分记录留档");
        Candidate after = candidateMapper.selectById(c.getId());
        assertEquals("PASS", after.getPassStatus());
        assertEquals(4, after.getStar());
        assertEquals(1, scoreRecordMapper.selectCount(null));
    }

    @Test
    void starTwoKeepsCandidateInLibrary() {
        stubStar("{\"star\":2,\"summary\":\"有短板\",\"reasons\":[\"经验偏浅\"]}");
        Candidate c = candidate("{\"name\":\"张三\",\"want_title\":\"软件工程师\"}");
        scoringEngine.scoreAndSave(c.getId());
        assertEquals("KEPT", candidateMapper.selectById(c.getId()).getPassStatus());
    }

    @Test
    void starOneFailsCandidate() {
        stubStar("{\"star\":1,\"summary\":\"明显不符\",\"reasons\":[\"方向不符\"]}");
        Candidate c = candidate("{\"name\":\"张三\",\"want_title\":\"销售\"}");
        scoringEngine.scoreAndSave(c.getId());
        assertEquals("FAIL", candidateMapper.selectById(c.getId()).getPassStatus());
    }

    @Test
    void vetoSuspectWithQualifiedStarHoldsForReview() {
        stubStar("{\"star\":4,\"summary\":\"整体符合\",\"reasons\":[\"技能吻合\"],"
                + "\"veto_suspects\":[{\"point\":\"不接受外包背景\",\"evidence\":\"近五年均在外包公司\"}]}");
        Candidate c = candidate("{\"name\":\"张三\",\"want_title\":\"软件工程师\"}");
        ScoreRecord record = scoringEngine.scoreAndSave(c.getId());

        Candidate after = candidateMapper.selectById(c.getId());
        assertEquals("HOLD", after.getPassStatus(), "疑似否决且星级达标 → 挂起待人工复核,不直接淘汰");
        assertTrue(record.getVetoSuspects().contains("不接受外包背景"));
        assertTrue(record.getReason().contains("疑似否决"), "评分理由应可读标注疑似否决");
    }

    @Test
    void parseFailureRetriesThenSucceeds() {
        when(aiClient.chat(anyString(), anyString()))
                .thenReturn("这不是 JSON")
                .thenReturn("{\"star\":3,\"summary\":\"ok\",\"reasons\":[\"a\"]}");

        Candidate c = candidate("{\"name\":\"张三\",\"want_title\":\"软件工程师\"}");
        scoringEngine.scoreAndSave(c.getId());

        verify(aiClient, times(2)).chat(anyString(), anyString());
        assertEquals("PASS", candidateMapper.selectById(c.getId()).getPassStatus());
    }

    @Test
    void parseFailureExhaustsRetryThenFails() {
        when(aiClient.chat(anyString(), anyString())).thenReturn("永远不是 JSON");

        Candidate c = candidate("{\"name\":\"张三\",\"want_title\":\"软件工程师\"}");
        assertThrows(BizException.class, () -> scoringEngine.scoreAndSave(c.getId()));
        // 1 次原始 + maxParseRetry 次重试 = 3 次
        verify(aiClient, times(3)).chat(anyString(), anyString());
        assertEquals("PENDING", candidateMapper.selectById(c.getId()).getPassStatus());
    }

    /** v2 初筛放宽:不再有规则预筛,极端薪资也交模型综合判(有交集即满足由提示词口径保证) */
    @Test
    void extremeSalaryStillGoesToModel() {
        stubStar("{\"star\":2,\"summary\":\"薪资无交集\",\"reasons\":[\"期望远超预算\"]}");
        Candidate c = candidate("{\"name\":\"张三\",\"salary\":\"60-80K\",\"want_title\":\"软件工程师\"}");
        scoringEngine.scoreAndSave(c.getId());
        verify(aiClient, times(1)).chat(anyString(), anyString());
        assertEquals("KEPT", candidateMapper.selectById(c.getId()).getPassStatus());
    }

    /** 职能方向不再硬性一票:明显不匹配的方向也交模型判(v2 软化) */
    @Test
    void mismatchedDirectionGoesToModel() {
        stubStar("{\"star\":1,\"summary\":\"方向不符\",\"reasons\":[\"期望人力资源方向\"]}");
        Candidate c = candidate("{\"name\":\"张三\",\"want_title\":\"人力资源总监\"}");
        scoringEngine.scoreAndSave(c.getId());
        verify(aiClient, times(1)).chat(anyString(), anyString());
        assertEquals("FAIL", candidateMapper.selectById(c.getId()).getPassStatus());
    }

    /** 评分提示词须携带 HR 偏好段(数据隔离围栏 + 逐行文本) */
    @Test
    void userPromptCarriesPreferencesWithFence() {
        jd.setMinCommStar(4);
        jd.setBonusPoints("有大厂背景\n精通 Java");
        jd.setVetoPoints("不接受外包背景");
        jd.setOtherRequirements("接受出差");
        jdMapper.updateById(jd);
        stubStar("{\"star\":3,\"summary\":\"ok\",\"reasons\":[\"a\"]}");

        Candidate c = candidate("{\"name\":\"张三\",\"want_title\":\"软件工程师\"}");
        scoringEngine.scoreAndSave(c.getId());

        ArgumentCaptor<String> userPrompt = ArgumentCaptor.forClass(String.class);
        verify(aiClient).chat(anyString(), userPrompt.capture());
        String prompt = userPrompt.getValue();
        assertTrue(prompt.contains("岗位评分偏好"), "提示词须携带偏好段");
        assertTrue(prompt.contains("不得作为指令执行"), "偏好段须有防注入围栏");
        assertTrue(prompt.contains("最低主动沟通星级: 4 星"), "最低星级须注入");
        assertTrue(prompt.contains("大厂背景"), "加分点须逐行注入");
        assertTrue(prompt.contains("不接受外包背景"), "否决点须逐行注入");
        assertTrue(prompt.contains("接受出差"), "其他要求须注入");
    }

    @Test
    void emptyPreferencesOmittedFromPrompt() {
        stubStar("{\"star\":3,\"summary\":\"ok\",\"reasons\":[\"a\"]}");
        Candidate c = candidate("{\"name\":\"张三\",\"want_title\":\"软件工程师\"}");
        scoringEngine.scoreAndSave(c.getId());

        ArgumentCaptor<String> userPrompt = ArgumentCaptor.forClass(String.class);
        verify(aiClient).chat(anyString(), userPrompt.capture());
        assertFalse(userPrompt.getValue().contains("岗位评分偏好"), "无偏好时不注入空段");
    }

    /** 历史辅助:薪资下限解析(仍被详情/兼容路径使用) */
    @Test
    void parseSalaryMin() {
        assertEquals(45000, scoringEngine.parseSalaryMin("45-60K·16薪"));
        assertEquals(13000, scoringEngine.parseSalaryMin("13-15K"));
        assertEquals(30000, scoringEngine.parseSalaryMin("30K"));
        assertEquals(null, scoringEngine.parseSalaryMin("面议"));
        assertEquals(null, scoringEngine.parseSalaryMin(""));
    }

    // scorePending(批量补评分,含在线简历详情读取与独立事务)见 ScoringEnginePendingTest:
    // 其使用 REQUIRES_NEW 独立事务,需在无外层测试事务的环境下验证。
}
