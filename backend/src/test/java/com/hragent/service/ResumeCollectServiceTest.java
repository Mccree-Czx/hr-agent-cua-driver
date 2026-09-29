package com.hragent.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.hragent.entity.Candidate;
import com.hragent.entity.GreetingRecord;
import com.hragent.entity.Jd;
import com.hragent.entity.LiepinAccount;
import com.hragent.entity.ResumeFile;
import com.hragent.repository.CandidateMapper;
import com.hragent.repository.GreetingRecordMapper;
import com.hragent.repository.JdMapper;
import com.hragent.repository.LiepinAccountMapper;
import com.hragent.repository.ResumeFileMapper;
import com.hragent.storage.StorageService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.transaction.annotation.Transactional;

import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.LocalDateTime;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@SpringBootTest
@ActiveProfiles("test")
@Transactional
class ResumeCollectServiceTest {

    @Autowired
    private ResumeCollectService resumeCollectService;

    @Autowired
    private CandidateMapper candidateMapper;

    @Autowired
    private LiepinAccountMapper accountMapper;

    @Autowired
    private GreetingRecordMapper greetingMapper;

    @Autowired
    private ResumeFileMapper resumeFileMapper;

    @Autowired
    private StorageService storageService;

    @Autowired
    private JdMapper jdMapper;

    @MockitoBean
    private LiepinCommandService commandService;

    private final ObjectMapper objectMapper = new ObjectMapper();

    private LiepinAccount account;
    private Candidate candidate;
    private GreetingRecord record;

    @BeforeEach
    void setUp() {
        resumeFileMapper.delete(new LambdaQueryWrapper<>());
        greetingMapper.delete(new LambdaQueryWrapper<>());
        candidateMapper.delete(new LambdaQueryWrapper<>());
        accountMapper.delete(new LambdaQueryWrapper<>());
        jdMapper.delete(new LambdaQueryWrapper<>());

        account = new LiepinAccount();
        account.setName("账号");
        account.setLoginStatus("NORMAL");
        accountMapper.insert(account);

        // 来源岗位:已确认门槛(外发前提)
        Jd jd = new Jd();
        jd.setTitle("测试岗位");
        jd.setScoreThreshold(60);
        jd.setThresholdConfirmedAt(LocalDateTime.now());
        jd.setScoringPrefConfirmedAt(LocalDateTime.now());
        jdMapper.insert(jd);

        candidate = new Candidate();
        candidate.setResumeId("r1");
        candidate.setName("张三");
        candidate.setSnapshot("{\"name\":\"张三\",\"user_id\":\"u1\",\"im_id\":\"im1\"}");
        candidate.setJdId(jd.getId());
        candidate.setPassStatus("PASS");
        candidateMapper.insert(candidate);

        record = new GreetingRecord();
        record.setCandidateId(candidate.getId());
        record.setAccountId(account.getId());
        record.setStatus("SENT");
        record.setMode("AUTO");
        greetingMapper.insert(record);
    }

    @Test
    void checkReplyDetectsCandidateReply() throws Exception {
        when(commandService.chatlist(any(LiepinAccount.class), any(Duration.class)))
                .thenReturn(List.of(objectMapper.readTree(
                        "{\"user_id\":\"u1\",\"im_id\":\"im1\",\"direction\":\"1\",\"latest_msg\":\"好的\"}")));
        assertTrue(resumeCollectService.checkReply(account, candidate, Duration.ofSeconds(5)));
    }

    @Test
    void checkReplyIgnoresOthersAndOwnMessages() throws Exception {
        when(commandService.chatlist(any(LiepinAccount.class), any(Duration.class)))
                .thenReturn(List.of(
                        objectMapper.readTree("{\"user_id\":\"other\",\"im_id\":\"x\",\"direction\":\"1\"}"),
                        objectMapper.readTree("{\"user_id\":\"u1\",\"im_id\":\"im1\",\"direction\":\"0\"}")));
        assertFalse(resumeCollectService.checkReply(account, candidate, Duration.ofSeconds(5)));
    }

