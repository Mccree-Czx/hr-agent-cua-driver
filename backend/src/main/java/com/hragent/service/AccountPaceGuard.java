package com.hragent.service;

import com.hragent.config.HrAgentProperties;
import com.hragent.entity.LiepinAccount;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.time.Instant;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Supplier;

/**
 * 账号级外发节流守卫(评审 I-2)。
 *
 * <p>打招呼、附件下载、索要简历三处外发动作原本各自维护节流(打招呼查 {@code greeting_record},
 * 来信轮询用局部数组),彼此互不可见,同轮内可在 0 秒内相邻外发。本守卫把「账号 → 最近一次外发时刻」
 * 收敛为进程内共享状态,所有外发动作前统一 {@link #await}、成功后统一 {@link #mark},
 * 从而在同一进程内保证同账号两次外发间隔不小于 {@code hr-agent.scoring.greet-interval-seconds}。
 *
 * <p>内存级({@link ConcurrentHashMap}):进程重启后无记录,首次外发不等待;调用方可传
 * {@code coldStart} 兜底(如从 {@code greeting_record} 查最近一次 SENT)补种,避免重启后立即外发。
 */
@Slf4j
@Service
public class AccountPaceGuard {

    private final HrAgentProperties properties;

    /** 账号 ID → 最近一次外发时刻(内存级,进程重启即失效) */
    private final ConcurrentHashMap<Long, Instant> lastOutboundAt = new ConcurrentHashMap<>();

    public AccountPaceGuard(HrAgentProperties properties) {
        this.properties = properties;
    }

    /**
     * 距该账号上次外发不足 {@code greetIntervalSeconds} 时睡眠补足;无历史记录则不等待。
     */
    public void await(LiepinAccount account) {
        await(account, null);
    }

    /**
     * 距该账号上次外发不足 {@code greetIntervalSeconds} 时睡眠补足。
     *
     * @param coldStart 仅在该账号无内存记录时调用,用于从持久记录补种(冷启动兜底);返回 {@code null}
     *                  表示确无历史外发,补种失败不阻塞本次外发
     */
    public void await(LiepinAccount account, Supplier<Instant> coldStart) {
        if (account == null || account.getId() == null) {
            return;
        }
        int intervalSeconds = properties.getScoring().getGreetIntervalSeconds();
        Instant last = lastOutboundAt.get(account.getId());
        if (last == null && coldStart != null) {
            last = coldStart.get();
            if (last != null) {
                lastOutboundAt.put(account.getId(), last);
            }
        }
        if (last == null || intervalSeconds <= 0) {
            return;
        }
        long remainingMillis = intervalSeconds * 1000L - Duration.between(last, Instant.now()).toMillis();
        if (remainingMillis > 0) {
            sleep(remainingMillis);
        }
    }

    /** 记录本次外发时刻(发送成功后调用);后续 {@link #await} 据此计算间隔 */
    public void mark(LiepinAccount account) {
        if (account != null && account.getId() != null) {
            lastOutboundAt.put(account.getId(), Instant.now());
        }
    }

    private static void sleep(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
