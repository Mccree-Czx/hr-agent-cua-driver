package com.hragent.service;

import com.hragent.config.HrAgentProperties;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.time.LocalDateTime;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * {@link RiskSuspectGuard} "冻结-复测"状态机测试(2026-09-28 节拍改造):
 * 首次命中冻结 → 到期复测 → 成功清零 / 再命中熔断;逃生阀与多账号隔离。
 */
class RiskSuspectGuardTest {

    private HrAgentProperties properties;
    private RiskSuspectGuard guard;
    private LocalDateTime now = LocalDateTime.of(2026, 9, 28, 10, 0);

    @BeforeEach
    void setUp() {
        properties = new HrAgentProperties();
        properties.getAutoRecruit().setRiskProbeBackoffMinutes(15);
        guard = new RiskSuspectGuard(properties);
        guard.clock = () -> now;
    }

    @Test
    void firstHitFreezesWithoutTripping() {
        assertFalse(guard.onRiskHit(1L), "首次命中应进入冻结(不熔断)");
        assertTrue(guard.isHolding(1L));
        assertFalse(guard.isAwaitingProbe(1L));
        assertEquals(now.plusMinutes(15), guard.holdUntil(1L));
    }

    @Test
    void holdExpiresIntoAwaitingProbe() {
        guard.onRiskHit(1L);
        now = now.plusMinutes(16);

        assertFalse(guard.isHolding(1L), "冻结到期后不再阻塞平台操作");
        assertTrue(guard.isAwaitingProbe(1L), "冻结解除后应等待复测");
    }

    @Test
    void probeSuccessClearsStateAndNewEpisodeCanFreezeAgain() {
        guard.onRiskHit(1L);
        now = now.plusMinutes(16);
        guard.onOpSuccess(1L); // 复测通过

        assertFalse(guard.isAwaitingProbe(1L));
        assertFalse(guard.isHolding(1L));
        assertFalse(guard.onRiskHit(1L), "新一轮命中应重新冻结而非直接熔断");
        assertTrue(guard.isHolding(1L));
    }

    @Test
    void secondHitInProbeWindowTrips() {
        guard.onRiskHit(1L);
        now = now.plusMinutes(16); // 冻结解除,进入待复测

        assertTrue(guard.onRiskHit(1L), "复测再次命中应转入真实熔断");
        assertFalse(guard.isHolding(1L));
        assertFalse(guard.isAwaitingProbe(1L), "熔断后状态应清零");
    }

    @Test
    void hitDuringHoldTrips() {
        guard.onRiskHit(1L);
        now = now.plusMinutes(5); // 冻结期内(异常路径)再次命中

        assertTrue(guard.onRiskHit(1L));
        assertFalse(guard.isHolding(1L));
    }

    @Test
    void escapeValveZeroTripsImmediately() {
        properties.getAutoRecruit().setRiskProbeBackoffMinutes(0);

        assertTrue(guard.onRiskHit(1L), "退避关闭应回退\"立即熔断\"旧语义");
        assertFalse(guard.isHolding(1L));
    }

    @Test
    void accountsIsolated() {
        guard.onRiskHit(1L);

        assertTrue(guard.isHolding(1L));
        assertFalse(guard.isHolding(2L), "多账号状态互不影响");
        assertFalse(guard.isAwaitingProbe(2L));
    }
}
