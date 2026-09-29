package com.hragent.config;

import com.hragent.entity.LiepinAccount;
import com.hragent.entity.SearchTask;
import com.hragent.repository.LiepinAccountMapper;
import com.hragent.repository.SearchTaskMapper;
import com.hragent.service.RiskSuspectGuard;
import com.hragent.service.SearchTaskService;
import com.hragent.service.TaskQueueService;
import jakarta.annotation.PreDestroy;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * 搜索任务调度器(单机):
 * - 周期 tick:释放过期租约(进程崩溃兜底)→ 每账号认领一个任务提交线程池
 * - 单账号串行由 {@link TaskQueueService#claim} 保证
 * - 节拍改造(2026-09-28):认领前加两道门禁——①账号处于疑似拦截冻结退避期不执行;
 *   ②距上次任务执行不足 {@code recommendGapMinutes} 不执行(防"任务接力"暴发,
 *   2026-09-28 15:03 事故形态)——任务留在队列,后续 tick 自然补跑
 */
@Slf4j
@Component
@EnableScheduling
@ConditionalOnProperty(name = "hr-agent.scheduler.enabled", havingValue = "true", matchIfMissing = true)
public class SearchTaskScheduler {

    private final TaskQueueService queueService;
    private final SearchTaskService searchTaskService;
    private final LiepinAccountMapper accountMapper;
    private final SearchTaskMapper taskMapper;
    private final RiskSuspectGuard riskSuspectGuard;
    private final HrAgentProperties properties;
    private final ExecutorService workerPool = Executors.newFixedThreadPool(4);

    public SearchTaskScheduler(TaskQueueService queueService, SearchTaskService searchTaskService,
                               LiepinAccountMapper accountMapper, SearchTaskMapper taskMapper,
                               RiskSuspectGuard riskSuspectGuard, HrAgentProperties properties) {
        this.queueService = queueService;
        this.searchTaskService = searchTaskService;
        this.accountMapper = accountMapper;
        this.taskMapper = taskMapper;
        this.riskSuspectGuard = riskSuspectGuard;
        this.properties = properties;
    }

    @Scheduled(fixedDelay = 30_000, initialDelay = 10_000)
    public void tick() {
        int released = queueService.releaseExpiredLeases();
        if (released > 0) {
            log.warn("释放租约过期的 RUNNING 任务 {} 个(进程崩溃恢复)", released);
        }

        Set<Long> processedAccounts = new HashSet<>();
        List<SearchTask> claimed;
        do {
            claimed = claimOnePerAccount(processedAccounts);
            for (SearchTask task : claimed) {
                workerPool.submit(() -> {
                    try {
                        searchTaskService.execute(task);
                    } catch (Exception e) {
                        log.error("任务 {} 调度执行异常", task.getId(), e);
                    }
                });
            }
        } while (!claimed.isEmpty());
    }

    /** 每账号认领一个任务(跳过本轮已认领的账号;冻结退避/执行间隔未到则跳过) */
    private List<SearchTask> claimOnePerAccount(Set<Long> processedAccounts) {
        List<SearchTask> claimed = new ArrayList<>();
        List<LiepinAccount> accounts = accountMapper.selectList(null);
        for (LiepinAccount account : accounts) {
            if (processedAccounts.contains(account.getId())) {
                continue;
            }
            // ① 疑似拦截冻结退避期:暂停全部任务执行(等复测)
            if (riskSuspectGuard.isHolding(account.getId())) {
                log.info("账号 {} 处于疑似拦截冻结退避期,暂不执行任务", account.getId());
                continue;
            }
            // ② 最小执行间隔:距上次任务执行不足 recommendGapMinutes → 跳过(防任务接力)
            if (withinExecutionGap(account.getId())) {
                log.debug("账号 {} 距上次任务执行不足 {} 分钟,本轮不执行任务",
                        account.getId(), properties.getAutoRecruit().getRecommendGapMinutes());
                continue;
            }
            SearchTask task = queueService.claim(account.getId());
            if (task != null) {
                claimed.add(task);
                processedAccounts.add(account.getId());
            }
        }
        return claimed;
    }

    /** 该账号距上一次"执行相关"任务活动是否不足 recommendGapMinutes(0=关闭该门禁) */
    private boolean withinExecutionGap(Long accountId) {
        int gapMinutes = Math.max(0, properties.getAutoRecruit().getRecommendGapMinutes());
        if (gapMinutes <= 0) {
            return false;
        }
        LocalDateTime last = taskMapper.selectLastExecutedAt(accountId);
        if (last == null) {
            return false;
        }
        return Duration.between(last, LocalDateTime.now()).compareTo(Duration.ofMinutes(gapMinutes)) < 0;
    }

    @PreDestroy
    public void shutdown() {
        workerPool.shutdown();
        try {
            workerPool.awaitTermination(10, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
