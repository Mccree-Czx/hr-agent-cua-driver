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
 *   经共享 {@link AccountLocks} 互斥(2026-09-29 W1 起与 UI 通道 CuaDriverExecutor 共用同一把锁),
 *   执行子进程前 lock、finally unlock;不同账号各自的锁互不影响,仍可并发。
 * - 平台足迹计数委托共享 {@link CliSpawnCounter}(UI 通道同源,节拍判定不变)。
 */
@Slf4j
@Component
public class LiepinCliExecutor {

    private static final int BASE_DEBUG_PORT = 53471;
    
    /** 账号维度互斥锁(与 UI 通道共用,见 {@link AccountLocks}) */
    private final AccountLocks accountLocks;
    
    /** CLI 子进程启动计数(与 UI 通道共用,供上层节拍判定"本单元是否触达平台") */
    private final CliSpawnCounter spawnCounter;
    
    private final HrAgentProperties properties;
    
    public LiepinCliExecutor(HrAgentProperties properties, AccountLocks accountLocks,
                             CliSpawnCounter spawnCounter) {
        this.properties = properties;
        this.accountLocks = accountLocks;
        this.spawnCounter = spawnCounter;
    }
    
    /** 已启动的 CLI 子进程序号(含超时/失败尝试;空转会話等纯记账单元不增长,不参与平台节拍) */
    public long spawnSeq() {
        return spawnCounter.value();
    }

    /**
     * 执行 CLI 命令并返回原始结果(不解析)。
     *
     * <p>按账号互斥(终审 I1):同账号任意调用者(队列 worker、调度器内联、手动接口)在此串行,
     * 执行子进程前 lock、finally unlock;不同账号各自独立仍可并发。
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
            spawnCounter.increment();
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
     * 检测输出中的风控/登录态特征(双档语义与退出码映射见 {@link CliRiskDetector})。
     * 风控优先(风控页往往同时含登录提示)。
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
