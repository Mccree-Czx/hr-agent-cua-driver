package com.hragent.executor;

import com.hragent.config.HrAgentProperties;
import com.hragent.entity.LiepinAccount;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * CuaDriverExecutor 契约测试(2026-09-29 全量替换 W1):
 * 命令/环境构建、与 CDP 通道的共享账号锁与共享平台足迹计数、风控检测委托语义。
 */
class CuaDriverExecutorTest {

    private HrAgentProperties properties;
    private AccountLocks accountLocks;
    private CliSpawnCounter spawnCounter;

    @BeforeEach
    void setUp() {
        properties = new HrAgentProperties();
        properties.getCua().setScriptPath("C:/cua-liepin-driver/dist/cli/index.js");
        accountLocks = new AccountLocks();
        spawnCounter = new CliSpawnCounter();
    }

    private CuaDriverExecutor newExecutor() {
        return new CuaDriverExecutor(accountLocks, spawnCounter, properties);
    }

    private LiepinAccount account(long id) {
        LiepinAccount account = new LiepinAccount();
        account.setId(id);
        account.setName("测试账号" + id);
        return account;
    }

    // ---------- 命令/环境构建 ----------

    @Test
    void buildCommandPrefixesNodeAndScriptAndFiltersBlankArgs() {
        List<String> command = newExecutor().buildCommand("greet", "abc123", "", "--ejobId", "42", "--json");
        assertEquals(List.of(
                "node", "C:/cua-liepin-driver/dist/cli/index.js",
                "greet", "abc123", "--ejobId", "42", "--json"), command);
    }

    @Test
    void buildCommandFailsFastWithoutScriptPath() {
        properties.getCua().setScriptPath("");
        IllegalStateException e = assertThrows(IllegalStateException.class,
                () -> newExecutor().buildCommand("greet"));
        assertTrue(e.getMessage().contains("script-path"));
    }

    @Test
    void buildEnvInjectsProfileDirAndStableSession() {
        Map<String, String> env = newExecutor().buildEnv(account(3));
        assertTrue(env.get("LIEPIN_USER_DATA_DIR").endsWith("account-3"));
        assertEquals("hr-agent-3", env.get("CUA_SESSION"));
        assertEquals(null, env.get("CUA_DRIVER_BIN"), "未配置 driver-bin 时不应注入");

        properties.getCua().setDriverBin("C:/cua-driver/cua-driver.exe");
        assertEquals("C:/cua-driver/cua-driver.exe", newExecutor().buildEnv(account(3)).get("CUA_DRIVER_BIN"));
    }

    @Test
    void accountCustomProfileDirWins() {
        LiepinAccount account = account(9);
        account.setUserDataDir("D:/profiles/custom-9");
        assertEquals("D:/profiles/custom-9", newExecutor().buildEnv(account).get("LIEPIN_USER_DATA_DIR"));
    }

    // ---------- 共享账号锁:UI 与 CDP 两通道同账号必须串行 ----------

    @Test
    void sameAccountUiAndCdpChannelsAreSerialized() throws Exception {
        ProbeCuaExecutor cua = new ProbeCuaExecutor(accountLocks, spawnCounter, properties);
        ProbeLiepinExecutor cdp = new ProbeLiepinExecutor(accountLocks, spawnCounter);
        LiepinAccount account = account(1);

        runConcurrently(() -> cua.execute(account, Duration.ofSeconds(5), "x"),
                () -> cdp.execute(account, Duration.ofSeconds(5), "x"));

        int max = Math.max(cua.maxConcurrent.get(), cdp.maxConcurrent.get());
        assertEquals(1, max, "同账号 UI 与 CDP 通道的并发执行必须串行(共享账号锁)");
    }

