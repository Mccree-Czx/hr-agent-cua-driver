package com.hragent.config;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.hragent.common.BizException;
import com.hragent.entity.AutoRecruitRound;
import com.hragent.entity.Jd;
import com.hragent.entity.LiepinAccount;
import com.hragent.entity.SearchTask;
import com.hragent.executor.CliException;
import com.hragent.executor.CuaDriverExecutor;
import com.hragent.repository.AppSettingMapper;
import com.hragent.repository.AutoRecruitRoundMapper;
import com.hragent.repository.JdMapper;
import com.hragent.repository.LiepinAccountMapper;
import com.hragent.repository.SearchTaskMapper;
import com.hragent.scoring.ScoringEngine;
import com.hragent.service.AutoRecruitSettingService;
import com.hragent.service.ChatPollService;
import com.hragent.service.GreetingService;
import com.hragent.service.RiskSuspectGuard;
import com.hragent.service.SearchTaskService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.InOrder;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.transaction.annotation.Transactional;

import java.time.Duration;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Supplier;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.atLeast;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.doReturn;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * AutoRecruitScheduler 节拍轮次测试(全部 mock 服务,真实 mapper/H2;2026-09-28 平摊改造)。
 *
 * <p>测试接缝:以虚拟时钟 + 空睡眠器替换生产的系统时钟/真实睡眠——轮次在虚拟 50 分钟窗口内
 * 瞬间跑完且间隔可断言(相邻动作 ≥ paceMillis)。全部用例 mock 服务层,mapper 走 H2。
 *
 * <p>语义基线:统一队列一 tick 一动作(会话&gt;列表刷新&gt;打招呼&gt;读取&gt;创建);
 * 过窗口即弃剩余;风控命中走"冻结-复测一次";互斥(定时重叠跳过、手动运行中拒绝)。
 */
@SpringBootTest
@ActiveProfiles("test")
@Transactional
class AutoRecruitSchedulerTest {

    @Autowired
    private AutoRecruitScheduler scheduler;

    @Autowired
    private HrAgentProperties properties;

    @Autowired
    private LiepinAccountMapper accountMapper;

    @Autowired
    private JdMapper jdMapper;

    @Autowired
    private SearchTaskMapper searchTaskMapper;

    @Autowired
    private AppSettingMapper settingMapper;

    @Autowired
    private AutoRecruitRoundMapper roundMapper;

    @Autowired
    private AutoRecruitSettingService settingService;

    @Autowired
    private RiskSuspectGuard riskSuspectGuard;

    @MockitoBean
    private SearchTaskService searchTaskService;

    @MockitoBean
    private ScoringEngine scoringEngine;

    @MockitoBean
    private GreetingService greetingService;

    @MockitoBean
    private ChatPollService chatPollService;

    /** 平台足迹计数器 mock:测试中由各服务桩的 Answer 模拟"触达平台即递增" */
    @MockitoBean
    private CuaDriverExecutor cliExecutor;

    private Long accountId;

    /** 周一 10:00(运行时段内;每天执行,时段判定与星期无关) */
    private static final LocalDateTime WORK_TIME = LocalDateTime.of(2026, 9, 28, 10, 0);

    /** 虚拟时钟(与 scheduler/guard 测试接缝同步) */
    private LocalDateTime virtualNow;

    private Supplier<LocalDateTime> originalClock;

    private AutoRecruitScheduler.Sleeper originalSleeper;

    private Supplier<LocalDateTime> originalGuardClock;

    @BeforeEach
    void setUp() {
        searchTaskMapper.delete(new LambdaQueryWrapper<>());
        jdMapper.delete(new LambdaQueryWrapper<>());
        accountMapper.delete(new LambdaQueryWrapper<>());
        settingMapper.delete(new LambdaQueryWrapper<>());
        properties.getAutoRecruit().setEnabled(true); // 种子默认开启(库清空后由 isEnabled() 落库)
        properties.getAutoRecruit().setGreetBatchLimit(5);
        properties.getAutoRecruit().setSpreadMinutes(50);
        properties.getAutoRecruit().setPaceMillis(30_000);
        properties.getAutoRecruit().setMaxPaceMillis(120_000);
        properties.getAutoRecruit().setPollListIntervalMinutes(60); // 默认单次刷新,安静用例可提前收尾
        properties.getAutoRecruit().setRecommendGapMinutes(8);
        properties.getAutoRecruit().setRiskProbeBackoffMinutes(15);
        accountId = null;

        // 虚拟时钟:轮次与守卫共用;睡眠仅推进虚拟时间
        virtualNow = WORK_TIME;
        originalClock = scheduler.clock;
        originalSleeper = scheduler.sleeper;
        originalGuardClock = riskSuspectGuard.clock;
        scheduler.clock = () -> virtualNow;
        scheduler.sleeper = millis -> virtualNow = virtualNow.plusNanos(millis * 1_000_000L);
        riskSuspectGuard.clock = () -> virtualNow;
    }

