package com.hragent.service;

import com.hragent.common.BizException;
import com.hragent.config.HrAgentProperties;
import com.hragent.entity.*;
import com.hragent.executor.CliResult;
import com.hragent.executor.LiepinCliExecutor;
import com.hragent.notify.NotifyService;
import com.hragent.repository.*;
import com.hragent.storage.StorageService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.time.LocalDateTime;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

// 全部外部边界为 mock：不运行进程、不连接业务库、不发消息。
class CapabilityContractTest {
    private final LiepinCliExecutor executor = mock(LiepinCliExecutor.class);
    private final LiepinAccountMapper accounts = mock(LiepinAccountMapper.class);
    private final JdMapper jobs = mock(JdMapper.class);
    private final SearchTaskMapper tasks = mock(SearchTaskMapper.class);
    private final CandidateMapper candidates = mock(CandidateMapper.class);
    private final GreetingRecordMapper greetings = mock(GreetingRecordMapper.class);
    private final TaskQueueService queue = mock(TaskQueueService.class);
    private final NotifyService notify = mock(NotifyService.class);
    private final HrAgentProperties props = new HrAgentProperties();
    private final RiskSuspectGuard guard = new RiskSuspectGuard(props);
    private final LiepinCommandService commands = new LiepinCommandService(executor, accounts, notify, guard);
    private final SearchTaskService search = new SearchTaskService(tasks, jobs, accounts, candidates,
            commands, queue, props, notify, guard);
    private final ResumeCollectService collect = new ResumeCollectService(greetings, candidates, accounts,
            mock(ResumeFileMapper.class), commands, mock(StorageService.class), jobs);
    private LiepinAccount account;
    private Jd jd;
    private SearchTask task;

    @BeforeEach
    void setup() throws Exception {
        account = new LiepinAccount();
        account.setId(1L);
        account.setCircuitBreaker(false);
        account.setLoginStatus("NORMAL");
        jd = new Jd();
        jd.setId(2L);
        jd.setLiepinJobId("101");
        jd.setThresholdConfirmedAt(LocalDateTime.now());
        jd.setScoringPrefConfirmedAt(LocalDateTime.now());
        task = new SearchTask();
        task.setId(3L);
        task.setAccountId(1L);
        task.setJdId(2L);
        task.setTaskType("RECOMMEND");
        task.setRetryCount(0);
        when(accounts.selectById(1L)).thenReturn(account);
        when(jobs.selectById(2L)).thenReturn(jd);
        when(executor.execute(any(), any(), any(String[].class)))
                .thenReturn(new CliResult(0, "[]", "", false));
    }

    @Test
    void recommendationBindsEachExplicitJobIncludingChangedBinding() throws Exception {
        search.execute(task);
        verify(executor).execute(eq(account), any(Duration.class), eq("recommend"), eq("--jobId"), eq("101"), eq("--json"));
        jd.setLiepinJobId("202");
        search.execute(task);
        verify(executor).execute(eq(account), any(Duration.class), eq("recommend"), eq("--jobId"), eq("202"), eq("--json"));
        verify(queue, times(2)).complete(3L);
        verifyNoInteractions(candidates);
    }

    @Test
    void unboundJobCannotCreateRecommendationTask() {
        jd.setLiepinJobId(" ");
        assertThrows(BizException.class, () -> search.createRecommendTask(2L, 1L));
        verifyNoInteractions(tasks, executor);
    }

    @Test
    void removedBindingAtExecutionNeverFallsBack() {
        jd.setLiepinJobId(null);
        search.execute(task);
        verifyNoInteractions(executor, candidates);
        verify(queue).fail(eq(3L), contains("岗位"), anyInt());
    }

    @Test
    void deletedJobAtExecutionNeverCallsCli() {
        when(jobs.selectById(2L)).thenReturn(null);
        search.execute(task);
        verifyNoInteractions(executor, candidates);
        verify(queue, never()).complete(anyLong());
    }

    private Candidate candidate() {
        Candidate c = new Candidate();
        c.setId(4L);
        c.setResumeId("resume-mock-1");
        c.setSnapshot("{\"im_id\":\"im-mock-1\"}");
        c.setJdId(2L);
        return c;
    }

    private GreetingRecord record() {
        GreetingRecord r = new GreetingRecord();
        r.setId(5L);
        r.setAccountId(1L);
        r.setStatus("SENT");
        return r;
    }

    private void replyAndResult(String result) throws Exception {
        when(executor.execute(eq(account), any(), eq("chatlist"), eq("--limit"), eq("100"), eq("--json")))
                .thenReturn(new CliResult(0, "[{\"im_id\":\"im-mock-1\",\"direction\":\"1\"}]", "", false));
        when(executor.execute(eq(account), any(), eq("request-resume"), anyString(), eq("--imId"), anyString(), eq("--json")))
                .thenReturn(new CliResult(0, result, "", false));
    }

    @Test
    void requestUsesResumeIdNotImId() throws Exception {
        replyAndResult("{\"success\":true,\"confirmed\":true}");
        GreetingRecord r = record();
        collect.collectOne(r, candidate());
        verify(executor).execute(eq(account), any(), eq("request-resume"), eq("resume-mock-1"), eq("--imId"), eq("im-mock-1"), eq("--json"));
        assertEquals("REQUESTED", r.getStatus());
    }

    @Test
    void requestDoesNotReplaceMissingResumeIdWithImId() throws Exception {
        replyAndResult("{\"success\":true,\"confirmed\":true}");
        Candidate c = candidate();
        c.setResumeId(null);
        collect.collectOne(record(), c);
        verify(executor, never()).execute(eq(account), any(), eq("request-resume"), anyString(), eq("--imId"), anyString(), eq("--json"));
        verifyNoInteractions(greetings);
    }

    @Test
    void rejectedRequestDoesNotBecomeRequested() throws Exception {
        for (String result : new String[]{"{}", "{\"success\":false}"}) {
            replyAndResult(result);
            GreetingRecord r = record();
            collect.collectOne(r, candidate());
            assertEquals("SENT", r.getStatus());
        }
        verifyNoInteractions(greetings);
    }

    @Test
    void unconfirmedButAcceptedRequestKeepsSentAndRecordsAttempt() throws Exception {
        // 2026-09-27 新语义: 接口已受理即记尝试(24h 防重复),但状态保守不置 REQUESTED
        replyAndResult("{\"success\":true,\"confirmed\":false}");
        GreetingRecord r = record();
        collect.collectOne(r, candidate());
        assertEquals("SENT", r.getStatus(), "未回显确认时状态保守不变");
        assertEquals(1, r.getResumeRequestCount(), "接口受理即记录尝试");
        assertNotNull(r.getResumeRequestedAt());
        verify(greetings).updateById(r);
    }
}
