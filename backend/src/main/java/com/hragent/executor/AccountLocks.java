package com.hragent.executor;

import com.hragent.entity.LiepinAccount;
import org.springframework.stereotype.Component;

import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.locks.ReentrantLock;

/**
 * 账号维度互斥锁注册表(终审 I1;2026-09-29 CUA 全量替换 W1 抽出共享)。
 *
 * <p>所有自动化调用(CuaDriverExecutor)必须共用同一把账号锁:同账号任意并发调用
 * 在此串行,避免同一 Chrome/profile 上的自动化互踩;不同账号各自独立仍可并发。
 */
@Component
public class AccountLocks {

    /** 匿名账号兜底锁 key(理论上仅在测试场景出现 id 为空) */
    private static final long ANONYMOUS_ACCOUNT_KEY = 0L;

    private final ConcurrentHashMap<Long, ReentrantLock> locks = new ConcurrentHashMap<>();

    /** 取账号对应锁(id 为空时归并到匿名 key,保证不互串) */
    public ReentrantLock lockFor(LiepinAccount account) {
        return locks.computeIfAbsent(accountKey(account), k -> new ReentrantLock());
    }

    /** 按账号 id 取锁(null 归并到匿名 key) */
    public ReentrantLock lockFor(Long accountId) {
        return locks.computeIfAbsent(accountId == null ? ANONYMOUS_ACCOUNT_KEY : accountId,
                k -> new ReentrantLock());
    }

    private long accountKey(LiepinAccount account) {
        return account == null || account.getId() == null ? ANONYMOUS_ACCOUNT_KEY : account.getId();
    }
}
