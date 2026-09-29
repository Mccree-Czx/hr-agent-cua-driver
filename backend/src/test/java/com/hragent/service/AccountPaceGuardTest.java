package com.hragent.service;

import com.hragent.config.HrAgentProperties;
import com.hragent.entity.LiepinAccount;
import org.junit.jupiter.api.Test;

import java.time.Instant;

import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * AccountPaceGuard 账号级外发节流单测(评审 I-2)。
 *
 * <p>用真实睡眠验证行为,间隔取小值(1s)以控制用例时长。
 */
class AccountPaceGuardTest {

    private static LiepinAccount account(long id) {
        LiepinAccount account = new LiepinAccount();
        account.setId(id);
        return account;
    }

    private static AccountPaceGuard guard(int intervalSeconds) {
        HrAgentProperties properties = new HrAgentProperties();
        properties.getScoring().setGreetIntervalSeconds(intervalSeconds);
        return new AccountPaceGuard(properties);
    }

    private static long elapsedSince(long startMillis) {
        return System.currentTimeMillis() - startMillis;
    }

    private static void sleep(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    @Test
    void awaitWithoutHistoryDoesNotSleep() {
        AccountPaceGuard guard = guard(2);
        long start = System.currentTimeMillis();
        guard.await(account(1));
        assertTrue(elapsedSince(start) < 500, "无外发历史不应等待");
    }

    @Test
    void markThenAwaitSleepsRemainingInterval() {
        AccountPaceGuard guard = guard(1);
        LiepinAccount a = account(1);
        guard.mark(a);
        long start = System.currentTimeMillis();
        guard.await(a);
        long elapsed = elapsedSince(start);
        assertTrue(elapsed >= 800, "mark 后立即 await 应补足约 1s 间隔,实际 " + elapsed + "ms");
    }

    @Test
    void markUpdatesLastOutboundTime() {
        AccountPaceGuard guard = guard(1);
        LiepinAccount a = account(1);
        guard.mark(a);
        sleep(900);
        long start = System.currentTimeMillis();
        guard.await(a); // 距上次 mark 已 ~900ms,只需补 ~100ms
        long elapsed = elapsedSince(start);
        assertTrue(elapsed < 600, "mark 后时间已推进,补足时间应缩短,实际 " + elapsed + "ms");
    }

    @Test
    void coldStartSupplierSeedsLastOutboundTime() {
        AccountPaceGuard guard = guard(1);
        LiepinAccount a = account(1);
        // 冷启动:持久记录显示 200ms 前外发过 → 应补种并补足剩余 ~800ms
        Instant seeded = Instant.now().minusMillis(200);
        long start = System.currentTimeMillis();
        guard.await(a, () -> seeded);
        assertTrue(elapsedSince(start) >= 600, "冷启动应据持久记录补种并补足间隔");
        // 再次 await 应直接用内存记录(已补种),无需再回冷启动
        long second = System.currentTimeMillis();
        guard.await(a);
        assertTrue(elapsedSince(second) < 1000, "补种后二次 await 不应再触发冷启动");
    }

    @Test
    void coldStartNullDoesNotSleep() {
        AccountPaceGuard guard = guard(1);
        long start = System.currentTimeMillis();
        guard.await(account(1), () -> null);
        assertTrue(elapsedSince(start) < 300, "冷启动无历史不应等待");
    }

    @Test
    void zeroIntervalNeverSleeps() {
        AccountPaceGuard guard = guard(0);
        LiepinAccount a = account(1);
        guard.mark(a);
        long start = System.currentTimeMillis();
        guard.await(a);
        assertTrue(elapsedSince(start) < 200, "间隔为 0 时不得等待");
    }
}