    @Test
    void differentAccountsAcrossChannelsStillParallel() throws Exception {
        ProbeCuaExecutor cua = new ProbeCuaExecutor(accountLocks, spawnCounter, properties);
        ProbeLiepinExecutor cdp = new ProbeLiepinExecutor(accountLocks, spawnCounter);

        runConcurrently(() -> cua.execute(account(1), Duration.ofSeconds(5), "x"),
                () -> cdp.execute(account(2), Duration.ofSeconds(5), "x"));

        assertEquals(1, cua.maxConcurrent.get());
        assertEquals(1, cdp.maxConcurrent.get(), "不同账号应可并发(各自独立锁)");
    }

    // ---------- 共享平台足迹计数 ----------

    @Test
    void spawnSeqReflectsSharedCounterAcrossChannels() {
        CuaDriverExecutor cua = newExecutor();
        spawnCounter.increment();
        assertEquals(1, cua.spawnSeq(), "UI 通道 spawnSeq 应与共享计数同源(节拍判定用)");
    }

    // ---------- 风控检测委托(双档语义 + 退出码显式映射) ----------

    @Test
    void checkRiskMapsExitCodeThreeToRiskControl() {
        CliException e = assertThrows(CliException.class,
                () -> newExecutor().checkRisk(account(1), new CliResult(3, "driver risk-control", "", false)));
        assertEquals(CliException.Type.RISK_CONTROL, e.getType());
    }

    @Test
    void checkRiskMapsExitCodeTwoToNotLoggedIn() {
        CliException e = assertThrows(CliException.class,
                () -> newExecutor().checkRisk(account(1), new CliResult(2, "driver auth-expired", "", false)));
        assertEquals(CliException.Type.NOT_LOGGED_IN, e.getType());
    }

    @Test
    void checkRiskPassesSuccessfulBusinessOutput() {
        newExecutor().checkRisk(account(1),
                new CliResult(0, "{\"status\":\"ok\",\"summary\":\"clicked (1114, 292)\"}", "", false));
    }

    // ---------- 并发探针与工具 ----------

    private static void runConcurrently(ThrowingRunnable first, ThrowingRunnable second) throws Exception {
        CountDownLatch start = new CountDownLatch(1);
        Thread t1 = new Thread(() -> runAfter(start, first));
        Thread t2 = new Thread(() -> runAfter(start, second));
        t1.start();
        t2.start();
        start.countDown();
        t1.join();
        t2.join();
    }

    private static void runAfter(CountDownLatch start, ThrowingRunnable task) {
        try {
            start.await();
            task.run();
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    @FunctionalInterface
    private interface ThrowingRunnable {
        void run() throws Exception;
    }

    /** 并发探针:统计 runCli 实际并发度,验证共享账号锁 */
    private static class ProbeCuaExecutor extends CuaDriverExecutor {

        final AtomicInteger concurrent = new AtomicInteger();
        final AtomicInteger maxConcurrent = new AtomicInteger();

        ProbeCuaExecutor(AccountLocks locks, CliSpawnCounter counter, HrAgentProperties properties) {
            super(locks, counter, properties);
        }

        @Override
        protected CliResult runCli(LiepinAccount account, Duration timeout, String... args) {
            int current = concurrent.incrementAndGet();
            maxConcurrent.accumulateAndGet(current, Math::max);
            try {
                Thread.sleep(300);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            } finally {
                concurrent.decrementAndGet();
            }
            return new CliResult(0, "{\"status\":\"ok\"}", "", false);
        }
    }

    /** CDP 通道探针(共享同一把账号锁与计数器) */
    private static class ProbeLiepinExecutor extends LiepinCliExecutor {

        final AtomicInteger concurrent = new AtomicInteger();
        final AtomicInteger maxConcurrent = new AtomicInteger();

        ProbeLiepinExecutor(AccountLocks locks, CliSpawnCounter counter) {
            super(new HrAgentProperties(), locks, counter);
        }

        @Override
        protected CliResult runCli(LiepinAccount account, Duration timeout, String... args) {
            int current = concurrent.incrementAndGet();
            maxConcurrent.accumulateAndGet(current, Math::max);
            try {
                Thread.sleep(300);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            } finally {
                concurrent.decrementAndGet();
            }
            return new CliResult(0, "[]", "", false);
        }
    }
}