    @AfterEach
    void restoreSeams() {
        scheduler.clock = originalClock;
        scheduler.sleeper = originalSleeper;
        riskSuspectGuard.clock = originalGuardClock;
    }

    private Long createAccount() {
        LiepinAccount account = new LiepinAccount();
        account.setName("测试账号");
        account.setLoginStatus("NORMAL");
        account.setCircuitBreaker(false);
        accountMapper.insert(account);
        accountId = account.getId();
        return accountId;
    }

    private Jd createActiveJd(String liepinJobId) {
        Jd jd = new Jd();
        jd.setTitle("Java 后端工程师");
        jd.setStatus("ACTIVE");
        jd.setLiepinJobId(liepinJobId);
        jdMapper.insert(jd);
        return jd;
    }

    private void insertTask(Long jdId, String status) {
        SearchTask task = new SearchTask();
        task.setJdId(jdId);
        task.setAccountId(accountId);
        task.setTaskType("RECOMMEND");
        task.setKeywords("t");
        task.setStatus(status);
        task.setRetryCount(0);
        searchTaskMapper.insert(task);
    }

    private JsonNode sessionNode(String imId) {
        try {
            return new ObjectMapper().readTree("{\"im_id\":\"" + imId + "\",\"direction\":\"0\",\"name\":\"候选人\"}");
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    /** UI 通道会话节点(驱动 records 真实形态:无 im_id,仅 name/角标/最后消息;2026-09-30 C6) */
    private JsonNode uiSessionNode(String name) {
        try {
            return new ObjectMapper().readTree("{\"name\":\"" + name
                    + "\",\"unread_count\":2,\"last_msg\":\"这是我的简历，合适的话可以随时联系我～\"}");
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private JsonNode lastRun() {
        return settingService.lastRun().orElseThrow();
    }

    private AutoRecruitRound onlyRound() {
        List<AutoRecruitRound> rounds = roundMapper.selectList(new LambdaQueryWrapper<>());
        assertEquals(1, rounds.size(), "每轮结束应写入一条轮次历史");
        return rounds.get(0);
    }

    // ---------- isRunWindow / nextRunAt 边界 ----------

    @Test
    void isRunWindowBoundaries() {
        // 2026-09-29 起时段延长为 06:00–23:00(原有周末同执行不变)
        assertTrue(AutoRecruitScheduler.isRunWindow(LocalDateTime.of(2026, 9, 25, 23, 59)), "周五23:59应为true");
        assertTrue(AutoRecruitScheduler.isRunWindow(LocalDateTime.of(2026, 9, 25, 6, 0)), "周五6:00应为true");
        assertFalse(AutoRecruitScheduler.isRunWindow(LocalDateTime.of(2026, 9, 25, 5, 59)), "周五5:59应为false");
        assertTrue(AutoRecruitScheduler.isRunWindow(LocalDateTime.of(2026, 9, 26, 10, 0)), "周六应为true(每天执行)");
        assertTrue(AutoRecruitScheduler.isRunWindow(LocalDateTime.of(2026, 9, 27, 6, 0)), "周日6:00应为true(每天执行)");
        assertTrue(AutoRecruitScheduler.isRunWindow(LocalDateTime.of(2026, 9, 28, 22, 0)), "周一22:00应为true");
        assertFalse(AutoRecruitScheduler.isRunWindow(LocalDateTime.of(2026, 9, 28, 5, 59)), "周一5:59应为false");
        assertFalse(AutoRecruitScheduler.isRunWindow(null), "null应为false");
    }

    @Test
    void nextRunAtBoundaries() {
        assertEquals(LocalDateTime.of(2026, 9, 26, 6, 0),
                AutoRecruitScheduler.nextRunAt(LocalDateTime.of(2026, 9, 26, 5, 59)), "5:59→当日6:00");
        assertEquals(LocalDateTime.of(2026, 9, 26, 7, 0),
                AutoRecruitScheduler.nextRunAt(LocalDateTime.of(2026, 9, 26, 6, 0)), "6:00→7:00(严格晚于)");
        assertEquals(LocalDateTime.of(2026, 9, 26, 23, 0),
                AutoRecruitScheduler.nextRunAt(LocalDateTime.of(2026, 9, 26, 22, 30)), "22:30→23:00");
        assertEquals(LocalDateTime.of(2026, 9, 27, 6, 0),
                AutoRecruitScheduler.nextRunAt(LocalDateTime.of(2026, 9, 26, 23, 0)), "23:00→次日6:00");
        assertEquals(LocalDateTime.of(2026, 9, 27, 6, 0),
                AutoRecruitScheduler.nextRunAt(LocalDateTime.of(2026, 9, 27, 3, 30)), "3:30→当日6:00");
        assertNull(AutoRecruitScheduler.nextRunAt(null), "null→null");
    }

    // ---------- 时段 / 账号门禁 ----------

    @Test
    void outsideRunWindowDoesNothing() {
        createAccount();
        createActiveJd("123");

        scheduler.runRound(LocalDateTime.of(2026, 9, 26, 19, 0)); // 周六 19:00(时段外)

        verify(chatPollService, never()).fetchSessions(any());
        verify(scoringEngine, never()).scoreNext(anyLong(), anyInt());
        verify(greetingService, never()).greetPassed(anyLong(), anyInt());
        verify(searchTaskService, never()).createRecommendTask(anyLong(), anyLong());
    }

    @Test
    void noAccountDoesNotCreateTask() {
        createActiveJd("123");

        scheduler.runRound(WORK_TIME);

        verify(chatPollService, never()).fetchSessions(any());
        verify(searchTaskService, never()).createRecommendTask(anyLong(), anyLong());
        JsonNode lastRun = lastRun();
        assertTrue(lastRun.path("noAccount").asBoolean(), "无账号轮次摘要应标记 noAccount");
    }

    // ---------- 运行时开关:OFF = 只收不联 ----------

    @Test
    void switchOffRunsCollectOnlyMode() {
        settingService.setEnabled(false);
        createAccount();
        Jd jd = createActiveJd("123");

        scheduler.runRound(WORK_TIME);

        // 只收:检测/评分/拉推荐照常
        verify(chatPollService).fetchSessions(any());
        verify(scoringEngine).scoreNext(jd.getId(), 1);
        verify(searchTaskService).createRecommendTask(jd.getId(), accountId);
        // 不联:打招呼绝不发生
        verify(greetingService, never()).greetPassed(anyLong(), anyInt());
        // 摘要体现只收模式
        JsonNode lastRun = lastRun();
        assertEquals("collectOnly", lastRun.path("mode").asText());
        assertEquals(0, lastRun.path("greeted").asInt());
    }

    @Test
    void switchOnRunsFullMode() {
        // 默认种子开启(见 setUp)
        createAccount();
        Jd jd = createActiveJd("123");

        scheduler.runRound(WORK_TIME);

        verify(greetingService).greetPassed(jd.getId(), 1);
        assertEquals("full", lastRun().path("mode").asText());
    }

    // ---------- 轮次互斥 ----------

    @Test
    void hourlySkipsWhenRoundAlreadyRunning() {
        createAccount();
        Jd jd1 = createActiveJd("111");
        Jd jd2 = createActiveJd("222");
        // 第一岗读取时嵌套触发一轮(模拟整点重叠)→ 应被互斥挡下
        doAnswer(invocation -> {
            scheduler.runRound(virtualNow);
            return 1;
        }).doReturn(0).when(scoringEngine).scoreNext(jd1.getId(), 1);
        // 第二岗读取时嵌套手动触发 → 应抛出"运行中"拒绝
        doAnswer(invocation -> {
            assertThrows(BizException.class, () -> scheduler.runRoundInternal());
            return 1;
        }).doReturn(0).when(scoringEngine).scoreNext(jd2.getId(), 1);

        scheduler.runRound(WORK_TIME);

        verify(chatPollService, times(1)).fetchSessions(any()); // 嵌套轮次未执行
        assertFalse(scheduler.isRunning(), "轮次结束后互斥标志应释放");
        assertNull(scheduler.getRunningSince(), "轮次结束后 runningSince 应为 null");
    }

    // ---------- 防重叠(岗位任务) ----------

    @Test
    void skipCreateWhenTaskInFlight() {
        createAccount();
        Jd jd = createActiveJd("123");
        insertTask(jd.getId(), "QUEUED");

        scheduler.runRound(WORK_TIME);

        // 存量处理仍执行,但不重复创建在途任务
        verify(scoringEngine).scoreNext(jd.getId(), 1);
        verify(greetingService).greetPassed(jd.getId(), 1);
        verify(searchTaskService, never()).createRecommendTask(anyLong(), anyLong());
    }

    @Test
    void skipCreateWhenTaskRunning() {
        createAccount();
        Jd jd = createActiveJd("123");
        insertTask(jd.getId(), "RUNNING");

        scheduler.runRound(WORK_TIME);

        verify(searchTaskService, never()).createRecommendTask(anyLong(), anyLong());
    }

    // ---------- 节拍优先级:会话 → 列表刷新 → 打招呼 → 读取 → 创建 ----------

    @Test
    void processesUnitsInPriorityOrder() {
        createAccount();
        Jd jd = createActiveJd("123");

        scheduler.runRound(WORK_TIME);

        InOrder order = inOrder(chatPollService, greetingService, scoringEngine, searchTaskService);
        order.verify(chatPollService).fetchSessions(any());
        order.verify(greetingService).greetPassed(jd.getId(), 1);
        order.verify(scoringEngine).scoreNext(jd.getId(), 1);
        order.verify(searchTaskService).createRecommendTask(jd.getId(), accountId);
    }

    @Test
    void pacingFloorBetweenActions() {
        createAccount();
        createActiveJd("123");
        AtomicLong seq = new AtomicLong();
        List<LocalDateTime> actionTimes = new ArrayList<>();
        when(cliExecutor.spawnSeq()).thenAnswer(inv -> seq.get());
        when(chatPollService.fetchSessions(any())).thenAnswer(inv -> {
            seq.incrementAndGet();
            actionTimes.add(virtualNow);
            return List.of();
        });
        when(greetingService.greetPassed(anyLong(), anyInt())).thenAnswer(inv -> {
            seq.incrementAndGet();
            actionTimes.add(virtualNow);
            return 0;
        });
        when(scoringEngine.scoreNext(anyLong(), anyInt())).thenAnswer(inv -> {
            seq.incrementAndGet();
            actionTimes.add(virtualNow);
            return 0;
        });
        when(searchTaskService.createRecommendTask(anyLong(), anyLong())).thenAnswer(inv -> {
            seq.incrementAndGet();
            actionTimes.add(virtualNow);
            return null;
        });

        scheduler.runRound(WORK_TIME);

        assertTrue(actionTimes.size() >= 4, "至少应执行 列表/招呼/读取/创建 四类平台动作");
        for (int i = 1; i < actionTimes.size(); i++) {
            Duration gap = Duration.between(actionTimes.get(i - 1), actionTimes.get(i));
            assertTrue(gap.getSeconds() >= 30,
                    "平台动作相邻间隔应 ≥ paceMillis(30s),实际 " + gap + "(动作 " + (i - 1) + "→" + i + ")");
        }
    }

    @Test
    void noOpSessionUnitsDoNotConsumePlatformPacing() {
        createAccount();
        createActiveJd("123");
        AtomicLong seq = new AtomicLong();
        when(cliExecutor.spawnSeq()).thenAnswer(inv -> seq.get());
        when(chatPollService.fetchSessions(any())).thenAnswer(inv -> {
            seq.incrementAndGet();
            return List.of(sessionNode("n1"), sessionNode("n2"), sessionNode("n3"));
        });
        List<LocalDateTime> noOpTimes = new ArrayList<>();
        when(chatPollService.handleSession(any(), any())).thenAnswer(inv -> {
            noOpTimes.add(virtualNow); // 未递增 seq:纯记账会话(空转)
            return false;
        });

        scheduler.runRound(WORK_TIME);

        assertEquals(3, noOpTimes.size());
        for (int i = 1; i < noOpTimes.size(); i++) {
            assertTrue(Duration.between(noOpTimes.get(i - 1), noOpTimes.get(i)).getSeconds() <= 5,
                    "纯记账会话单元应秒级快速通过,不占用平台节拍");
        }
    }

    // ---------- UI 通道(无 im_id)会话入队/去重(2026-09-30 C6) ----------

    @Test
    void uiChannelSessionsWithoutImIdAreQueuedAndProcessed() {
        createAccount();
        createActiveJd("123");
        when(chatPollService.fetchSessions(any()))
                .thenReturn(List.of(uiSessionNode("潘女士"), uiSessionNode("王思又")));
        List<String> handled = new ArrayList<>();
        when(chatPollService.handleSession(any(), any())).thenAnswer(inv -> {
            JsonNode session = inv.getArgument(1);
            handled.add(session.path("name").asText(""));
            return false;
        });

        scheduler.runRound(WORK_TIME);

        assertEquals(List.of("潘女士", "王思又"), handled, "UI 会话(无 im_id)应按会话名键入队并处理");
        verify(chatPollService, times(2)).handleSession(any(), any());
    }

    @Test
    void uiChannelSessionDedupedByNameKeyAcrossListRefreshes() {
        createAccount();
        createActiveJd("123");
        properties.getAutoRecruit().setPollListIntervalMinutes(15);
        when(chatPollService.fetchSessions(any())).thenReturn(List.of(uiSessionNode("潘女士")));
        AtomicInteger handled = new AtomicInteger();
        when(chatPollService.handleSession(any(), any())).thenAnswer(inv -> {
            handled.incrementAndGet();
            return false;
        });

        scheduler.runRound(WORK_TIME);

        assertEquals(1, handled.get(), "同一 UI 会话(无 im_id)多次列表刷新后只应处理一次");
    }

    @Test
    void pollListRefreshFollowsCadence() {
        createAccount();
        createActiveJd("123");
        properties.getAutoRecruit().setPollListIntervalMinutes(15);
        when(chatPollService.fetchSessions(any())).thenReturn(List.of());

        scheduler.runRound(WORK_TIME);

        verify(chatPollService, atLeast(3)).fetchSessions(any());
    }

    // ---------- 单岗位失败隔离 ----------

    @Test
    void singleJdFailureDoesNotBlockNextJd() {
        createAccount();
        Jd jd1 = createActiveJd("111");
        Jd jd2 = createActiveJd("222");
        doThrow(new RuntimeException("模拟单岗位异常")).when(scoringEngine).scoreNext(jd1.getId(), 1);

        scheduler.runRound(WORK_TIME);

        verify(scoringEngine).scoreNext(jd1.getId(), 1);
        verify(scoringEngine).scoreNext(jd2.getId(), 1);
        // 读取失败只隔离该单元;其余单元(含创建推荐)照常
        verify(searchTaskService).createRecommendTask(jd1.getId(), accountId);
        verify(searchTaskService).createRecommendTask(jd2.getId(), accountId);
        assertEquals(1, lastRun().path("errors").asInt(), "单岗位失败应计入摘要 errors");
    }

    // ---------- 风控:无冻结态 → 真实熔断中止;有冻结态 → 复测一次 ----------

    @Test
    void riskControlWithoutSuspectStateAbortsRound() {
        createAccount();
        Jd jd = createActiveJd("123");
        doThrow(new CliException(CliException.Type.RISK_CONTROL, "安全验证"))
                .when(scoringEngine).scoreNext(jd.getId(), 1);

        assertThrows(CliException.class, () -> scheduler.runRound(WORK_TIME), "风控异常应上抛(不吞掉)");
        JsonNode lastRun = lastRun();
        assertTrue(lastRun.path("riskStopped").asBoolean(), "风控停止应写入摘要");
        assertFalse(scheduler.isRunning(), "异常后互斥标志应释放");
    }

    @Test
    void riskFreezeThenProbeSuccessContinuesRound() {
        createAccount();
        Jd jd = createActiveJd("123");
        // 首次读:命令层已进入冻结(守卫持有冻结态)后抛风控;复测(重放)返回 1;其后耗尽返回 0
        doAnswer(invocation -> {
            riskSuspectGuard.onRiskHit(accountId);
            throw new CliException(CliException.Type.RISK_CONTROL, "安全验证");
        }).doReturn(1).doReturn(0).when(scoringEngine).scoreNext(jd.getId(), 1);

        scheduler.runRound(WORK_TIME);

        JsonNode lastRun = lastRun();
        assertFalse(lastRun.path("riskStopped").asBoolean(), "首次命中不应熔断(冻结+复测通过)");
        assertEquals(1, lastRun.path("suspects").asInt(), "应记录一次冻结退避");
        assertEquals(1, lastRun.path("scored").asInt(), "复测成功应计入评分");
        assertEquals(1, lastRun.path("recommended").asInt(), "轮次应继续执行到创建推荐");
        assertTrue(Duration.between(WORK_TIME, virtualNow).toMinutes() >= 15,
                "冻结退避应等待满 15 分钟后才复测");
    }

    @Test
    void riskFreezeThenSecondHitAbortsRound() {
        createAccount();
        Jd jd = createActiveJd("123");
        // 首次命中冻结;复测(重放)再次命中 → 真实熔断中止
        doAnswer(invocation -> {
            riskSuspectGuard.onRiskHit(accountId);
            throw new CliException(CliException.Type.RISK_CONTROL, "安全验证");
        }).when(scoringEngine).scoreNext(jd.getId(), 1);

        assertThrows(CliException.class, () -> scheduler.runRound(WORK_TIME));

        JsonNode lastRun = lastRun();
        assertTrue(lastRun.path("riskStopped").asBoolean(), "复测再次命中应熔断中止");
        assertEquals(1, lastRun.path("suspects").asInt());
        verify(searchTaskService, never()).createRecommendTask(anyLong(), anyLong());
        assertTrue(Duration.between(WORK_TIME, virtualNow).toMinutes() >= 15,
                "复测前应等待冻结期");
    }

    // ---------- 平摊窗口:硬停与弃片 ----------

    @Test
    void windowHardStopAbandonsRemainingUnits() {
        createAccount();
        for (int i = 0; i < 5; i++) {
            createActiveJd(String.valueOf(100 + i));
        }
        when(chatPollService.fetchSessions(any())).thenReturn(List.of());
        when(scoringEngine.scoreNext(anyLong(), eq(1))).thenReturn(1); // 永不耗尽 → 必须靠窗口硬停

        scheduler.runRound(WORK_TIME);

        JsonNode lastRun = lastRun();
        assertTrue(lastRun.path("abandoned").asInt() > 0, "窗口结束时应记录顺延下轮的剩余单元数");
        AutoRecruitRound round = onlyRound();
        assertEquals(50, Duration.between(round.getStartedAt(), round.getFinishedAt()).toMinutes(),
                "轮次应在 50 分钟窗口处硬停");
        assertFalse(scheduler.isRunning());
    }

    // ---------- 手动补跑:运行中拒绝 + 窗口规则 ----------

    @Test
    void manualRoundRejectedNearHourEnd() {
        virtualNow = LocalDateTime.of(2026, 9, 28, 10, 55);

        assertThrows(BizException.class, () -> scheduler.runRoundInternal(),
                "距下一整点不足 10 分钟应拒绝补跑");
    }

    @Test
    void manualRoundCappedByNextHourGuard() {
        virtualNow = LocalDateTime.of(2026, 9, 28, 10, 30);
        createAccount();
        createActiveJd("123");
        when(chatPollService.fetchSessions(any())).thenReturn(List.of());
        when(scoringEngine.scoreNext(anyLong(), eq(1))).thenReturn(1); // 永不耗尽 → 由窗口截止

        scheduler.runRoundInternal();

        AutoRecruitRound round = onlyRound();
        assertEquals(LocalDateTime.of(2026, 9, 28, 10, 30), round.getStartedAt());
        assertEquals(20, Duration.between(round.getStartedAt(), round.getFinishedAt()).toMinutes(),
                "手动补跑窗口应被\"距下一整点 10 分钟\"封顶");
    }

    // ---------- 配置生效 ----------

    @Test
    void greetBatchLimitPassedThrough() {
        createAccount();
        Jd jd = createActiveJd("123");
        properties.getAutoRecruit().setGreetBatchLimit(7);
        when(greetingService.greetPassed(jd.getId(), 1)).thenReturn(1);

        scheduler.runRound(WORK_TIME);

        verify(greetingService, times(7)).greetPassed(jd.getId(), 1);
        assertEquals(7, lastRun().path("greeted").asInt());
    }

    @Test
    void invalidLiepinJobIdSkipped() {
        createAccount();
        createActiveJd("abc");

        scheduler.runRound(WORK_TIME);

        verify(scoringEngine, never()).scoreNext(anyLong(), anyInt());
        verify(searchTaskService, never()).createRecommendTask(anyLong(), anyLong());
    }

    // ---------- 摘要计数 ----------

    @Test
    void summarySavesCountsAfterRound() {
        createAccount();
        Jd jd = createActiveJd("123");
        when(chatPollService.fetchSessions(any())).thenReturn(List.of(
                sessionNode("s1"), sessionNode("s2"), sessionNode("s3"), sessionNode("s4"),
                sessionNode("s5"), sessionNode("s6"), sessionNode("s7")));
        when(chatPollService.handleSession(any(), any())).thenReturn(true);
        when(scoringEngine.scoreNext(jd.getId(), 1)).thenReturn(1, 1, 0);
        when(greetingService.greetPassed(jd.getId(), 1)).thenReturn(1, 1, 1, 0);

        scheduler.runRound(WORK_TIME);

        JsonNode lastRun = lastRun();
        assertEquals("full", lastRun.path("mode").asText());
        assertEquals(7, lastRun.path("polled").asInt());
        assertEquals(2, lastRun.path("scored").asInt());
        assertEquals(3, lastRun.path("greeted").asInt());
        assertEquals(1, lastRun.path("recommended").asInt());
        assertEquals(0, lastRun.path("errors").asInt());
        assertFalse(lastRun.path("riskStopped").asBoolean());
        assertFalse(lastRun.path("noAccount").asBoolean());
    }

    // ---------- 轮次历史落库(运行日志页,2026-09-28) ----------

    @Test
    void roundHistoryRecordedAfterRun() {
        createAccount();
        Jd jd = createActiveJd("123");
        when(chatPollService.fetchSessions(any())).thenReturn(List.of(
                sessionNode("a"), sessionNode("b"), sessionNode("c"), sessionNode("d")));
        when(chatPollService.handleSession(any(), any())).thenReturn(true);
        when(scoringEngine.scoreNext(jd.getId(), 1)).thenReturn(1, 0);
        when(greetingService.greetPassed(jd.getId(), 1)).thenReturn(1, 0);

        scheduler.runRound(WORK_TIME);

        AutoRecruitRound round = onlyRound();
        assertEquals("full", round.getMode());
        assertEquals(4, round.getPolled());
        assertEquals(1, round.getScored());
        assertEquals(1, round.getGreeted());
        assertFalse(round.getRiskStopped());
        assertFalse(round.getNoAccount());
        assertNotNull(round.getFinishedAt());
        assertNotNull(round.getStatsJson());
    }

    // ---------- 冷却机制已移除(2026-09-28 剔除) ----------

    @Test
    void recentRiskResetNoLongerBlocksOutbound() {
        Long id = createAccount();
        LiepinAccount account = accountMapper.selectById(id);
        account.setRiskResetAt(LocalDateTime.now().minusMinutes(5)); // 历史字段:不再具备任何门禁语义
        accountMapper.updateById(account);
        Jd jd = createActiveJd("123");
        when(chatPollService.fetchSessions(any())).thenReturn(List.of(
                sessionNode("s1"), sessionNode("s2")));
        when(chatPollService.handleSession(any(), any())).thenReturn(true);
        when(scoringEngine.scoreNext(jd.getId(), 1)).thenReturn(1, 0);
        when(greetingService.greetPassed(jd.getId(), 1)).thenReturn(1, 0);

        scheduler.runRound(WORK_TIME);

        JsonNode lastRun = lastRun();
        assertEquals("full", lastRun.path("mode").asText(), "重置后不再进入冷却模式");
        assertEquals(2, lastRun.path("polled").asInt());
        assertEquals(1, lastRun.path("greeted").asInt(), "带近期重置时刻时外发仍正常执行");
    }
}
