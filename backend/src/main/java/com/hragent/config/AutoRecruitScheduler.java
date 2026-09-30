package com.hragent.config;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.hragent.common.BizException;
import com.hragent.entity.AutoRecruitRound;
import com.hragent.entity.Jd;
import com.hragent.entity.LiepinAccount;
import com.hragent.entity.SearchTask;
import com.hragent.executor.CliException;
import com.hragent.executor.CuaDriverExecutor;
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
import lombok.extern.slf4j.Slf4j;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;
import java.time.ZoneId;
import java.time.temporal.ChronoUnit;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Supplier;

/**
 * 自动招聘闭环定时编排(2026-09-26 运行时开关;2026-09-28 节拍改造"50 分钟平摊")。
 *
 * <ul>
 *     <li><b>调度</b>:北京时间每天 06:00–23:00 每整点启动一轮(含 23:00,周末与节假日同样执行);
 *         轮次在 {@code spreadMinutes}(默认 50)窗口内<b>匀速</b>执行全部平台动作,到期未完成顺延下轮
 *         (各动作幂等,下轮自然补做;不再有"整点暴发")</li>
 *     <li><b>节拍</b>:统一队列一 tick 一动作;优先级 会话处理&gt;列表刷新&gt;打招呼&gt;简历读取&gt;推荐创建;
 *         间隔自适应 = clamp(剩余窗口/剩余单元, paceMillis, maxPaceMillis)</li>
 *     <li><b>中断语义</b>:全部墙钟判定;睡眠/重启越过窗口(或整点)即弃剩余单元,不自动续跑</li>
 *     <li><b>疑似拦截</b>:命中风控特征先冻结退避({@link RiskSuspectGuard}),到期复测一次;
 *         再命中才熔断中止整轮;冻结跨越窗口则本轮就地收尾</li>
 *     <li><b>运行时开关</b>:OFF 只停主动外发(打招呼/索要),检测/附件/评分/拉推荐照常</li>
 *     <li><b>防重叠</b>:岗位已有 QUEUED/RUNNING 任务则跳过拉新;轮次级互斥(定时重叠跳过、手动触发拒绝)</li>
 *     <li><b>手动补跑</b>:运行中拒绝;空闲触发按 min(平摊窗口, 距下一整点-10 分钟) 平摊,不足 10 分钟拒绝</li>
 *     <li>每轮结束写入运行摘要({@code auto_recruit.last_run})与轮次历史({@code auto_recruit_round})</li>
 * </ul>
 */
@Slf4j
@Component
public class AutoRecruitScheduler {

    /** 运行时段时区(北京时间) */
    private static final ZoneId ZONE = ZoneId.of("Asia/Shanghai");
    /** 运行时段起点(含;2026-09-29 起 06:00–23:00) */
    private static final LocalTime WINDOW_START = LocalTime.of(6, 0);
    /** 运行时段终点(含),整点触发由 cron 保证 */
    private static final LocalTime WINDOW_END = LocalTime.of(23, 59, 59);
    /** 运行时段首/末整点(与 cron 6-23 对齐,nextRunAt 计算用) */
    private static final int FIRST_HOUR = 6;
    private static final int LAST_HOUR = 23;
    /** 等待类睡眠的分段粒度(毫秒):保证墙钟判定与收尾响应的及时性 */
    private static final long SLEEP_CHUNK_MILLIS = 60_000;

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private final HrAgentProperties properties;
    private final LiepinAccountMapper accountMapper;
    private final JdMapper jdMapper;
    private final SearchTaskMapper searchTaskMapper;
    private final SearchTaskService searchTaskService;
    private final ScoringEngine scoringEngine;
    private final GreetingService greetingService;
    private final ChatPollService chatPollService;
    private final AutoRecruitSettingService settingService;
    private final AutoRecruitRoundMapper roundMapper;
    private final RiskSuspectGuard riskSuspectGuard;
    private final CuaDriverExecutor cliExecutor;

    /** 轮次互斥:同一时刻仅允许一轮(定时重叠跳过,手动触发拒绝) */
    private final AtomicBoolean running = new AtomicBoolean(false);
    private volatile LocalDateTime runningSince;

    /** 测试接缝:时间源(生产=系统时钟;同包测试可替换为虚拟时钟) */
    Supplier<LocalDateTime> clock = () -> LocalDateTime.now(ZONE);

    /** 测试接缝:睡眠器(生产=真实睡眠;同包测试可替换为"仅推进虚拟时钟") */
    Sleeper sleeper = millis -> {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    };

    /** 睡眠器接口(不抛中断:由实现方恢复中断标记) */
    @FunctionalInterface
    interface Sleeper {
        void sleep(long millis);
    }

