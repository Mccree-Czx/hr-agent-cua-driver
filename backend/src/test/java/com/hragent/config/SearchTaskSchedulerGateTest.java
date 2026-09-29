package com.hragent.config;

import com.hragent.entity.LiepinAccount;
import com.hragent.repository.LiepinAccountMapper;
import com.hragent.repository.SearchTaskMapper;
import com.hragent.service.RiskSuspectGuard;
import com.hragent.service.SearchTaskService;
import com.hragent.service.TaskQueueService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;

import java.time.LocalDateTime;
import java.util.List;

import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * {@link SearchTaskScheduler} 节拍门禁测试(2026-09-28 防"任务接力"):
 * 疑似拦截冻结期不认领;距上次任务执行不足 recommendGapMinutes 不认领;满足则认领。
 */
class SearchTaskSchedulerGateTest {

    private TaskQueueService queueService;
    private LiepinAccountMapper accountMapper;
    private SearchTaskMapper taskMapper;
    private HrAgentProperties properties;
    private RiskSuspectGuard guard;
    private SearchTaskScheduler scheduler;

    @BeforeEach
    void setUp() {
        queueService = mock(TaskQueueService.class);
        accountMapper = mock(LiepinAccountMapper.class);
        taskMapper = mock(SearchTaskMapper.class);
        properties = new HrAgentProperties();
        properties.getAutoRecruit().setRecommendGapMinutes(8);
        properties.getAutoRecruit().setRiskProbeBackoffMinutes(15);
        guard = new RiskSuspectGuard(properties);
        scheduler = new SearchTaskScheduler(queueService, mock(SearchTaskService.class),
                accountMapper, taskMapper, guard, properties);

        LiepinAccount account = new LiepinAccount();
        account.setId(1L);
        account.setName("测试账号");
        account.setLoginStatus("NORMAL");
        when(accountMapper.selectList(Mockito.any())).thenReturn(List.of(account));
    }

    @AfterEach
    void tearDown() {
        scheduler.shutdown();
    }

    @Test
    void holdingSuspectsBlockClaim() {
        guard.onRiskHit(1L); // 进入冻结退避

        scheduler.tick();

        verify(queueService, never()).claim(anyLong());
    }

    @Test
    void executionGapBlocksClaim() {
        when(taskMapper.selectLastExecutedAt(1L)).thenReturn(LocalDateTime.now().minusMinutes(2));

        scheduler.tick();

        verify(queueService, never()).claim(anyLong());
    }

    @Test
    void gapSatisfiedClaimsTask() {
        when(taskMapper.selectLastExecutedAt(1L)).thenReturn(LocalDateTime.now().minusMinutes(9));

        scheduler.tick();

        verify(queueService).claim(1L);
    }

    @Test
    void noHistoryClaimsImmediately() {
        when(taskMapper.selectLastExecutedAt(1L)).thenReturn(null);

        scheduler.tick();

        verify(queueService).claim(1L);
    }

    @Test
    void gapZeroDisablesGate() {
        properties.getAutoRecruit().setRecommendGapMinutes(0);
        when(taskMapper.selectLastExecutedAt(1L)).thenReturn(LocalDateTime.now().minusSeconds(5));

        scheduler.tick();

        verify(queueService).claim(1L);
    }
}