    @Test
    void collectOneRequestsResumeWhenReplied() throws Exception {
        when(commandService.requestResume(any(), org.mockito.ArgumentMatchers.eq("r1"), any(), any()))
                .thenReturn(java.util.Optional.of(objectMapper.readTree("{\"success\":true,\"confirmed\":true}")));
        when(commandService.chatlist(any(LiepinAccount.class), any(Duration.class)))
                .thenReturn(List.of(objectMapper.readTree(
                        "{\"user_id\":\"u1\",\"im_id\":\"im1\",\"direction\":\"1\"}")));

        resumeCollectService.collectOne(record, candidate);

        verify(commandService).requestResume(any(LiepinAccount.class), org.mockito.ArgumentMatchers.eq("r1"), any(), any(Duration.class));
        GreetingRecord after = greetingMapper.selectById(record.getId());
        assertEquals("REQUESTED", after.getStatus());
    }

    @Test
    void collectOneSkipsWhenNoReply() throws Exception {
        when(commandService.chatlist(any(LiepinAccount.class), any(Duration.class)))
                .thenReturn(List.of(objectMapper.readTree(
                        "{\"user_id\":\"u1\",\"im_id\":\"im1\",\"direction\":\"0\"}")));

        resumeCollectService.collectOne(record, candidate);

        verify(commandService, never()).requestResume(any(), anyString(), any(), any());
        assertEquals("SENT", greetingMapper.selectById(record.getId()).getStatus());
    }

    @Test
    void saveResumeFileStoresAndDedups() {
        byte[] content = "fake pdf content".getBytes(StandardCharsets.UTF_8);
        ResumeFile file = resumeCollectService.saveResumeFile(candidate.getId(), "简历.pdf", content, "application/pdf");
        assertTrue(file.getId() != null);
        assertEquals("pdf", file.getFormat());
        assertEquals(content.length, file.getSize());
        assertTrue(storageService.exists(file.getObjectKey()), "文件应写入存储");

        // 再次保存 → 更新而非新增(去重)
        resumeCollectService.saveResumeFile(candidate.getId(), "简历.pdf", content, "application/pdf");
        assertEquals(1, resumeFileMapper.selectCount(null));
    }

    @Test
    void requestResumeBlockedWhenThresholdUnconfirmed() throws Exception {
        // 来源岗位未确认门槛 → 绝不索要简历,不改状态(fail-closed)
        Jd unconfirmed = new Jd();
        unconfirmed.setTitle("未确认门槛岗位");
        jdMapper.insert(unconfirmed);
        candidate.setJdId(unconfirmed.getId());
        candidateMapper.updateById(candidate);

        when(commandService.chatlist(any(LiepinAccount.class), any(Duration.class)))
                .thenReturn(List.of(objectMapper.readTree(
                        "{\"user_id\":\"u1\",\"im_id\":\"im1\",\"direction\":\"1\"}")));

        resumeCollectService.collectOne(record, candidate);

        verify(commandService, never()).requestResume(any(), anyString(), any(), any());
        assertEquals("SENT", greetingMapper.selectById(record.getId()).getStatus(), "未确认门 槛不得改状态");
    }

    // ---------- 直接索要(已读触发路径的守卫,2026-09-26 新增) ----------

    @Test
    void requestResumeDirectSkipsWhenRecordNotSent() throws Exception {
        record.setStatus("REQUESTED");
        greetingMapper.updateById(record);

        assertFalse(resumeCollectService.requestResumeDirect(account, candidate), "已索要过的记录不得重复触发");
        verify(commandService, never()).requestResume(any(), anyString(), any(), any());
    }

    @Test
    void requestResumeDirectSkipsWhenCandidateNotPass() throws Exception {
        candidate.setPassStatus("PENDING");
        candidateMapper.updateById(candidate);

        assertFalse(resumeCollectService.requestResumeDirect(account, candidate), "非 PASS 不得索要");
        verify(commandService, never()).requestResume(any(), anyString(), any(), any());
    }

