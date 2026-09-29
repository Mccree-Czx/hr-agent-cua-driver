package com.hragent.controller;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.metadata.IPage;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.fasterxml.jackson.databind.JsonNode;
import com.hragent.common.ApiResponse;
import com.hragent.common.BizException;
import com.hragent.config.AutoRecruitScheduler;
import com.hragent.entity.AutoRecruitRound;
import com.hragent.entity.LiepinAccount;
import com.hragent.executor.CliException;
import com.hragent.repository.AutoRecruitRoundMapper;
import com.hragent.repository.LiepinAccountMapper;
import com.hragent.security.RequireRole;
import com.hragent.service.AutoRecruitSettingService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.time.LocalDateTime;
import java.time.ZoneId;
import java.util.List;

/**
 * 自动招聘状态与操作端点(ADMIN;仅 ADMIN 可见/可操作,HR 前端不展示):
 * <ul>
 *     <li>{@code GET  /api/auto-recruit/status} :开关态/运行中/上轮摘要/下次运行/账号告警(顶部常驻面板)</li>
 *     <li>{@code PUT  /api/auto-recruit/enabled}:运行时开关(存库持久化;OFF=只收不联)</li>
 *     <li>{@code POST /api/auto-recruit/run-once}:手动补跑一轮(不受开关限制,受轮次互斥约束)</li>
 * </ul>
 * 2026-09-26 改造:去掉 @ConditionalOnProperty——端点常驻;开关由库中设置决定,
 * 启动配置仅作首次种子(见 {@link AutoRecruitSettingService})。
 */
@RestController
@RequestMapping("/api/auto-recruit")
@RequireRole("ADMIN")
public class AutoRecruitController {

    private static final ZoneId ZONE = ZoneId.of("Asia/Shanghai");

    private final AutoRecruitScheduler autoRecruitScheduler;
    private final AutoRecruitSettingService settingService;
    private final LiepinAccountMapper accountMapper;
    private final AutoRecruitRoundMapper roundMapper;

    public AutoRecruitController(AutoRecruitScheduler autoRecruitScheduler,
                                 AutoRecruitSettingService settingService,
                                 LiepinAccountMapper accountMapper,
                                 AutoRecruitRoundMapper roundMapper) {
        this.autoRecruitScheduler = autoRecruitScheduler;
        this.settingService = settingService;
        this.accountMapper = accountMapper;
        this.roundMapper = roundMapper;
    }

    /** 手动执行一轮自动招聘编排(绕过时段门禁与外发开关;轮次运行中则拒绝) */
    @PostMapping("/run-once")
    public ApiResponse<Void> runOnce() {
        try {
            autoRecruitScheduler.runRoundInternal();
        } catch (CliException e) {
            // 轮次被中断(风控/登录态等):熔断与告警链路已在上游处理,这里向前端返回可读原因而非 500
            throw new BizException(400, e.getMessage());
        }
        return ApiResponse.ok(null);
    }

    /** 运行状态(前端顶部面板:开关 + 上次/下次 + 运行中 + 账号告警) */
    @GetMapping("/status")
    public ApiResponse<AutoRecruitStatus> status() {
        return ApiResponse.ok(buildStatus());
    }

    /** 运行历史(轮次摘要,倒序分页;运行日志页,参照 HR Portal V2) */
    @GetMapping("/rounds")
    public ApiResponse<IPage<AutoRecruitRound>> rounds(@RequestParam(defaultValue = "1") int pageNo,
                                                       @RequestParam(defaultValue = "20") int pageSize) {
        Page<AutoRecruitRound> page = roundMapper.selectPage(
                new Page<>(Math.max(1, pageNo), Math.min(Math.max(1, pageSize), 100)),
                new LambdaQueryWrapper<AutoRecruitRound>().orderByDesc(AutoRecruitRound::getId));
        return ApiResponse.ok(page);
    }

    /** 运行时开关(存库持久化,重启/部署保持) */
    @PutMapping("/enabled")
    public ApiResponse<AutoRecruitStatus> setEnabled(@RequestBody EnabledRequest request) {
        settingService.setEnabled(request.enabled());
        return ApiResponse.ok(buildStatus());
    }

    private AutoRecruitStatus buildStatus() {
        return new AutoRecruitStatus(
                settingService.isEnabled(),
                autoRecruitScheduler.isRunning(),
                autoRecruitScheduler.getRunningSince(),
                settingService.lastRun().orElse(null),
                AutoRecruitScheduler.nextRunAt(LocalDateTime.now(ZONE)),
                accountWarning());
    }

    /**
     * 账号告警(与实际调度口径一致):存在 login_status=NORMAL 的账号 → null;
     * 否则按主账号状态给出可读原因(熔断/未登录/受限/未配置)。
     */
    private String accountWarning() {
        List<LiepinAccount> accounts = accountMapper.selectList(new LambdaQueryWrapper<LiepinAccount>()
                .orderByAsc(LiepinAccount::getId));
        if (accounts.isEmpty()) {
            return "未配置猎聘账号,自动任务无法运行";
        }
        boolean anyUsable = accounts.stream()
                .anyMatch(a -> "NORMAL".equals(a.getLoginStatus()));
        if (anyUsable) {
            return null;
        }
        LiepinAccount primary = accounts.get(0);
        if (Boolean.TRUE.equals(primary.getCircuitBreaker())) {
            return "账号已熔断,自动任务已暂停(完成安全验证后恢复)";
        }
        if ("NEED_SCAN".equals(primary.getLoginStatus())) {
            return "账号未登录,请扫码登录后恢复";
        }
        return "账号受限,自动任务已暂停";
    }

    /** 开关请求体 */
    public record EnabledRequest(boolean enabled) {
    }

    /** 运行状态视图 */
    public record AutoRecruitStatus(boolean enabled, boolean running, LocalDateTime runningSince,
                                    JsonNode lastRun, LocalDateTime nextRunAt, String accountWarning) {
    }
}
