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
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.ReentrantLock;

/**
 * cua-liepin-driver 子进程封装(唯一平台通道,2026-09-29 W1;2026-09-30 全量替换定稿)。
 *
 * <p>关键设计:
 * <ul>
 *     <li><b>账号锁</b>:经 {@link AccountLocks} 保证同账号并发调用串行
 *         —— 同一 Chrome/profile 上的自动化绝不能互踩;</li>
 *     <li><b>平台足迹计数</b>:{@link CliSpawnCounter},轮次节拍判定依据
 *         (AutoRecruitScheduler 按计数增量识别"触达平台"的动作);</li>
 *     <li>输出落临时文件(防大输出管道死锁)、统一超时;风控检测复用
 *         {@link CliRiskDetector}(含退出码 0/1/2/3 显式映射);</li>
 *     <li>每账号注入 env:{@code LIEPIN_USER_DATA_DIR}(profile 隔离)与
 *         {@code CUA_SESSION}(会话标签,必须全程一致,W0 实测)。</li>
 * </ul>
 */
@Slf4j
@Component
public class CuaDriverExecutor {

    /** 驱动会话标签前缀(与账号 id 拼接;同一标签贯穿 prepare/bind/ref) */
    static final String SESSION_PREFIX = "hr-agent-";

    /** 账号维度互斥锁(与 CDP 通道共用,见 {@link AccountLocks}) */
    private final AccountLocks accountLocks;

    /** CLI 子进程启动计数(与 CDP 通道共用) */
    private final CliSpawnCounter spawnCounter;

    private final HrAgentProperties properties;

    public CuaDriverExecutor(AccountLocks accountLocks, CliSpawnCounter spawnCounter,
                             HrAgentProperties properties) {
        this.accountLocks = accountLocks;
        this.spawnCounter = spawnCounter;
        this.properties = properties;
    }

    /**
     * 执行 cua-liepin-driver 命令并返回原始结果(不解析)。
     *
     * <p>按账号互斥:同账号任意调用者(队列 worker、调度器内联、手动接口)在此串行,
     * 且与 CDP 通道的调用共用同一把锁;不同账号各自独立仍可并发。
     */
    public CliResult execute(LiepinAccount account, Duration timeout, String... args)
            throws IOException, InterruptedException {
        ReentrantLock lock = accountLocks.lockFor(account);
        lock.lock();
        try {
            return runCli(account, timeout, args);
        } finally {
            lock.unlock();
        }
    }

    /** 已启动的子进程序号(委托共享计数;节拍判定与 CDP 通道同源) */
    public long spawnSeq() {
        return spawnCounter.value();
    }

    /**
     * 实际启动驱动子进程(调用方 {@link #execute} 已持有账号锁)。
     * 抽为 protected 便于测试注入并发探针验证互斥语义。
     */
    protected CliResult runCli(LiepinAccount account, Duration timeout, String... args)
            throws IOException, InterruptedException {
        List<String> command = buildCommand(args);

        ProcessBuilder pb = new ProcessBuilder(command);
        pb.redirectErrorStream(true);
        pb.environment().putAll(buildEnv(account));

        // 输出落盘而非管道读取(与 CDP 通道同因):大输出不会因父进程不读流而死锁,
        // 超时时也能读到部分输出用于诊断。
        Path outputFile = Files.createTempFile("cua-liepin-driver-", ".log");
        try {
            pb.redirectOutput(outputFile.toFile());

            log.info("执行 cua-liepin-driver: {} (account={}, session={})",
                    String.join(" ", args), account.getId(), sessionFor(account));

            Process process = pb.start();
            spawnCounter.increment();
            boolean finished = process.waitFor(timeout.toMillis(), TimeUnit.MILLISECONDS);
            if (!finished) {
                process.destroyForcibly();
                process.waitFor(5, TimeUnit.SECONDS);
                String partial = readOutputQuietly(outputFile);
                log.warn("cua-liepin-driver 超时(account={}, args={}),部分输出: {}",
                        account.getId(), String.join(" ", args), truncate(partial, 500));
                return new CliResult(-1, partial, "", true);
            }
            return new CliResult(process.exitValue(), readOutputQuietly(outputFile), "", false);
        } finally {
            deleteQuietly(outputFile);
        }
    }

    /** 命令:[nodePath, scriptPath, ...args] */
    List<String> buildCommand(String... args) {
        HrAgentProperties.Cua cua = properties.getCua();
        if (cua.getScriptPath() == null || cua.getScriptPath().isBlank()) {
            throw new IllegalStateException(
                    "hr-agent.cua.script-path 未配置(指向 tools/cua-liepin-driver/dist/cli/index.js)");
        }
        List<String> command = new ArrayList<>();
        command.add(cua.getNodePath());
        command.add(cua.getScriptPath());
        for (String arg : args) {
            if (arg != null && !arg.isBlank()) {
                command.add(arg);
            }
        }
        return command;
    }

    /** 子进程环境变量:账号 profile 目录 + 固定会话标签(+ 可选的 cua-driver 路径) */
    Map<String, String> buildEnv(LiepinAccount account) {
        Map<String, String> env = new LinkedHashMap<>();
        env.put("LIEPIN_USER_DATA_DIR", resolveUserDataDir(account));
        env.put("CUA_SESSION", sessionFor(account));
        HrAgentProperties.Cua cua = properties.getCua();
        if (cua.getDriverBin() != null && !cua.getDriverBin().isBlank()) {
            env.put("CUA_DRIVER_BIN", cua.getDriverBin());
        }
        return env;
    }

    /** 驱动会话标签:账号级固定(必须跨调用一致,W0 实测的硬约束) */
    static String sessionFor(LiepinAccount account) {
        return SESSION_PREFIX + (account.getId() == null ? "anonymous" : account.getId());
    }

    /**
     * 检测输出中的风控/登录态特征(双档语义与退出码映射见 {@link CliRiskDetector})。
     */
    public void checkRisk(LiepinAccount account, CliResult result) {
        CliRiskDetector.check(account, result);
    }

    private String resolveUserDataDir(LiepinAccount account) {
        if (account.getUserDataDir() != null && !account.getUserDataDir().isBlank()) {
            return account.getUserDataDir();
        }
        return properties.getLiepin().getDataDirBase() + "/account-" + account.getId();
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
}