    /** 可抛异常的动作(单元执行体) */
    @FunctionalInterface
    private interface UnitAction {
        void run() throws Exception;
    }

    public AutoRecruitScheduler(HrAgentProperties properties, LiepinAccountMapper accountMapper,
                                JdMapper jdMapper, SearchTaskMapper searchTaskMapper,
                                SearchTaskService searchTaskService, ScoringEngine scoringEngine,
                                GreetingService greetingService, ChatPollService chatPollService,
                                AutoRecruitSettingService settingService, AutoRecruitRoundMapper roundMapper,
                                RiskSuspectGuard riskSuspectGuard, CuaDriverExecutor cliExecutor) {
        this.properties = properties;
        this.accountMapper = accountMapper;
        this.jdMapper = jdMapper;
        this.searchTaskMapper = searchTaskMapper;
        this.searchTaskService = searchTaskService;
        this.scoringEngine = scoringEngine;
        this.greetingService = greetingService;
        this.chatPollService = chatPollService;
        this.settingService = settingService;
        this.roundMapper = roundMapper;
        this.riskSuspectGuard = riskSuspectGuard;
        this.cliExecutor = cliExecutor;
    }

    /** 每天 06:00–23:00 每整点启动一轮(周末与节假日同样执行) */
    @Scheduled(cron = "${hr-agent.auto-recruit.round-cron:0 0 6-23 * * *}", zone = "Asia/Shanghai")
    public void hourly() {
        runRound();
    }

    /**
     * 4-5 星专道窗口(2026-09-29):每小时 :51–:59 发送 star≥4 未招呼队列,不占轮内预算;
     * 逐条受 60s 账号级节奏自然封顶(单窗 ≈8-9 条);溢出留待下一轮轮内按预算插发。
     * 自动外发总闸 OFF 时不外发;真实熔断信号直接中止本窗(不复测,避免自伤)。
     */
    @Scheduled(cron = "${hr-agent.auto-recruit.star-tail-cron:0 51 6-22 * * *}", zone = "Asia/Shanghai")
    public void starTailWindow() {
        LocalDateTime now = clock.get();
        if (!settingService.isEnabled()) {
            log.info("专道窗口:自动外发已关闭,跳过");
            return;
        }
        if (running.get()) {
            log.warn("专道窗口:轮次仍在运行,本窗顺延");
            return;
        }
        LiepinAccount account = accountMapper.selectOne(new LambdaQueryWrapper<LiepinAccount>()
                .eq(LiepinAccount::getLoginStatus, "NORMAL")
                .orderByAsc(LiepinAccount::getId)
                .last("LIMIT 1"));
        if (account == null) {
            log.warn("专道窗口:无可用猎聘账号,跳过");
            return;
        }
        LocalDateTime deadline = now.truncatedTo(ChronoUnit.HOURS).plusMinutes(60);
        int sentTotal = 0;
        try {
            while (clock.get().isBefore(deadline)) {
                int sent = greetingService.greetStarLane(5);
                if (sent <= 0) {
                    log.info("专道窗口:4-5 星队列已清空(本次发送 {})", sentTotal);
                    return;
                }
                sentTotal += sent;
                sleepUntil(clock.get().plusSeconds(5), deadline);
            }
            log.info("专道窗口结束:本次发送 4-5 星 {} 人", sentTotal);
        } catch (CliException e) {
            if (e.getType() == CliException.Type.RISK_CONTROL) {
                log.error("专道窗口:检测到风控信号,中止本窗(账号已按既有链路标记): {}", e.getMessage());
            } else {
                log.warn("专道窗口:发送失败,中止本窗: {}", e.getMessage());
            }
        }
    }

    /**
     * 4-5 星溢出判定基准(2026-09-29):早于该时刻评分且仍未打招呼者,视为「跨专道窗口未发出」,
     * 轮内按预算插发。基准=上一小时 :51(专道窗口起点);若落在 06:00 之前,回退为昨日 22:51。
     */
    static LocalDateTime starOverflowCutoff(LocalDateTime now) {
        LocalDateTime prevWindow = now.withMinute(51).withSecond(0).withNano(0).minusHours(1);
        if (prevWindow.getHour() < FIRST_HOUR) {
            return now.toLocalDate().minusDays(1).atTime(22, 51);
        }
        return prevWindow;
    }

    /** 执行一轮(对外可直调;时间取当前时刻) */
    public void runRound() {
        runRound(clock.get());
    }

