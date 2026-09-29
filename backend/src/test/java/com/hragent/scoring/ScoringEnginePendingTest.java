package com.hragent.scoring;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.hragent.ai.AiClient;
import com.hragent.config.HrAgentProperties;
import com.hragent.entity.Candidate;
import com.hragent.entity.Jd;
import com.hragent.entity.LiepinAccount;
import com.hragent.entity.ScoreRecord;
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
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * {@link ScoringEngine#scorePending(Long)} 批量补评分测试(2026-09-29 星级模型 v2)。
 *
 * <p>重评规则(v2):星级记录已有定论 → 跳过;分数时代旧记录 → 仅 PENDING 遗产重评一次
 * (存量迁移:只重评 PENDING,PASS/FAIL 不动)。职能/期望缺失不再阻断评分(交模型综合判)。
 *
 * <p>刻意<b>不使用 {@code @Transactional}</b>:单候选人评分经 {@link CandidateScoringExecutor} 的
 * {@code REQUIRES_NEW} 独立事务落库,若测试外层存在未提交事务,内层新事务既看不到候选人
 * (MVCC 不可见),又会因行锁冲突而失败。故本类以显式 {@code setUp} 清理数据保证隔离。
 */
@SpringBootTest
@ActiveProfiles("test")
class ScoringEnginePendingTest {

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
        // 详情读取间隔置 0,避免用例等待
        properties.getAutoRecruit().setResumeDetailBatchLimit(20);
        properties.getAutoRecruit().setResumeDetailIntervalMillis(0);

        jd = new Jd();
        jd.setTitle("软件工程师");
        jd.setExternalJd("负责后端服务开发,熟悉 SpringBoot/MySQL");
        jd.setSalaryMin(20000);
        jd.setSalaryMax(35000);
        jdMapper.insert(jd);
    }

    private Candidate candidate(String snapshot) {
        return candidate(snapshot, "r" + System.nanoTime());
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

    private LiepinAccount createNormalAccount() {
        LiepinAccount account = new LiepinAccount();
        account.setName("测试账号");
        account.setLoginStatus("NORMAL");
        account.setCircuitBreaker(false);
        accountMapper.insert(account);
        return account;
    }

    private void stubStar(String json) {
        when(aiClient.chat(anyString(), anyString())).thenReturn(json);
    }

    private ScoreRecord legacyRecord(Candidate c, Integer score, String reason) {
        ScoreRecord record = new ScoreRecord();
        record.setCandidateId(c.getId());
        record.setJdId(jd.getId());
        record.setScore(score);
        record.setReason(reason);
        scoreRecordMapper.insert(record);
        return record;
    }

    // ---------- 基线:批量补评分 ----------

    @Test
    void scorePendingScoresUnscoredCandidates() {
        stubStar("{\"star\":3,\"summary\":\"ok\",\"reasons\":[\"a\"]}");
        candidate("{\"name\":\"张三\",\"salary\":\"20-30K\",\"want_title\":\"软件工程师\"}");
        candidate("{\"name\":\"李四\",\"salary\":\"20-30K\",\"want_title\":\"软件工程师\"}");

        int scored = scoringEngine.scorePending(jd.getId());

        assertEquals(2, scored);
        assertEquals(2, scoreRecordMapper.selectCount(null));
        verify(aiClient, times(2)).chat(anyString(), anyString());
    }

    /** 存量迁移 B 方案:分数时代旧记录 + PENDING 遗产 → 重评一次为星级记录(自动消化积压)。 */
    @Test
    void scorePendingReevaluatesLegacyPendingRecord() {
        stubStar("{\"star\":4,\"summary\":\"补齐后匹配\",\"reasons\":[\"a\"]}");
        Candidate c = candidate("{\"name\":\"张三\",\"want_title\":\"软件工程师\"}");
        legacyRecord(c, 70, "旧分制记录");

        int scored = scoringEngine.scorePending(jd.getId());

        assertEquals(1, scored, "旧记录 + PENDING 遗产应重评");
        assertEquals(2, scoreRecordMapper.selectCount(null), "重评追加新记录(旧记录留档)");
        Candidate after = candidateMapper.selectById(c.getId());
        assertEquals("PASS", after.getPassStatus());
        assertEquals(4, after.getStar());
    }

    /** 星级记录已有定论 → 跳过(偏好变更不触发;此处以 PENDING 状态构造边界)。 */
    @Test
    void scorePendingSkipsStarRecord() {
        stubStar("{\"star\":3,\"summary\":\"ok\",\"reasons\":[\"a\"]}");
        Candidate c = candidate("{\"name\":\"张三\",\"want_title\":\"软件工程师\"}");
        ScoreRecord v2 = legacyRecord(c, null, "星级记录");
        v2.setStar(3);
        scoreRecordMapper.updateById(v2);

        int scored = scoringEngine.scorePending(jd.getId());

        assertEquals(0, scored, "星级记录已有定论,不得重评");
        verify(aiClient, never()).chat(anyString(), anyString());
    }

    @Test
    void scorePendingOnlySelectsPendingStatus() {
        Candidate pass = candidate("{\"name\":\"张三\",\"want_title\":\"软件工程师\"}");
        pass.setPassStatus("PASS");
        candidateMapper.updateById(pass);
        Candidate kept = candidate("{\"name\":\"李四\",\"want_title\":\"软件工程师\"}");
        kept.setPassStatus("KEPT");
        candidateMapper.updateById(kept);

        int scored = scoringEngine.scorePending(jd.getId());

        assertEquals(0, scored, "非 PENDING 候选人不应被补评分");
        verify(aiClient, never()).chat(anyString(), anyString());
    }

    // ---------- 评分前读取在线简历详情并合并期望字段 ----------

    @Test
    void scorePendingFetchesResumeDetailAndScoresWhenExpectationMissing() throws Exception {
        createNormalAccount();
        stubStar("{\"star\":4,\"summary\":\"ok\",\"reasons\":[\"a\"]}");
        // 快照同时含推荐节点 talentId(enresId) 与搜索节点 resume_id → 详情必须用 resume_id 读取
        Candidate c = candidate("{\"name\":\"张三\",\"salary\":\"20-30K\","
                + "\"talentId\":\"talent-enres-id\",\"resume_id\":\"res-1\"}");
        when(commandService.resume(any(), eq("res-1"), any())).thenReturn(Optional.of(
                objectMapper.readTree("{\"want_title\":\"软件工程师\",\"expectation_evidence\":{"
                        + "\"source\":\"resumeDetailVo.jobWant.jobTitleNames\","
                        + "\"entries\":[{\"title\":\"软件工程师\"}]}}")));

        int scored = scoringEngine.scorePending(jd.getId());

        assertEquals(1, scored);
        Candidate after = candidateMapper.selectById(c.getId());
        assertEquals("PASS", after.getPassStatus());
        assertTrue(after.getSnapshot().contains("expectation_evidence"), "简历详情期望字段应合并写回快照");
        assertTrue(after.getSnapshot().contains("\"talentId\":\"talent-enres-id\""), "合并不得丢失既有字段");
        verify(commandService).resume(any(), eq("res-1"), any());
        verify(commandService, never()).resume(any(), eq("talent-enres-id"), any());
    }

    @Test
    void roundReadBudgetCapsDetailFetches() throws Exception {
        createNormalAccount();
        stubStar("{\"star\":3,\"summary\":\"ok\",\"reasons\":[\"a\"]}");
        candidate("{\"name\":\"甲\",\"resume_id\":\"res-1\"}");
        candidate("{\"name\":\"乙\",\"resume_id\":\"res-2\"}");
        when(commandService.resume(any(), anyString(), any())).thenReturn(Optional.of(
                objectMapper.readTree("{\"want_title\":\"软件工程师\",\"expectation_evidence\":{"
                        + "\"source\":\"resumeDetailVo.jobWant.jobTitleNames\","
                        + "\"entries\":[{\"title\":\"软件工程师\"}]}}")));
        try {
            // 轮内预算=1:两个缺期望数据的候选人只允许 1 次详情读取(读取量是平台足迹大头)
            properties.getAutoRecruit().setResumeDetailRoundLimit(1);
            scoringEngine.beginRound();

            scoringEngine.scorePending(jd.getId());

            verify(commandService, times(1)).resume(any(), anyString(), any());
        } finally {
            properties.getAutoRecruit().setResumeDetailRoundLimit(30); // 恢复默认
            scoringEngine.beginRound(); // 重建预算,避免耗尽后的预算泄漏到后续用例
        }
    }

    /** v2:详情为空不再阻断评分(职能软判,交模型综合判)——仍调模型出星级。 */
    @Test
    void detailEmptyStillScoresViaModel() {
        createNormalAccount();
        stubStar("{\"star\":2,\"summary\":\"信息不足\",\"reasons\":[\"期望缺失\"]}");
        Candidate c = candidate("{\"name\":\"张三\",\"resume_id\":\"res-1\"}");
        when(commandService.resume(any(), eq("res-1"), any())).thenReturn(Optional.empty());

        scoringEngine.scorePending(jd.getId());

        Candidate after = candidateMapper.selectById(c.getId());
        assertEquals("KEPT", after.getPassStatus(), "详情为空不再冻结 PENDING,按星级落结论");
        verify(aiClient, times(1)).chat(anyString(), anyString());
    }

    @Test
    void scorePendingKeepsBatchOnDetailFailure() throws Exception {
        createNormalAccount();
        stubStar("{\"star\":3,\"summary\":\"ok\",\"reasons\":[\"a\"]}");
        Candidate a = candidate("{\"name\":\"甲\",\"resume_id\":\"res-a\"}");
        Candidate b = candidate("{\"name\":\"乙\",\"resume_id\":\"res-b\"}");
        when(commandService.resume(any(), eq("res-a"), any()))
                .thenThrow(new CliException(CliException.Type.FAILED, "详情读取失败"));
        when(commandService.resume(any(), eq("res-b"), any())).thenReturn(Optional.of(
                objectMapper.readTree("{\"want_title\":\"软件工程师\"}")));

        int scored = scoringEngine.scorePending(jd.getId());

        assertEquals(2, scored, "详情失败不得中断整批");
        assertEquals("PASS", candidateMapper.selectById(a.getId()).getPassStatus(), "详情失败仍按模型星级落结论");
        assertEquals("PASS", candidateMapper.selectById(b.getId()).getPassStatus());
    }

    /** snapshot 无 resume_id → 回退 candidate.resume_id 主列读详情。 */
    @Test
    void scorePendingUsesStoredResumeIdWhenSnapshotHasNoResumeId() throws Exception {
        createNormalAccount();
        stubStar("{\"star\":3,\"summary\":\"ok\",\"reasons\":[\"a\"]}");
        Candidate c = candidate("{\"name\":\"张三\",\"talentId\":\"talent-enres-id\"}", "stored-res-id");
        when(commandService.resume(any(), eq("stored-res-id"), any())).thenReturn(Optional.of(
                objectMapper.readTree("{\"want_title\":\"软件工程师\"}")));

        int scored = scoringEngine.scorePending(jd.getId());

        assertEquals(1, scored);
        assertEquals("PASS", candidateMapper.selectById(c.getId()).getPassStatus());
        verify(commandService).resume(any(), eq("stored-res-id"), any());
    }

    /** snapshot 与主列均无有效简历标识 → 跳过详情读取(enresId/talentId 不作为详情标识),仍照常评分。 */
    @Test
    void scorePendingSkipsResumeDetailWhenNoResumeIdAvailable() {
        createNormalAccount();
        stubStar("{\"star\":3,\"summary\":\"ok\",\"reasons\":[\"a\"]}");
        Candidate c = candidate("{\"name\":\"张三\",\"talentId\":\"talent-enres-id\"}", "");

        int scored = scoringEngine.scorePending(jd.getId());

        assertEquals(1, scored);
        assertEquals("PASS", candidateMapper.selectById(c.getId()).getPassStatus());
        verify(commandService, never()).resume(any(), any(), any());
        verify(aiClient, times(1)).chat(anyString(), anyString());
    }

    /** 指纹稳定性(历史辅助方法保留):JSON 字段顺序不影响指纹;期望内容变化/缺失 → 指纹不同。 */
    @Test
    void expectationFingerprintStableAcrossKeyOrderAndChangesWithContent() {
        Candidate a = candidate("{\"name\":\"张三\",\"want_title\":\"软件工程师\","
                + "\"expectation_evidence\":{\"source\":\"resumeDetailVo.jobWant.jobTitleNames\","
                + "\"entries\":[{\"title\":\"软件工程师\"}]}}");
        Candidate b = candidate("{\"expectation_evidence\":{\"entries\":[{\"title\":\"软件工程师\"}],"
                + "\"source\":\"resumeDetailVo.jobWant.jobTitleNames\"},\"want_title\":\"软件工程师\",\"name\":\"张三\"}");
        Candidate changed = candidate("{\"name\":\"张三\",\"want_title\":\"人力资源总监\"}");
        Candidate empty = candidate("{\"name\":\"张三\"}");

        assertEquals(scoringEngine.expectationFingerprint(a), scoringEngine.expectationFingerprint(b),
                "字段顺序不同但期望内容相同 → 指纹一致");
        assertNotEquals(scoringEngine.expectationFingerprint(a), scoringEngine.expectationFingerprint(changed),
                "期望内容变化 → 指纹不同");
        assertNotEquals(scoringEngine.expectationFingerprint(a), scoringEngine.expectationFingerprint(empty),
                "期望缺失与补齐 → 指纹不同");
    }

    // ---------- 单候选独立事务:前序已提交结果不被后续致命异常回滚 ----------

    @Test
    void scoredCandidateCommitSurvivesFatalFailureOfLaterCandidate() {
        createNormalAccount();
        stubStar("{\"star\":4,\"summary\":\"ok\",\"reasons\":[\"a\"]}");
        Candidate earlier = candidate("{\"name\":\"甲\",\"want_title\":\"软件工程师\",\"resume_id\":\"res-a\"}");
        candidate("{\"name\":\"乙\",\"resume_id\":\"res-b\"}");
        when(commandService.resume(any(), eq("res-b"), any()))
                .thenThrow(new CliException(CliException.Type.RISK_CONTROL, "安全验证"));

        assertThrows(CliException.class, () -> scoringEngine.scorePending(jd.getId()));

        Candidate after = candidateMapper.selectById(earlier.getId());
        assertEquals("PASS", after.getPassStatus(), "前一位已提交结果不得被后续致命异常整批回滚");
        assertEquals(1, scoreRecordMapper.selectCount(new LambdaQueryWrapper<ScoreRecord>()
                .eq(ScoreRecord::getCandidateId, earlier.getId())));
    }
}
