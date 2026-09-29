package com.hragent.service;

import com.hragent.config.HrAgentProperties;
import com.hragent.entity.LiepinAccount;
import com.hragent.executor.CliException;
import com.hragent.executor.CliResult;
import com.hragent.executor.LiepinCliExecutor;
import com.hragent.notify.NotifyService;
import com.hragent.repository.LiepinAccountMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.time.LocalDateTime;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doReturn;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.spy;
import static org.mockito.Mockito.verify;

/**
 * 风控命中接线的"冻结-复测"语义测试({@link LiepinCommandService} + {@link RiskSuspectGuard},2026-09-28):
 * 首次命中仅冻结(不标记账号/不告警);复测再次命中才置 RESTRICTED + 告警;成功操作清除复测态。
 */
class LiepinCommandServiceRiskTest {

    /** 真实风控页特征文案(captchaPage + safe.liepin.com 均为结构性标记,成功/失败路径都识别) */
    private static final String RISK_PAGE = "302 to safe.liepin.com/captchaPage_PC";

    private HrAgentProperties properties;
    private RiskSuspectGuard guard;
    private LiepinCliExecutor executor;
    private LiepinAccountMapper accounts;
    private NotifyService notify;
    private LiepinCommandService service;
    private LiepinAccount account;

    @BeforeEach
    void setUp() {
        properties = new HrAgentProperties();
        properties.getAutoRecruit().setRiskProbeBackoffMinutes(15);
        guard = new RiskSuspectGuard(properties);
        executor = spy(new LiepinCliExecutor(properties));
        accounts = mock(LiepinAccountMapper.class);
        notify = mock(NotifyService.class);
        service = new LiepinCommandService(executor, accounts, notify, guard);

        account = new LiepinAccount();
        account.setId(1L);
        account.setName("主账号");
        account.setCircuitBreaker(false);
        account.setLoginStatus("NORMAL");
    }

    private void stubCli(String output) throws Exception {
        doReturn(new CliResult(0, output, "", false))
                .when(executor).execute(any(), any(), any(String[].class));
    }

    @Test
    void firstHitFreezesWithoutMarkingAccount() throws Exception {
        stubCli(RISK_PAGE);

        assertThrows(CliException.class, () -> service.chatlist(account, Duration.ofSeconds(5)));

        assertTrue(guard.isHolding(1L), "首次命中应进入冻结退避");
        assertFalse(Boolean.TRUE.equals(account.getCircuitBreaker()), "首次命中不得标记熔断");
        assertEquals("NORMAL", account.getLoginStatus(), "首次命中不得改登录态");
        verify(accounts, never()).updateById(any(LiepinAccount.class));
        verify(notify, never()).alert(anyString(), anyString());
    }

    @Test
    void probeSecondHitTripsAccount() throws Exception {
        stubCli(RISK_PAGE);

        assertThrows(CliException.class, () -> service.chatlist(account, Duration.ofSeconds(5))); // 首次命中→冻结
        assertThrows(CliException.class, () -> service.chatlist(account, Duration.ofSeconds(5))); // 复测再中→熔断

        assertTrue(Boolean.TRUE.equals(account.getCircuitBreaker()));
        assertEquals("RESTRICTED", account.getLoginStatus());
        verify(accounts).updateById(account);
        verify(notify).alert(eq("账号触发风控熔断"), anyString());
    }

    @Test
    void successAfterHoldClearsProbeState() throws Exception {
        stubCli(RISK_PAGE);
        assertThrows(CliException.class, () -> service.chatlist(account, Duration.ofSeconds(5)));

        // 模拟冻结到期:仅需 guard 视角的当前时间越过后即可(复测语义由后续成功操作完成)
        LocalDateTime afterHold = LocalDateTime.now().plusMinutes(16);
        guard.clock = () -> afterHold;

        stubCli("[]");
        service.chatlist(account, Duration.ofSeconds(5)); // 复测成功

        assertFalse(guard.isAwaitingProbe(1L), "复测通过应清除待复测态");
        assertFalse(guard.isHolding(1L));
        assertFalse(Boolean.TRUE.equals(account.getCircuitBreaker()), "复测通过不得标记熔断");
        verify(notify, never()).alert(anyString(), anyString());
    }

    @Test
    void escapeValveZeroTripsImmediately() throws Exception {
        properties.getAutoRecruit().setRiskProbeBackoffMinutes(0);
        stubCli(RISK_PAGE);

        assertThrows(CliException.class, () -> service.chatlist(account, Duration.ofSeconds(5)));

        assertTrue(Boolean.TRUE.equals(account.getCircuitBreaker()), "退避关闭应回退\"立即熔断\"");
        assertFalse(guard.isHolding(1L));
        verify(notify).alert(eq("账号触发风控熔断"), anyString());
    }
}