    /**
     * 定时执行一轮:时段门禁 → 互斥检查 → 按平摊窗口执行。
     * 窗口 = 启动时刻 + {@code spreadMinutes}(默认 50 分钟,整点启动即 :00→:50)。
     */
    void runRound(LocalDateTime now) {
        if (!isRunWindow(now)) {
            log.debug("非运行时段({}),本轮跳过", now);
            return;
        }
        if (running.get()) {
            log.warn("自动招聘:上一轮仍在运行,本轮跳过(防重叠)");
            return;
        }
        executeRound(now, now.plusMinutes(spreadMinutes()));
    }

    /**
     * 手动执行一轮(ADMIN 补跑/联调):绕过时段门禁、不受外发开关限制,
     * 但仍受轮次互斥约束——已有轮次运行中则拒绝(长轮次期间不再允许插队)。
     * 窗口 = min(平摊窗口, 距下一整点 10 分钟缓冲),不足 10 分钟拒绝。
     */
    public void runRoundInternal() {
        if (running.get()) {
            throw BizException.badRequest("已有轮次正在运行,请稍后再试");
        }
        LocalDateTime start = clock.get();
        LocalDateTime spreadEnd = start.plusMinutes(spreadMinutes());
        LocalDateTime hourGuard = start.truncatedTo(ChronoUnit.HOURS).plusHours(1).minusMinutes(10);
        LocalDateTime deadline = spreadEnd.isBefore(hourGuard) ? spreadEnd : hourGuard;
        if (Duration.between(start, deadline).toMinutes() < 10) {
            throw BizException.badRequest("距离下一整点不足 10 分钟,请稍后再补跑");
        }
        executeRound(start, deadline);
    }

    /**
     * 单轮编排主体(节拍循环)。
     * 运行时开关语义:OFF 只停主动外发(打招呼;索要门禁在 ChatPollService 内),
     * 检测回复/已读、附件下载、评分、拉推荐照常;每轮结束写运行摘要与轮次历史。
     */
    private void executeRound(LocalDateTime startAt, LocalDateTime deadline) {
        running.set(true);
        runningSince = startAt;
        boolean enabled = settingService.isEnabled();
        RoundStats stats = new RoundStats(enabled ? "full" : "collectOnly");
        try {
            // 取第一个 NORMAL 账号(多账号轮询分配待确认,设计 §7)
            LiepinAccount account = accountMapper.selectOne(new LambdaQueryWrapper<LiepinAccount>()
                    .eq(LiepinAccount::getLoginStatus, "NORMAL")
                    .orderByAsc(LiepinAccount::getId)
                    .last("LIMIT 1"));
            if (account == null) {
                log.warn("自动招聘:无可用猎聘账号(login_status=NORMAL),本轮跳过");
                stats.noAccount = true;
                return;
            }

            scoringEngine.beginRound();
            chatPollService.beginRound();

            List<Jd> validJds = new ArrayList<>();
            for (Jd jd : jdMapper.selectList(new LambdaQueryWrapper<Jd>()
                    .eq(Jd::getStatus, "ACTIVE")
                    .isNotNull(Jd::getLiepinJobId)
                    .ne(Jd::getLiepinJobId, "")
                    .orderByAsc(Jd::getId))) {
                if (jd.getLiepinJobId() == null || !jd.getLiepinJobId().matches("[1-9]\\d*")) {
                    log.debug("自动招聘:岗位 {} 猎聘职位 ID 无效({}),跳过", jd.getId(), jd.getLiepinJobId());
                    continue;
                }
                validJds.add(jd);
            }
            RoundWork work = new RoundWork(validJds);

            // 节拍循环:一 tick 一动作,自适应间隔铺满窗口
            while (true) {
                if (Thread.currentThread().isInterrupted()) {
                    log.warn("自动招聘:轮次线程被中断,提前收尾");
                    stats.abandoned = work.openUnits();
                    break;
                }
                LocalDateTime now = clock.get();
                if (!now.isBefore(deadline)) {
                    stats.abandoned = work.openUnits();
                    log.info("自动招聘:平摊窗口结束({}),剩余单元 {} 个顺延下轮", now, stats.abandoned);
                    break;
                }
                Unit unit = work.nextUnit(now, enabled);
                if (unit == null) {
                    if (work.drainedForWindow(deadline, enabled)) {
                        log.info("自动招聘:本轮动作已全部完成,提前收尾");
                        break;
                    }
                    long waitMs = Math.min(work.msUntilNextEligible(now),
                            Math.max(1, Duration.between(now, deadline).toMillis()));
                    sleepUntil(now.plusNanos(waitMs * 1_000_000L), deadline);
                    continue;
                }
                long spawnSeqBefore = cliExecutor.spawnSeq();
                if (!executeUnit(unit, work, stats, account, deadline)) {
                    stats.abandoned = work.openUnits();
                    log.warn("自动招聘:疑似拦截冻结跨越平摊窗口,本轮收尾");
                    break;
                }
                if (cliExecutor.spawnSeq() > spawnSeqBefore) {
                    // 触达平台的动作:按"平台足迹"自适应节拍(剩余窗口/剩余单元)
                    sleepPaced(work, deadline);
                } else {
                    // 纯记账单元(空转会話/无待办岗位等):轻间隔快速通过,不占用平台节拍
                    sleepUntil(clock.get().plusSeconds(1), deadline);
                }
            }
        } catch (CliException e) {
            if (e.getType() == CliException.Type.RISK_CONTROL) {
                // 真实熔断(复测再次命中/退避关闭):中止整轮并上抛(既有链路已标记账号)
                stats.riskStopped = true;
            }
            throw e;
        } catch (Exception e) {
            // 长轮次的兜底:非平台级异常不中断轮次收尾(摘要/历史照写)
            log.error("自动招聘:轮次内部异常,提前结束", e);
        } finally {
            LocalDateTime finishedAt = clock.get();
            LocalDateTime startedAt = runningSince;
            running.set(false);
            runningSince = null;
            try {
                settingService.saveLastRun(stats.toJson());
            } catch (Exception e) {
                log.warn("自动招聘:运行摘要保存失败: {}", e.getMessage());
            }
            // 轮次历史落库(运行日志页;失败不影响主流程)
            try {
                AutoRecruitRound round = new AutoRecruitRound();
                round.setStartedAt(startedAt);
                round.setFinishedAt(finishedAt);
                round.setMode(stats.mode);
                round.setPolled(stats.polled);
                round.setScored(stats.scored);
                round.setGreeted(stats.greeted);
                round.setRecommended(stats.recommended);
                round.setErrors(stats.errors);
                round.setRiskStopped(stats.riskStopped);
                round.setNoAccount(stats.noAccount);
                round.setStatsJson(stats.toJson());
                roundMapper.insert(round);
            } catch (Exception e) {
                log.warn("自动招聘:轮次历史写入失败: {}", e.getMessage());
            }
            log.info("自动招聘本轮结束: {}", stats.summaryText());
        }
    }

