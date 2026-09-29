package com.hragent.executor;

import com.hragent.config.HrAgentProperties;
import com.hragent.entity.LiepinAccount;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.io.File;
import java.time.Duration;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class LiepinCliExecutorTest {

    private static String fakeScript;

    private static HrAgentProperties properties;

    /** 与 CuaDriverExecutor 共享的账号锁/平台足迹计数(W1 起;测试内单独实例化) */
    private static AccountLocks accountLocks;
    private static CliSpawnCounter spawnCounter;

    @BeforeAll
    static void setUp() throws Exception {
        // 桩脚本按操作系统选择:POSIX 用 .sh,Windows 用 .cmd(行为对齐,含中文输出编码适配)
        File script = isWindows()
                ? new File("src/test/resources/scripts/fake-liepin.cmd")
                : new File("src/test/resources/scripts/fake-liepin.sh");
        // 确保可执行权限(maven 资源复制不保留执行位)
        script.setExecutable(true);
        fakeScript = script.getAbsolutePath();

        properties = new HrAgentProperties();
        properties.getLiepin().setCliPath(fakeScript);

        accountLocks = new AccountLocks();
        spawnCounter = new CliSpawnCounter();
    }

    private LiepinAccount account(long id) {
        LiepinAccount account = new LiepinAccount();
        account.setId(id);
        account.setName("测试账号" + id);
        return account;
    }

    private LiepinCliExecutor newExecutor() {
        return new LiepinCliExecutor(properties, accountLocks, spawnCounter);
    }

    @Test
    void executeSuccess() throws Exception {
        CliResult result = newExecutor().execute(account(1), Duration.ofSeconds(10), "search", "java", "--json");
        assertEquals(0, result.exitCode());
        assertTrue(result.stdout().contains("默认候选人"));
        assertTrue(result.stdout().contains("r0"));
    }

    @Test
    void executeIncrementsSpawnSeq() throws Exception {
        LiepinCliExecutor executor = newExecutor();
        long before = executor.spawnSeq();

        executor.execute(account(1), Duration.ofSeconds(10), "search", "java", "--json");

        assertEquals(before + 1, executor.spawnSeq(),
                "每次启动 CLI 子进程应递增平台足迹计数(上层节拍据此区分触达/记账单元)");
    }

    @Test
    void executeTimeout() throws Exception {
        CliResult result = newExecutor().execute(account(1), Duration.ofSeconds(2), "sleep-long");
        assertTrue(result.timedOut());
    }

    @Test
    void executeLargeOutputDoesNotDeadlock() throws Exception {
        // 回归(2026-09-26):输出超过管道缓冲区(约 64KB)时,旧实现因父进程不读流导致子进程写阻塞、
        // 整段命令假超时(chatlist 30 个会话输出 68KB,连续多轮 3 分钟超时,回复/已读全部漏处理)
        CliResult result = newExecutor().execute(account(1), Duration.ofSeconds(10), "big-output");
        assertTrue(!result.timedOut(), "大输出不得因管道写满而假超时");
        assertEquals(0, result.exitCode());
        assertTrue(result.stdout().length() > 65536, "大输出应完整读回,实际 " + result.stdout().length());
    }

    @Test
    void checkRiskDetectsCaptcha() {
        LiepinCliExecutor executor = newExecutor();
        CliResult riskResult = new CliResult(0, "302 to safe.liepin.com/captchaPage_PC 行为异常", "", false);
        CliException e = assertThrows(CliException.class, () -> executor.checkRisk(account(1), riskResult));
        assertEquals(CliException.Type.RISK_CONTROL, e.getType());
    }

    @Test
    void checkRiskDetectsNotLoggedIn() {
        LiepinCliExecutor executor = newExecutor();
        CliResult result = new CliResult(0, "请先登录后再操作", "", false);
        CliException e = assertThrows(CliException.class, () -> executor.checkRisk(account(1), result));
        assertEquals(CliException.Type.NOT_LOGGED_IN, e.getType());
    }

    @Test
    void checkRiskDetectsNonZeroExit() {
        LiepinCliExecutor executor = newExecutor();
        CliResult result = new CliResult(1, "some error", "", false);
        CliException e = assertThrows(CliException.class, () -> executor.checkRisk(account(1), result));
        assertEquals(CliException.Type.FAILED, e.getType());
    }

    @Test
    void checkRiskDetectsTimeout() {
        LiepinCliExecutor executor = newExecutor();
        CliResult result = new CliResult(-1, "", "", true);
        CliException e = assertThrows(CliException.class, () -> executor.checkRisk(account(1), result));
        assertEquals(CliException.Type.TIMEOUT, e.getType());
    }

    @Test
    void checkRiskPassesNormalOutput() {
        LiepinCliExecutor executor = newExecutor();
        CliResult result = new CliResult(0, "[{\"name\":\"张三\",\"resume_id\":\"r1\"}]", "", false);
        executor.checkRisk(account(1), result); // 不应抛异常
    }

    @Test
    void checkRiskIgnoresGenericKeywordsInBusinessData() {
        // 回归(2026-09-27):简历 JSON 里的 verify 触发误熔断,轮次全停
        LiepinCliExecutor executor = newExecutor();
        CliResult result = new CliResult(0, "[{\"name\":\"李四\",\"skills\":\"SoC verification, verify\"}]", "", false);
        executor.checkRisk(account(1), result); // 成功路径的业务数据不应被泛词误判
    }

    @Test
    void checkRiskStillDetectsGenericKeywordsOnFailure() {
        LiepinCliExecutor executor = newExecutor();
        CliResult result = new CliResult(1, "Error: navigate to captcha challenge", "", false);
        CliException e = assertThrows(CliException.class, () -> executor.checkRisk(account(1), result));
        assertEquals(CliException.Type.RISK_CONTROL, e.getType());
    }

    @Test
    void checkRiskIgnoresChineseRiskPhrasesInResumeData() {
        // 回归(2026-09-28):简历里“涉水安全验证”(岗位 10 候选人)致连续三轮误熔断
        LiepinCliExecutor executor = newExecutor();
        CliResult result = new CliResult(0,
                "[{\"name\":\"孙某\",\"work\":\"完成水压耐压测试、涉水安全验证、长期通水衰减测试\"}]", "", false);
        executor.checkRisk(account(1), result); // 成功路径的业务数据不应被中文短语误判

        CliResult slider = new CliResult(0,
                "[{\"name\":\"测试员\",\"desc\":\"负责滑块验证用例设计与异常行为检测\"}]", "", false);
        executor.checkRisk(account(1), slider);
    }

    @Test
    void checkRiskStillDetectsChineseRiskPhrasesOnFailure() {
        LiepinCliExecutor executor = newExecutor();
        CliResult result = new CliResult(1, "Error: 页面跳转到安全验证", "", false);
        CliException e = assertThrows(CliException.class, () -> executor.checkRisk(account(1), result));
        assertEquals(CliException.Type.RISK_CONTROL, e.getType());
    }

    // ---------- I1:账号维度互斥(同账号串行 / 不同账号不互斥) ----------

    @Test
    void sameAccountConcurrentExecuteIsSerialized() throws Exception {
        ProbeExecutor executor = new ProbeExecutor(properties);
        LiepinAccount account = account(1);

        runConcurrently(() -> executor.execute(account, Duration.ofSeconds(5), "x"),
                () -> executor.execute(account, Duration.ofSeconds(5), "x"));

        assertEquals(1, executor.maxConcurrent.get(), "同账号两次并发 execute 必须串行");
    }

    @Test
    void differentAccountsConcurrentExecuteNotMutuallyExclusive() throws Exception {
        ProbeExecutor executor = new ProbeExecutor(properties);

        runConcurrently(() -> executor.execute(account(1), Duration.ofSeconds(5), "x"),
                () -> executor.execute(account(2), Duration.ofSeconds(5), "x"));

        assertEquals(2, executor.maxConcurrent.get(), "不同账号应可并发");
    }

    private static boolean isWindows() {
        return System.getProperty("os.name", "").toLowerCase().contains("win");
    }

    /** 同时启动两个任务并等待结束 */
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

    /** 并发探针:统计 runCli 的实际并发度,验证按账号锁是否生效 */
    private static class ProbeExecutor extends LiepinCliExecutor {

        final AtomicInteger concurrent = new AtomicInteger();
        final AtomicInteger maxConcurrent = new AtomicInteger();

        ProbeExecutor(HrAgentProperties properties) {
            super(properties, accountLocks, spawnCounter);
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
            return new CliResult(0, "{\"ok\":true}", "", false);
        }
    }
}
