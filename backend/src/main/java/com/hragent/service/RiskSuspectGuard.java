package com.hragent.service;

import com.hragent.config.HrAgentProperties;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.time.LocalDateTime;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Supplier;

/**
 * 疑似风控拦截"冻结-复测"守卫(2026-09-28 节拍改造配套;用户拍板语义)。
 *
 * <p>命中"真实安全验证页"不再立即熔断账号:
 * <ol>
 *     <li><b>首次命中</b> → 冻结退避 {@code riskProbeBackoffMinutes}(默认 15)分钟:
 *         期间全平台操作暂停(轮次循环等待、任务调度器不认领),不标记账号、不告警;</li>
 *     <li><b>冻结到期</b> → 第一个平台操作作为"复测":
 *         成功 → 状态清零、恢复原节奏(轮次继续);再次命中 → 走既有真实熔断链路
 *         (RESTRICTED + 告警)。</li>
 * </ol>
 *
 * <p>{@code riskProbeBackoffMinutes=0} 时回退为"立即熔断"旧语义(逃生阀)。
 *
 * <p>状态为内存态(按账号,{@link ConcurrentHashMap}):进程重启后自动清零——
 * 重启后的第一个平台操作天然充当复测(fail-safe 不放松)。
 * 时间源 {@link #clock} 为测试接缝(同包测试可替换为虚拟时钟)。
 */
@Slf4j
@Service
public class RiskSuspectGuard {

    private final HrAgentProperties properties;

    /** 每账号疑似状态(仅存在于"冻结退避/待复测"期间;复测通过或真实熔断即清除) */
    private final Map<Long, Suspect> suspects = new ConcurrentHashMap<>();

    /** 测试接缝:时间源(生产默认系统时钟;测试可替换为与调度器同步的虚拟时钟) */
    public volatile Supplier<LocalDateTime> clock = LocalDateTime::now;

    public RiskSuspectGuard(HrAgentProperties properties) {
        this.properties = properties;
    }

    /**
     * 命中风控特征时调用。
     *
     * @return true=应走真实熔断链路(冻结期/复测期再次命中,或退避关闭);
     *         false=已进入冻结退避(首次命中,等待到期复测)
     */
    public boolean onRiskHit(Long accountId) {
        int minutes = properties.getAutoRecruit().getRiskProbeBackoffMinutes();
        Suspect current = refresh(accountId);
        if (minutes <= 0) {
            // 逃生阀:回退"立即熔断"旧语义
            suspects.remove(accountId);
            return true;
        }
        if (current != null) {
            // 冻结期内异常命中 / 复测再次命中 → 真实熔断
            suspects.remove(accountId);
            log.warn("账号 {} 在疑似拦截观察期内再次命中风控特征,转入真实熔断", accountId);
            return true;
        }
        suspects.put(accountId, new Suspect(clock.get().plusMinutes(minutes)));
        log.warn("账号 {} 疑似风控拦截,冻结退避 {} 分钟(到期复测一次;期间暂停全部平台操作)",
                accountId, minutes);
        return false;
    }

    /** 任一平台操作成功后调用:处于"待复测"时视为复测通过,状态清零并恢复原节奏 */
    public void onOpSuccess(Long accountId) {
        Suspect current = refresh(accountId);
        if (current != null && current.awaitingProbe) {
            suspects.remove(accountId);
            log.info("账号 {} 复测通过,恢复正常节奏", accountId);
        }
    }

    /** 是否处于冻结退避期(冻结未到期;到期后进入"待复测",不再阻塞操作) */
    public boolean isHolding(Long accountId) {
        Suspect current = refresh(accountId);
        return current != null && !current.awaitingProbe;
    }

    /** 冻结截止时刻(null=无状态);用于等待与日志展示 */
    public LocalDateTime holdUntil(Long accountId) {
        Suspect current = refresh(accountId);
        return current == null ? null : current.until;
    }

    /** 是否已解除冻结、等待第一个平台操作作为复测(供测试与日志) */
    public boolean isAwaitingProbe(Long accountId) {
        Suspect current = refresh(accountId);
        return current != null && current.awaitingProbe;
    }

    /** 惰性状态迁移:冻结到期 → 待复测 */
    private Suspect refresh(Long accountId) {
        Suspect current = suspects.get(accountId);
        if (current != null && !current.awaitingProbe
                && !clock.get().isBefore(current.until)) {
            current.awaitingProbe = true;
            log.info("账号 {} 冻结退避到期,下一个平台操作将作为复测", accountId);
        }
        return current;
    }

    /** 单账号疑似状态(until=冻结截止;awaitingProbe=已解冻待复测) */
    private static final class Suspect {

        private final LocalDateTime until;

        private volatile boolean awaitingProbe;

        private Suspect(LocalDateTime until) {
            this.until = until;
        }
    }
}