    // ---------- 节拍:间隔与睡眠 ----------

    /**
     * 节拍间隔:自适应 = clamp(剩余窗口毫秒 / 剩余单元数, paceMillis, maxPaceMillis)。
     * 单位少则更慢(铺满窗口),单位多则取提速下限 paceMillis;睡至目标时刻或窗口截止。
     */
    private void sleepPaced(RoundWork work, LocalDateTime deadline) {
        LocalDateTime now = clock.get();
        long remaining = Duration.between(now, deadline).toMillis();
        if (remaining <= 0) {
            return;
        }
        int open = Math.max(1, work.openUnits());
        long gap = Math.min(maxPaceMillis(), Math.max(paceMillis(), remaining / open));
        sleepUntil(now.plusNanos(gap * 1_000_000L), deadline);
    }

    /** 分段睡眠至目标时刻(不越过 deadline;每段 ≤60s 保证墙钟判定与睡醒后的及时收尾) */
    private void sleepUntil(LocalDateTime target, LocalDateTime deadline) {
        LocalDateTime limit = target.isBefore(deadline) ? target : deadline;
        while (clock.get().isBefore(limit)) {
            if (Thread.currentThread().isInterrupted()) {
                return;
            }
            long ms = Math.min(SLEEP_CHUNK_MILLIS, Duration.between(clock.get(), limit).toMillis());
            if (ms <= 0) {
                return;
            }
            sleeper.sleep(ms);
        }
    }

    // ---------- 单元执行 ----------

