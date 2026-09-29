package com.hragent.controller;

import com.baomidou.mybatisplus.core.conditions.Wrapper;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.hragent.common.BizException;
import com.hragent.config.AutoRecruitScheduler;
import com.hragent.entity.LiepinAccount;
import com.hragent.repository.LiepinAccountMapper;
import com.hragent.service.AutoRecruitSettingService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.hragent.repository.AutoRecruitRoundMapper;

/**
 * AutoRecruitController 单元测试(纯 Mockito,不起 Spring 上下文):
 * 状态组装 / 账号告警口径 / 开关持久化委派 / 手动触发委派与互斥异常透传。
 */
class AutoRecruitControllerTest {

    private AutoRecruitScheduler scheduler;
    private AutoRecruitSettingService settingService;
    private LiepinAccountMapper accountMapper;
    private AutoRecruitRoundMapper roundMapper;
    private AutoRecruitController controller;

    private final ObjectMapper objectMapper = new ObjectMapper();

    @BeforeEach
    void setUp() {
        scheduler = mock(AutoRecruitScheduler.class);
        settingService = mock(AutoRecruitSettingService.class);
        accountMapper = mock(LiepinAccountMapper.class);
        roundMapper = mock(AutoRecruitRoundMapper.class);
        controller = new AutoRecruitController(scheduler, settingService, accountMapper, roundMapper);
    }

    private LiepinAccount account(String loginStatus, boolean circuitBreaker) {
        LiepinAccount account = new LiepinAccount();
        account.setName("主账号");
        account.setLoginStatus(loginStatus);
        account.setCircuitBreaker(circuitBreaker);
        return account;
    }

    private void stubAccounts(LiepinAccount... accounts) {
        when(accountMapper.selectList(any(Wrapper.class))).thenReturn(List.of(accounts));
    }

    @Test
    void statusAssemblesRuntimeFields() throws Exception {
        when(settingService.isEnabled()).thenReturn(false);
        when(scheduler.isRunning()).thenReturn(true);
        LocalDateTime since = LocalDateTime.of(2026, 9, 26, 16, 0, 5);
        when(scheduler.getRunningSince()).thenReturn(since);
        when(settingService.lastRun())
                .thenReturn(Optional.of(objectMapper.readTree("{\"greeted\":3,\"mode\":\"collectOnly\"}")));
        stubAccounts();

        AutoRecruitController.AutoRecruitStatus status = controller.status().getData();

        assertFalse(status.enabled(), "开关状态来自运行时设置");
        assertTrue(status.running());
        assertEquals(since, status.runningSince());
        assertEquals(3, status.lastRun().path("greeted").asInt());
        assertEquals("collectOnly", status.lastRun().path("mode").asText());
        assertNotNull(status.nextRunAt(), "下次运行时间始终可计算(轮次不因开关停止)");
        assertEquals("未配置猎聘账号,自动任务无法运行", status.accountWarning());
    }

    @Test
    void statusWarnsWhenAccountCircuitBroken() {
        when(settingService.isEnabled()).thenReturn(true);
        when(scheduler.isRunning()).thenReturn(false);
        when(settingService.lastRun()).thenReturn(Optional.empty());
        stubAccounts(account("RESTRICTED", true));

        AutoRecruitController.AutoRecruitStatus status = controller.status().getData();

        assertEquals("账号已熔断,自动任务已暂停(完成安全验证后恢复)", status.accountWarning());
    }

    @Test
    void statusWarnsWhenAccountNeedsScan() {
        when(settingService.isEnabled()).thenReturn(true);
        when(scheduler.isRunning()).thenReturn(false);
        when(settingService.lastRun()).thenReturn(Optional.empty());
        stubAccounts(account("NEED_SCAN", false));

        AutoRecruitController.AutoRecruitStatus status = controller.status().getData();

        assertEquals("账号未登录,请扫码登录后恢复", status.accountWarning());
    }

    @Test
    void statusNoWarningWhenAccountNormal() {
        when(settingService.isEnabled()).thenReturn(true);
        when(scheduler.isRunning()).thenReturn(false);
        when(settingService.lastRun()).thenReturn(Optional.empty());
        stubAccounts(account("NORMAL", false));

        AutoRecruitController.AutoRecruitStatus status = controller.status().getData();

        assertNull(status.accountWarning(), "可用账号存在时不应有告警");
    }

    @Test
    void setEnabledPersistsAndReturnsStatus() {
        when(settingService.isEnabled()).thenReturn(true);
        when(scheduler.isRunning()).thenReturn(false);
        when(settingService.lastRun()).thenReturn(Optional.empty());
        stubAccounts(account("NORMAL", false));

        AutoRecruitController.AutoRecruitStatus status = controller.setEnabled(
                new AutoRecruitController.EnabledRequest(true)).getData();

        verify(settingService).setEnabled(true);
        assertTrue(status.enabled());
        assertNull(status.accountWarning());
    }

    @Test
    void runOnceDelegatesToScheduler() {
        controller.runOnce();

        verify(scheduler).runRoundInternal();
    }

    @Test
    void runOncePropagatesRunningConflict() {
        doThrow(BizException.badRequest("已有轮次正在运行,请稍后再试"))
                .when(scheduler).runRoundInternal();

        assertThrows(BizException.class, () -> controller.runOnce(),
                "轮次互斥拒绝应透传(由全局异常处理器映射)");
    }
}