    @Test
    void requestResumeDirectRequestsAndMarksRequested() throws Exception {
        when(commandService.requestResume(any(), org.mockito.ArgumentMatchers.eq("r1"), any(), any()))
                .thenReturn(java.util.Optional.of(objectMapper.readTree("{\"success\":true,\"confirmed\":true}")));

        assertTrue(resumeCollectService.requestResumeDirect(account, candidate));
        assertEquals("REQUESTED", greetingMapper.selectById(record.getId()).getStatus());
    }

    // ---------- 索要防重复窗口(2026-09-27 新增:24h 窗口 + 次数上限) ----------

    @Test
    void requestResumeSkipsWithin24Hours() throws Exception {
        record.setResumeRequestedAt(LocalDateTime.now().minusHours(1));
        record.setResumeRequestCount(1);
        greetingMapper.updateById(record);
        when(commandService.chatlist(any(LiepinAccount.class), any(Duration.class)))
                .thenReturn(List.of(objectMapper.readTree(
                        "{\"user_id\":\"u1\",\"im_id\":\"im1\",\"direction\":\"1\"}")));

        resumeCollectService.collectOne(record, candidate);

        verify(commandService, never()).requestResume(any(), anyString(), any(), any());
        assertEquals("SENT", greetingMapper.selectById(record.getId()).getStatus());
    }

    @Test
    void requestResumeSkipsAfterMaxAttempts() throws Exception {
        record.setResumeRequestedAt(LocalDateTime.now().minusDays(2));
        record.setResumeRequestCount(2);
        greetingMapper.updateById(record);
        when(commandService.chatlist(any(LiepinAccount.class), any(Duration.class)))
                .thenReturn(List.of(objectMapper.readTree(
                        "{\"user_id\":\"u1\",\"im_id\":\"im1\",\"direction\":\"1\"}")));

        resumeCollectService.collectOne(record, candidate);

        verify(commandService, never()).requestResume(any(), anyString(), any(), any());
    }

    @Test
    void requestResumeRetriesAfter24HoursAndCounts() throws Exception {
        record.setResumeRequestedAt(LocalDateTime.now().minusHours(25));
        record.setResumeRequestCount(1);
        greetingMapper.updateById(record);
        when(commandService.requestResume(any(), org.mockito.ArgumentMatchers.eq("r1"), any(), any()))
                .thenReturn(java.util.Optional.of(objectMapper.readTree("{\"success\":true,\"confirmed\":true}")));
        when(commandService.chatlist(any(LiepinAccount.class), any(Duration.class)))
                .thenReturn(List.of(objectMapper.readTree(
                        "{\"user_id\":\"u1\",\"im_id\":\"im1\",\"direction\":\"1\"}")));

        resumeCollectService.collectOne(record, candidate);

        verify(commandService).requestResume(any(LiepinAccount.class), org.mockito.ArgumentMatchers.eq("r1"), any(), any(Duration.class));
        GreetingRecord after = greetingMapper.selectById(record.getId());
        assertEquals("REQUESTED", after.getStatus());
        assertEquals(2, after.getResumeRequestCount());
        assertNotNull(after.getResumeRequestedAt());
    }

    @Test
    void requestResumeRecordsAttemptWhenNotEchoed() throws Exception {
        when(commandService.requestResume(any(), org.mockito.ArgumentMatchers.eq("r1"), any(), any()))
                .thenReturn(java.util.Optional.of(objectMapper.readTree("{\"success\":true,\"confirmed\":false}")));
        when(commandService.chatlist(any(LiepinAccount.class), any(Duration.class)))
                .thenReturn(List.of(objectMapper.readTree(
                        "{\"user_id\":\"u1\",\"im_id\":\"im1\",\"direction\":\"1\"}")));

        resumeCollectService.collectOne(record, candidate);

        GreetingRecord after = greetingMapper.selectById(record.getId());
        assertEquals("SENT", after.getStatus(), "未回显确认时状态保守不变");
        assertEquals(1, after.getResumeRequestCount(), "接口受理即记录尝试次数");
        assertNotNull(after.getResumeRequestedAt(), "记录最近请求时间,24h 内不再重复");
    }
}