    /**
     * 执行一个单元;返回 false=疑似拦截的冻结跨越平摊窗口、轮次应就地收尾。
     * 真实熔断(复测再次命中/退避关闭)会以 CliException(RISK_CONTROL) 上抛中止整轮。
     */
    private boolean executeUnit(Unit unit, RoundWork work, RoundStats stats,
                                LiepinAccount account, LocalDateTime deadline) {
        switch (unit.type) {
            case POLL_LIST -> {
                AtomicReference<List<JsonNode>> fetched = new AtomicReference<>();
                ActionResult result = runActionWithRiskPolicy(
                        () -> fetched.set(chatPollService.fetchSessions(account)), stats, account, deadline);
                if (result == ActionResult.ABORTED) {
                    return false;
                }
                work.lastPollListAt = clock.get();
                List<JsonNode> sessions = fetched.get();
                if (sessions != null) {
                    for (JsonNode session : sessions) {
                        // 去重键(2026-09-30 C6):legacy 用 im_id;UI 通道 records 无 im_id,回退 "name:<会话名>"
                        String key = ChatPollService.sessionKey(session);
                        if (key.isEmpty() || work.processedSessions.contains(key)) {
                            continue;
                        }
                        work.pendingSessions.addLast(session);
                    }
                }
            }
            case POLL_SESSION -> {
                AtomicBoolean acted = new AtomicBoolean(false);
                ActionResult result = runActionWithRiskPolicy(
                        () -> acted.set(chatPollService.handleSession(account, unit.session)), stats, account, deadline);
                if (result == ActionResult.ABORTED) {
                    return false;
                }
                String key = ChatPollService.sessionKey(unit.session);
                if (!key.isEmpty()) {
                    work.processedSessions.add(key);
                }
                if (acted.get()) {
                    stats.polled++;
                }
            }
            case GREET -> {
                AtomicInteger sent = new AtomicInteger(0);
                LocalDateTime cutoff = starOverflowCutoff(clock.get());
                ActionResult result = runActionWithRiskPolicy(
                        () -> sent.set(unit.overflow
                                ? greetingService.greetOverflow(unit.jd.getId(), 1, cutoff)
                                : greetingService.greetPassed(unit.jd.getId(), 1)), stats, account, deadline);
                if (result == ActionResult.ABORTED) {
                    return false;
                }
                if (result == ActionResult.DONE && sent.get() > 0) {
                    stats.greeted += sent.get();
                    work.greetCount.merge(unit.jd.getId(), 1, Integer::sum);
                } else if (!unit.overflow) {
                    // 常规阶段已无待联系 → 进入溢出阶段(下一 tick 尝试 4-5 星溢出,2026-09-29)
                    work.greetNormalDone.put(unit.jd.getId(), true);
                } else {
                    // 溢出阶段无待办/失败:本轮该岗不再尝试(下一轮/开关恢复后自然补做)
                    work.greetDone.put(unit.jd.getId(), true);
                }
            }
            case READ -> {
                AtomicInteger scored = new AtomicInteger(-1);
                ActionResult result = runActionWithRiskPolicy(
                        () -> scored.set(scoringEngine.scoreNext(unit.jd.getId(), 1)), stats, account, deadline);
                if (result == ActionResult.ABORTED) {
                    return false;
                }
                if (result == ActionResult.DONE) {
                    stats.scored += Math.max(0, scored.get());
                    if (scored.get() <= 0) {
                        // 无待评分候选或读取预算用尽:本轮该岗读数结束
                        work.readDone.put(unit.jd.getId(), true);
                    }
                } else {
                    work.readDone.put(unit.jd.getId(), true);
                }
            }
            case RECOMMEND_CREATE -> {
                // 防重叠:已有在途任务 → 记已处理,不重复创建
                if (hasActiveTask(unit.jd.getId())) {
                    log.info("自动招聘:岗位 {} 已有在途(QUEUED/RUNNING)任务,本轮跳过拉新", unit.jd.getId());
                    work.taskDone.put(unit.jd.getId(), true);
                    return true;
                }
                AtomicBoolean created = new AtomicBoolean(false);
                ActionResult result = runActionWithRiskPolicy(() -> {
                    searchTaskService.createRecommendTask(unit.jd.getId(), account.getId());
                    created.set(true);
                }, stats, account, deadline);
                if (result == ActionResult.ABORTED) {
                    return false;
                }
                if (result == ActionResult.DONE) {
                    if (created.get()) {
                        stats.recommended++;
                        work.lastRecommendCreateAt = clock.get();
                    }
                    work.taskDone.put(unit.jd.getId(), true);
                } else {
                    work.taskDone.put(unit.jd.getId(), true);
                }
            }
            default -> {
                // 不可达
            }
        }
        return true;
    }

    /** 单元执行结果 */
    private enum ActionResult {
        /** 正常完成(含首次命中→冻结→复测通过的路径) */
        DONE,
        /** 非风控失败(已计入 errors,跳过该单元) */
        FAILED,
        /** 疑似拦截冻结跨越平摊窗口,轮次就地收尾 */
        ABORTED
    }

