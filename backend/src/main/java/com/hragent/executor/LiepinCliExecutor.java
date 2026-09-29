package com.hragent.executor;

import com.hragent.config.HrAgentProperties;
import com.hragent.entity.LiepinAccount;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.ReentrantLock;

/**
 * liepin-cli 子进程封装。
 *
 * 关键设计(评审 P0-1/风控硬约束):
 * - 每账号独立 LIEPIN_USER_DATA_DIR(登录态隔离)+ 独立 CDP 调试端口(多账号浏览器不冲突)
 * - 有头 Chrome 由 CLI 自身保证(CLI 默认有头,本封装不传任何无头开关)
 * - 统一超时与输出捕获;风控/登录态检测见 {@link #checkRisk}
 * - <b>单账号串行(终审 I1)</b>:同账号所有 CLI 调用(队列 worker / 调度器内联 / 手动接口)
 *   经账号维度的 {@link ReentrantLock} 互斥,执行子进程前 lock、finally unlock;
 *   不同账号各自的锁互不影响,仍可并发。
 */
@Slf4j
@Component
public class LiepinCliExecutor {

    private static final int BASE_DEBUG_PORT = 53471;

    /** 匿名账号兜底锁 key(理论上仅在测试场景出现 id 为空) */
    private static final long ANONYMOUS_ACCOUNT_KEY = 0L;

    /** 账号维度互斥锁:保证同账号 CLI 子进程串行,规避同账号并发浏览器自动化风控风险 */
    private final ConcurrentHashMap<Long, ReentrantLock> accountLocks = new ConcurrentHashMap<>();

    /** CLI 子进程启动计数(仅递增;供上层节拍判定"本单元是否触达平台",2026-09-28) */
    private final java.util.concurrent.atomic.AtomicLong spawnSeq = new java.util.concurrent.atomic.AtomicLong();

    /** 已启动的 CLI 子进程序号(含超时/失败尝试;空转会話等纯记账单元不增长,不参与平台节拍) */
    public long spawnSeq() {
        return spawnSeq.get();
    }

    /** 风控拦截的结构性标记（命中则账号熔断，评审 P0-3；成功/失败全路径扫描）。
     *  只放平台风控页特有的域名/camelCase 标识——不会出现在候选人简历文本里，
     *  成功路径（stdout 为业务数据）也只信任这两类结构性证据。 */
    private static final List<String> RISK_KEYWORDS = List.of(
            "captchaPage", "safe.liepin.com");

    /** 风控短语：仅在命令失败/超时路径扫描。
     *  成功时 stdout 是业务数据（如候选人简历 JSON），短语误命中会让账号误熔断：
     *  - 2026-09-27 实测：候选人简历里的 verify 触发熔断，轮次全停；
     *  - 2026-09-28 实测：候选人简历里的“涉水安全验证”等中文短语致岗位 10 连续三轮误熔断，
     *    手动不经扫描读取同一简历则完全正常。
     *  失败/超时时的输出是 CLI 自身错误文本，此处扫描才可信。 */
    private static final List<String> RISK_KEYWORDS_FAILURE_ONLY = List.of(
            "行为异常", "安全验证", "滑块验证", "captcha", "verify", "security-check", "forbidden");

    /** 登录态失效特征 */
    private static final List<String> NOT_LOGGED_KEYWORDS = List.of(
            "未登录", "请先登录", "登录已过期", "need login", "登录页");

    private final HrAgentProperties properties;

    public LiepinCliExecutor(HrAgentProperties properties) {
        this.properties = properties;
    }

    /**
     * 执行 CLI 命令并返回原始结果(不解析)。
     *
     * <p>按账号互斥(终审 I1):同账号任意调用者(队列 worker、调度器内联、手动接口)在此串行,
     * 执行子进程前 lock、finally unlock;不同账号各自独立仍可并发。
     */
    public CliResult execute(LiepinAccount account, Duration timeout, String... args)
            throws IOException, InterruptedException {
        ReentrantLock lock = accountLocks.computeIfAbsent(accountKey(account), k -> new ReentrantLock());
        lock.lock();
        try {
            return runCli(account, timeout, args);
        } finally {
            lock.unlock();
        }
    }

