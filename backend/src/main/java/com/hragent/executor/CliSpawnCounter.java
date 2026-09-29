package com.hragent.executor;

import org.springframework.stereotype.Component;

import java.util.concurrent.atomic.AtomicLong;

/**
 * CLI 子进程启动计数(平台足迹,2026-09-28 节拍改造;2026-09-29 W1 抽出共享)。
 *
 * <p>{@code AutoRecruitScheduler} 以"本单元执行前后计数是否增长"判定该单元是否
 * 触达平台,从而决定按平台节拍还是轻间隔推进。UI 通道(CuaDriverExecutor)与
 * CDP 通道(LiepinCliExecutor)共用同一计数器:当命令逐波迁移到 UI 通道后,
 * 节拍判定无需改动即自动生效。
 */
@Component
public class CliSpawnCounter {

    private final AtomicLong spawnSeq = new AtomicLong();

    /** 子进程已启动(含超时/失败尝试) */
    public void increment() {
        spawnSeq.incrementAndGet();
    }

    /** 当前计数(仅递增) */
    public long value() {
        return spawnSeq.get();
    }
}