    /**
     * 执行动作并按"冻结-复测一次"语义处理风控命中(见 {@link RiskSuspectGuard}):
     * 首次命中 → 冻结退避(全平台操作暂停)→ 到期重放该动作一次(复测);
     * 复测成功 → 继续本轮;复测再次命中 → 置 riskStopped 并上抛(真实熔断)。
     */
    private ActionResult runActionWithRiskPolicy(UnitAction action, RoundStats stats,
                                                 LiepinAccount account, LocalDateTime deadline) {
        try {
            action.run();
            return ActionResult.DONE;
        } catch (CliException e) {
            if (e.getType() != CliException.Type.RISK_CONTROL) {
                stats.errors++;
                log.warn("自动招聘:动作执行失败,跳过: {}", e.getMessage());
                return ActionResult.FAILED;
            }
            if (!riskSuspectGuard.isHolding(account.getId())) {
                // 无冻结态伴随的风控异常(复测再次命中/退避关闭)→ 真实熔断:中止整轮
                stats.riskStopped = true;
                throw e;
            }
            // 首次命中:冻结退避,到期复测一次
            stats.suspects++;
            LocalDateTime holdUntil = riskSuspectGuard.holdUntil(account.getId());
            log.warn("自动招聘:疑似风控拦截,冻结退避至 {}(期间暂停全部平台操作,到期复测一次): {}",
                    holdUntil, e.getMessage());
            if (holdUntil == null) {
                stats.riskStopped = true;
                throw e;
            }
            sleepUntil(holdUntil, deadline);
            if (clock.get().isBefore(holdUntil)) {
                return ActionResult.ABORTED;
            }
            try {
                action.run();   // 复测(冻结解除后的第一个平台操作)
                return ActionResult.DONE;
            } catch (CliException retry) {
                if (retry.getType() == CliException.Type.RISK_CONTROL) {
                    stats.riskStopped = true;
                    throw retry;
                }
                stats.errors++;
                log.warn("自动招聘:复测执行失败,跳过: {}", retry.getMessage());
                return ActionResult.FAILED;
            } catch (Exception retry) {
                stats.errors++;
                log.warn("自动招聘:复测执行异常,跳过: {}", retry.getMessage(), retry);
                return ActionResult.FAILED;
            }
        } catch (Exception e) {
            stats.errors++;
            log.warn("自动招聘:动作执行异常,跳过: {}", e.getMessage(), e);
            return ActionResult.FAILED;
        }
    }

    // ---------- 轮内工作队列 ----------

    /** 节拍单元类型(优先级即声明顺序的消费顺序) */
    private enum UnitType {
        POLL_SESSION, POLL_LIST, GREET, READ, RECOMMEND_CREATE
    }

    /** 单个节拍单元 */
    private static final class Unit {

        private final UnitType type;
        private final Jd jd;
        private final JsonNode session;
        /** 打招呼单元是否处于 4-5 星溢出阶段(2026-09-29) */
        private final boolean overflow;

        private Unit(UnitType type, Jd jd, JsonNode session, boolean overflow) {
            this.type = type;
            this.jd = jd;
            this.session = session;
            this.overflow = overflow;
        }

        static Unit session(JsonNode session) {
            return new Unit(UnitType.POLL_SESSION, null, session, false);
        }

        static Unit pollList() {
            return new Unit(UnitType.POLL_LIST, null, null, false);
        }

        static Unit greet(Jd jd, boolean overflow) {
            return new Unit(UnitType.GREET, jd, null, overflow);
        }

        static Unit read(Jd jd) {
            return new Unit(UnitType.READ, jd, null, false);
        }

        static Unit create(Jd jd) {
            return new Unit(UnitType.RECOMMEND_CREATE, jd, null, false);
        }
    }

    /**
     * 轮内工作队列:按优先级挑选下一个可执行单元,并维护每岗位/每会话的完成标记与门禁时刻。
     * 优先级:会话处理 &gt; 列表刷新 &gt; 打招呼 &gt; 简历读取 &gt; 推荐创建。
     */
    private final class RoundWork {

        private final List<Jd> jds;
        /** 会话列表(含未处理会话;拉取后按 imId 去重入队) */
        private final Deque<JsonNode> pendingSessions = new ArrayDeque<>();
        /** 本轮已处理过的会话 imId(列表多次刷新不重复处理) */
        private final Set<String> processedSessions = new HashSet<>();
        private final Map<Long, Boolean> readDone = new HashMap<>();
        private final Map<Long, Integer> greetCount = new HashMap<>();
        private final Map<Long, Boolean> greetDone = new HashMap<>();
        /** 常规招呼阶段完成标记(进入 4-5 星溢出阶段;2026-09-29) */
        private final Map<Long, Boolean> greetNormalDone = new HashMap<>();
        private final Map<Long, Boolean> taskDone = new HashMap<>();
        private LocalDateTime lastPollListAt;
        private LocalDateTime lastRecommendCreateAt;

        private RoundWork(List<Jd> jds) {
            this.jds = jds;
        }

