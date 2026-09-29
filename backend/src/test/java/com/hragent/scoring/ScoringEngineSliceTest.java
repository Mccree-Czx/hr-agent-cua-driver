package com.hragent.scoring;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.hragent.ai.AiClient;
import com.hragent.config.HrAgentProperties;
import com.hragent.entity.Candidate;
import com.hragent.entity.Jd;
import com.hragent.entity.LiepinAccount;
import com.hragent.executor.CliException;
import com.hragent.repository.CandidateMapper;
import com.hragent.repository.JdMapper;
import com.hragent.repository.LiepinAccountMapper;
import com.hragent.repository.ScoreRecordMapper;
import com.hragent.service.LiepinCommandService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoBean;

import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * {@link ScoringEngine#scoreNext(Long, int)} 分片补评分测试(2026-09-28 节拍改造):
 * 一 tick 一候选人;轮内单岗位读取计数跨片累计(旧 scorePending 的随片重置缺口)。
 * 同样刻意不使用 {@code @Transactional}(内部 REQUIRES_NEW 独立事务,见 {@link ScoringEnginePendingTest} 说明)。
 */
@SpringBootTest
@ActiveProfiles("test")
class ScoringEngineSliceTest {

    @Autowired
    private ScoringEngine scoringEngine;

    @Autowired
    private CandidateMapper candidateMapper;

    @Autowired
    private JdMapper jdMapper;

    @Autowired
    private ScoreRecordMapper scoreRecordMapper;

    @Autowired
    private LiepinAccountMapper accountMapper;

    @Autowired
    private HrAgentProperties properties;

    @MockitoBean
    private AiClient aiClient;

    @MockitoBean
    private LiepinCommandService commandService;

    private final ObjectMapper objectMapper = new ObjectMapper();

    private Jd jd;

    @BeforeEach
    void setUp() {
        scoreRecordMapper.delete(new LambdaQueryWrapper<>());
        candidateMapper.delete(new LambdaQueryWrapper<>());
        accountMapper.delete(new LambdaQueryWrapper<>());
        jdMapper.delete(new LambdaQueryWrapper<>());
        properties.getAutoRecruit().setResumeDetailIntervalMillis(0);

        jd = new Jd();
        jd.setTitle("软件工程师");
        jd.setExternalJd("负责后端服务开发,熟悉 SpringBoot/MySQL");
        jd.setSalaryMin(20000);
        jd.setSalaryMax(35000);
        jdMapper.insert(jd);
    }

    private Candidate candidate(String snapshot, String storedResumeId) {
        Candidate c = new Candidate();
        c.setResumeId(storedResumeId);
        c.setName("测试候选人");
        c.setSnapshot(snapshot);
        c.setPassStatus("PENDING");
        c.setJdId(jd.getId());
        candidateMapper.insert(c);
        return c;
    }

    private void createNormalAccount() {
        LiepinAccount account = new LiepinAccount();
        account.setName("测试账号");
        account.setLoginStatus("NORMAL");
        account.setCircuitBreaker(false);
        accountMapper.insert(account);
    }

    @Test
    void sliceProcessesAtMostMaxAndReportsZeroWhenDrained() {
        when(aiClient.chat(anyString(), anyString()))
                .thenReturn("{\"star\":3,\"summary\":\"ok\",\"reasons\":[\"a\"]}");
        candidate("{\"name\":\"甲\",\"salary\":\"20-30K\",\"want_title\":\"软件工程师\"}", "r1");
        candidate("{\"name\":\"乙\",\"salary\":\"20-30K\",\"want_title\":\"软件工程师\"}", "r2");
        candidate("{\"name\":\"丙\",\"salary\":\"20-30K\",\"want_title\":\"软件工程师\"}", "r3");

        assertEquals(1, scoringEngine.scoreNext(jd.getId(), 1), "一片只处理一个候选人");
        assertEquals(1, scoringEngine.scoreNext(jd.getId(), 1));
        assertEquals(1, scoringEngine.scoreNext(jd.getId(), 1));
        assertEquals(0, scoringEngine.scoreNext(jd.getId(), 1), "消费完后返回 0(调用方据此标记岗位读完)");
        assertEquals(3, scoreRecordMapper.selectCount(null));
    }

    @Test
    void perJdReadBudgetIsSharedAcrossSlices() throws Exception {
        createNormalAccount();
        when(aiClient.chat(anyString(), anyString()))
                .thenReturn("{\"star\":3,\"summary\":\"ok\",\"reasons\":[\"a\"]}");
        when(commandService.resume(any(), anyString(), any())).thenReturn(Optional.of(
                objectMapper.readTree("{\"want_title\":\"软件工程师\",\"expectation_evidence\":{"
                        + "\"source\":\"resumeDetailVo.jobWant.jobTitleNames\","
                        + "\"entries\":[{\"title\":\"软件工程师\"}]}}")));
        candidate("{\"name\":\"甲\",\"resume_id\":\"res-1\"}", "res-1");
        candidate("{\"name\":\"乙\",\"resume_id\":\"res-2\"}", "res-2");
        candidate("{\"name\":\"丙\",\"resume_id\":\"res-3\"}", "res-3");

        int oldLimit = properties.getAutoRecruit().getResumeDetailBatchLimit();
        try {
            properties.getAutoRecruit().setResumeDetailBatchLimit(1);
            scoringEngine.beginRound();

            scoringEngine.scoreNext(jd.getId(), 1);
            scoringEngine.scoreNext(jd.getId(), 1);
            scoringEngine.scoreNext(jd.getId(), 1);
        } finally {
            properties.getAutoRecruit().setResumeDetailBatchLimit(oldLimit);
            scoringEngine.beginRound();
        }

        verify(commandService, times(1)).resume(any(), anyString(), any());
        assertEquals(3, scoreRecordMapper.selectCount(null), "其余候选人照常落评分记录(读取受预算限制)");
    }

    @Test
    void riskControlExceptionIsRethrownFromSlice() throws Exception {
        createNormalAccount();
        candidate("{\"name\":\"甲\",\"resume_id\":\"res-1\"}", "res-1");
        when(commandService.resume(any(), anyString(), any()))
                .thenThrow(new CliException(CliException.Type.RISK_CONTROL, "安全验证"));
        scoringEngine.beginRound();

        assertThrows(CliException.class, () -> scoringEngine.scoreNext(jd.getId(), 1),
                "风控异常应上抛(由轮次冻结-复测策略处理)");
    }
}