    /**
     * 实际启动 CLI 子进程(调用方 {@link #execute} 已持有账号锁)。
     * 抽为 protected 便于测试注入并发探针验证互斥语义。
     */
    protected CliResult runCli(LiepinAccount account, Duration timeout, String... args)
            throws IOException, InterruptedException {
        List<String> command = new ArrayList<>();
        command.add(properties.getLiepin().getCliPath());
        for (String arg : args) {
            if (arg != null && !arg.isBlank()) {
                command.add(arg);
            }
        }

        ProcessBuilder pb = new ProcessBuilder(command);
        pb.redirectErrorStream(true);
        pb.environment().put("LIEPIN_USER_DATA_DIR", resolveUserDataDir(account));
        pb.environment().put("LIEPIN_BROWSER_REMOTE_DEBUGGING_PORT", String.valueOf(resolveDebugPort(account)));

        // 输出落盘而非管道读取:子进程输出超过管道缓冲区(约 64KB)时,若父进程不并发读流,
        // 子进程会阻塞在写输出、永不退出,表现为整段命令超时被强杀(2026-09-26 根因:
        // chatlist 30 个会话输出 68KB,连续多轮 3 分钟假超时,回复/已读全部漏处理)。
        // 落盘后无需消费方配合,超时时也能读到部分输出用于诊断。
        Path outputFile = Files.createTempFile("liepin-cli-", ".log");
        try {
            pb.redirectOutput(outputFile.toFile());

            log.info("执行 liepin-cli: {} (account={}, dataDir={})",
                    String.join(" ", args), account.getId(), resolveUserDataDir(account));

            Process process = pb.start();
            spawnSeq.incrementAndGet();
            boolean finished = process.waitFor(timeout.toMillis(), TimeUnit.MILLISECONDS);
            if (!finished) {
                process.destroyForcibly();
                process.waitFor(5, TimeUnit.SECONDS);
                String partial = readOutputQuietly(outputFile);
                log.warn("liepin-cli 超时(account={}, args={}),部分输出: {}",
                        account.getId(), String.join(" ", args), truncate(partial, 500));
                return new CliResult(-1, partial, "", true);
            }
            return new CliResult(process.exitValue(), readOutputQuietly(outputFile), "", false);
        } finally {
            deleteQuietly(outputFile);
        }
    }

    /** 读取子进程输出文件(失败时返回空串,不影响主流程判定) */
    private static String readOutputQuietly(Path outputFile) {
        try {
            return new String(Files.readAllBytes(outputFile));
        } catch (IOException e) {
            return "";
        }
    }

    private static void deleteQuietly(Path path) {
        try {
            Files.deleteIfExists(path);
        } catch (IOException e) {
            // 临时文件清理失败不影响业务
        }
    }

    private static String truncate(String s, int max) {
        return s == null || s.length() <= max ? s : s.substring(0, max) + "...";
    }

    /**
     * 检测输出中的风控/登录态特征。
     * 风控优先(风控页往往同时含登录提示)。
     */
    public void checkRisk(LiepinAccount account, CliResult result) {
        String output = result.combined().toLowerCase();
        for (String kw : RISK_KEYWORDS) {
            if (output.contains(kw.toLowerCase())) {
                throw new CliException(CliException.Type.RISK_CONTROL,
                        "检测到风控拦截特征 [" + kw + "](account=" + account.getId() + ")");
            }
        }
        if (result.timedOut() || result.exitCode() != 0) {
            for (String kw : RISK_KEYWORDS_FAILURE_ONLY) {
                if (output.contains(kw.toLowerCase())) {
                    throw new CliException(CliException.Type.RISK_CONTROL,
                            "检测到风控拦截特征 [" + kw + "](account=" + account.getId() + ")");
                }
            }
        }
        for (String kw : NOT_LOGGED_KEYWORDS) {
            if (output.contains(kw.toLowerCase())) {
                throw new CliException(CliException.Type.NOT_LOGGED_IN,
                        "检测到登录态失效特征 [" + kw + "](account=" + account.getId() + ")");
            }
        }
        if (result.timedOut()) {
            throw new CliException(CliException.Type.TIMEOUT,
                    "liepin-cli 执行超时(account=" + account.getId() + ")");
        }
        if (result.exitCode() != 0) {
            throw new CliException(CliException.Type.FAILED,
                    "liepin-cli 非零退出 code=" + result.exitCode()
                            + "(account=" + account.getId() + "): " + truncate(result.combined(), 500));
        }
    }

    /** 账号维度互斥锁 key(id 为空时归并到匿名 key,保证不互串) */
    private long accountKey(LiepinAccount account) {
        return account == null || account.getId() == null ? ANONYMOUS_ACCOUNT_KEY : account.getId();
    }

    private String resolveUserDataDir(LiepinAccount account) {
        if (account.getUserDataDir() != null && !account.getUserDataDir().isBlank()) {
            return account.getUserDataDir();
        }
        return properties.getLiepin().getDataDirBase() + "/account-" + account.getId();
    }

    /**
     * CDP 端口分配:
     * - 首个账号(单账号场景)直接用 CLI 默认端口 53471,与手动 CLI 命令
     *   使用同一 user-data 时复用同一只浏览器,避免实例互踩;
     * - 多账号(id>1)按 id 偏移,各账号的浏览器实例互不干扰。
     */
    private int resolveDebugPort(LiepinAccount account) {
        long accountId = account.getId() == null ? 1L : account.getId();
        return accountId == 1L ? BASE_DEBUG_PORT : BASE_DEBUG_PORT + (int) (accountId % 1000);
    }
}