        /** 挑选下一个可执行单元;无可执行返回 null(可能等待门禁或已全部完成) */
        private Unit nextUnit(LocalDateTime now, boolean enabled) {
            // ① 会话处理(被动通道,时效优先)
            if (!pendingSessions.isEmpty()) {
                return Unit.session(pendingSessions.pollFirst());
            }
            // ② 会话列表刷新(周期;新来信进入当轮队列)
            if (lastPollListAt == null || Duration.between(lastPollListAt, now)
                    .compareTo(Duration.ofMinutes(pollListIntervalMinutes())) >= 0) {
                return Unit.pollList();
            }
            // ③ 打招呼(外发;单岗上限由轮内计数控制,发送节奏由 AccountPaceGuard 保证)
            //    两阶段:先常规(star=3/旧遗留)→ 再 4-5 星溢出(跨专道窗口未发出者,占预算插发;2026-09-29)
            if (enabled) {
                for (Jd jd : jds) {
                    if (Boolean.TRUE.equals(greetDone.get(jd.getId()))) {
                        continue;
                    }
                    if (greetCount.getOrDefault(jd.getId(), 0) >= greetBatchLimit()) {
                        greetDone.put(jd.getId(), true);
                        continue;
                    }
                    if (!Boolean.TRUE.equals(greetNormalDone.get(jd.getId()))) {
                        return Unit.greet(jd, false);
                    }
                    return Unit.greet(jd, true);
                }
            }
            // ④ 简历读取(轮内总预算/单岗预算由 ScoringEngine 控制)
            for (Jd jd : jds) {
                if (!Boolean.TRUE.equals(readDone.get(jd.getId()))) {
                    return Unit.read(jd);
                }
            }
            // ⑤ 推荐创建(全局最小间隔门禁,防创建扎堆)
            if (lastRecommendCreateAt == null || Duration.between(lastRecommendCreateAt, now)
                    .compareTo(Duration.ofMinutes(recommendGapMinutes())) >= 0) {
                for (Jd jd : jds) {
                    if (!Boolean.TRUE.equals(taskDone.get(jd.getId()))) {
                        return Unit.create(jd);
                    }
                }
            }
            return null;
        }

        /** 是否已可在本窗口内收尾(全部消费完且窗口内无后续刷新点) */
        private boolean drainedForWindow(LocalDateTime deadline, boolean enabled) {
            if (!pendingSessions.isEmpty() || lastPollListAt == null) {
                return false;
            }
            LocalDateTime nextPoll = lastPollListAt.plusMinutes(pollListIntervalMinutes());
            if (!nextPoll.isAfter(deadline)) {
                return false;
            }
            for (Jd jd : jds) {
                if (!Boolean.TRUE.equals(readDone.get(jd.getId()))) {
                    return false;
                }
                if (!Boolean.TRUE.equals(taskDone.get(jd.getId()))) {
                    return false;
                }
                if (enabled && !Boolean.TRUE.equals(greetDone.get(jd.getId()))) {
                    return false;
                }
            }
            return true;
        }

        /** 距下一个门禁解锁的等待毫秒(所有可执行单元都被门禁挡住的场景) */
        private long msUntilNextEligible(LocalDateTime now) {
            long wait = Long.MAX_VALUE;
            if (lastPollListAt != null) {
                LocalDateTime nextPoll = lastPollListAt.plusMinutes(pollListIntervalMinutes());
                wait = Math.min(wait, Math.max(0, Duration.between(now, nextPoll).toMillis()));
            }
            boolean createPending = false;
            for (Jd jd : jds) {
                if (!Boolean.TRUE.equals(taskDone.get(jd.getId()))) {
                    createPending = true;
                    break;
                }
            }
            if (createPending && lastRecommendCreateAt != null) {
                LocalDateTime nextCreate = lastRecommendCreateAt.plusMinutes(recommendGapMinutes());
                wait = Math.min(wait, Math.max(0, Duration.between(now, nextCreate).toMillis()));
            }
            return wait == Long.MAX_VALUE ? SLEEP_CHUNK_MILLIS : wait;
        }

        /** 剩余单元估算(节拍自适应用;仅粗估,防止间隔过疏/过密):
         *  会话仅计"候选人最后发言"(direction=1,可能触发平台动作),其余为纯记账单元不计入。 */
        private int openUnits() {
            int count = 0;
            for (JsonNode session : pendingSessions) {
                if ("1".equals(ChatPollService.effectiveDirection(session))) {
                    count++;
                }
            }
            for (Jd jd : jds) {
                if (!Boolean.TRUE.equals(readDone.get(jd.getId()))) {
                    count++;
                }
                if (!Boolean.TRUE.equals(greetDone.get(jd.getId()))) {
                    count++;
                }
                if (!Boolean.TRUE.equals(taskDone.get(jd.getId()))) {
                    count++;
                }
            }
            return count;
        }
    }

