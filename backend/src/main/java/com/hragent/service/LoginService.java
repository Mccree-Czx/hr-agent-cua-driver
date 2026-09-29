package com.hragent.service;

import com.hragent.entity.LiepinAccount;
import com.hragent.executor.CliResult;
import com.hragent.executor.LiepinCliExecutor;
import com.hragent.repository.LiepinAccountMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 扫码登录落点(评审 P2-12):
 * - 后台线程执行 liepin login(有头浏览器窗口弹出,本机扫码)
 * - 解析 CLI 输出判断登录结果,同步更新账号 login_status
 * - Web 端通过轮询账号状态确认登录完成
 */
@Slf4j
@Service
public class LoginService {

    private final LiepinCliExecutor executor;
    private final LiepinAccountMapper accountMapper;
    private final ExecutorService loginPool = Executors.newFixedThreadPool(2);
    /** 正在登录中的账号:accountId -> 开始时间戳 */
    private final Map<Long, Long> loggingIn = new ConcurrentHashMap<>();

    public LoginService(LiepinCliExecutor executor, LiepinAccountMapper accountMapper) {
        this.executor = executor;
        this.accountMapper = accountMapper;
    }

    /** 发起扫码登录(异步):已在登录中的账号直接返回 */
    public synchronized void startLogin(Long accountId) {
        LiepinAccount account = accountMapper.selectById(accountId);
        if (account == null) {
            throw new IllegalArgumentException("账号不存在: " + accountId);
        }
        if (loggingIn.containsKey(accountId)) {
            return;
        }
        loggingIn.put(accountId, System.currentTimeMillis());
        loginPool.submit(() -> {
            try {
                doLogin(account);
            } finally {
                loggingIn.remove(accountId);
            }
        });
    }

    public boolean isLoggingIn(Long accountId) {
        return loggingIn.containsKey(accountId);
    }

    private void doLogin(LiepinAccount account) {
        log.info("账号 {} 发起扫码登录,浏览器窗口已弹出,请扫码(最长等待 3 分钟)", account.getId());
        try {
            // login 命令内部等待扫码(约 120s),给足超时
            CliResult result = executor.execute(account, Duration.ofMinutes(3), "login", "--json");
            String output = result.combined();
            boolean success = output.contains("登录成功") || output.contains("\"success\": true")
                    || output.contains("\"success\":true");
            LiepinAccount fresh = accountMapper.selectById(account.getId());
            if (success) {
                fresh.setLoginStatus("NORMAL");
                fresh.setCircuitBreaker(false);
                log.info("账号 {} 扫码登录成功", account.getId());
            } else {
                fresh.setLoginStatus("NEED_SCAN");
                log.warn("账号 {} 登录未完成(超时或取消): {}", account.getId(), abbreviate(output));
            }
            accountMapper.updateById(fresh);
        } catch (Exception e) {
            log.error("账号 {} 登录流程异常: {}", account.getId(), e.getMessage());
            LiepinAccount fresh = accountMapper.selectById(account.getId());
            if (fresh != null) {
                fresh.setLoginStatus("NEED_SCAN");
                accountMapper.updateById(fresh);
            }
        }
    }

    private String abbreviate(String s) {
        return s == null || s.length() <= 200 ? s : s.substring(0, 200);
    }
}