    // ---------- 既有工具方法 ----------

    /** 该岗位是否已有排队/运行中的任务(防重叠) */
    private boolean hasActiveTask(Long jdId) {
        Long count = searchTaskMapper.selectCount(new LambdaQueryWrapper<SearchTask>()
                .eq(SearchTask::getJdId, jdId)
                .in(SearchTask::getStatus, "QUEUED", "RUNNING"));
        return count != null && count > 0;
    }

    /** 当前是否有轮次在运行(状态接口/互斥用) */
    public boolean isRunning() {
        return running.get();
    }

    /** 当前轮次的开始时间(无运行中轮次时为 null) */
    public LocalDateTime getRunningSince() {
        return runningSince;
    }

    /**
     * 运行时段判定:每天 06:00–23:59(Asia/Shanghai 时区)返回 true;时段外或 null 返回 false。
     * 周末与法定节假日不排除(用户拍板:每天执行)。
     */
    static boolean isRunWindow(LocalDateTime now) {
        if (now == null) {
            return false;
        }
        LocalTime time = now.toLocalTime();
        return !time.isBefore(WINDOW_START) && !time.isAfter(WINDOW_END);
    }

    /**
     * 下一个定时运行时刻:严格晚于 now 的最近整点(06:00..23:00 范围内);当日已无则次日 06:00;null → null。
     */
    public static LocalDateTime nextRunAt(LocalDateTime now) {
        if (now == null) {
            return null;
        }
        LocalDate day = now.toLocalDate();
        for (int hour = FIRST_HOUR; hour <= LAST_HOUR; hour++) {
            LocalDateTime tick = day.atTime(hour, 0);
            if (tick.isAfter(now)) {
                return tick;
            }
        }
        return day.plusDays(1).atTime(FIRST_HOUR, 0);
    }

    // ---------- 配置快捷取值 ----------

    private int spreadMinutes() {
        return Math.max(1, properties.getAutoRecruit().getSpreadMinutes());
    }

    private long paceMillis() {
        return Math.max(0, properties.getAutoRecruit().getPaceMillis());
    }

    private long maxPaceMillis() {
        return Math.max(paceMillis(), properties.getAutoRecruit().getMaxPaceMillis());
    }

    private int pollListIntervalMinutes() {
        return Math.max(1, properties.getAutoRecruit().getPollListIntervalMinutes());
    }

    private int recommendGapMinutes() {
        return Math.max(0, properties.getAutoRecruit().getRecommendGapMinutes());
    }

    private int greetBatchLimit() {
        return Math.max(0, properties.getAutoRecruit().getGreetBatchLimit());
    }

    private Duration shortTimeout() {
        return Duration.ofMinutes(properties.getLiepin().getShortTimeoutMinutes());
    }

    /** 单轮运行统计(写入 auto_recruit.last_run 摘要;mode:full/collectOnly) */
    private static final class RoundStats {

        private String mode;
        private boolean noAccount;
        private boolean riskStopped;
        private int polled;
        private int scored;
        private int greeted;
        private int recommended;
        private int errors;
        /** 疑似拦截冻结次数(2026-09-28 节拍改造) */
        private int suspects;
        /** 平摊窗口结束/冻结跨窗时未完成而顺延下轮的单元数(2026-09-28 节拍改造) */
        private int abandoned;

        private RoundStats(String mode) {
            this.mode = mode;
        }

        private void setMode(String mode) {
            this.mode = mode;
        }

        private String toJson() {
            ObjectNode node = MAPPER.createObjectNode();
            node.put("at", LocalDateTime.now(ZONE).toString());
            node.put("mode", mode);
            node.put("noAccount", noAccount);
            node.put("polled", polled);
            node.put("scored", scored);
            node.put("greeted", greeted);
            node.put("recommended", recommended);
            node.put("errors", errors);
            node.put("riskStopped", riskStopped);
            node.put("suspects", suspects);
            node.put("abandoned", abandoned);
            return node.toString();
        }

        private String summaryText() {
            return "mode=" + mode + ", polled=" + polled + ", scored=" + scored
                    + ", greeted=" + greeted + ", recommended=" + recommended
                    + ", errors=" + errors + (noAccount ? ", noAccount" : "")
                    + (riskStopped ? ", riskStopped" : "")
                    + (suspects > 0 ? ", suspects=" + suspects : "")
                    + (abandoned > 0 ? ", abandoned=" + abandoned : "");
        }
    }
}
