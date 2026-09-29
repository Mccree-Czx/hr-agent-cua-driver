package com.hragent.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.metadata.IPage;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.hragent.common.BizException;
import com.hragent.entity.Jd;
import com.hragent.repository.JdMapper;
import com.hragent.security.UserContext;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Set;

@Service
public class JdService {

    private final JdMapper jdMapper;
    private final OpLogService opLogService;
    private final UserJdService userJdService;

    public JdService(JdMapper jdMapper, OpLogService opLogService, UserJdService userJdService) {
        this.jdMapper = jdMapper;
        this.opLogService = opLogService;
        this.userJdService = userJdService;
    }

    public IPage<Jd> page(int pageNo, int pageSize, String status) {
        LambdaQueryWrapper<Jd> qw = new LambdaQueryWrapper<Jd>()
                .eq(status != null && !status.isBlank(), Jd::getStatus, status)
                .orderByDesc(Jd::getId);
        // 权限:非 ADMIN 只可见被分配岗位(评审 P1-8)
        Set<Long> allowed = userJdService.allowedJdIds(
                UserContext.get().getUserId(), UserContext.get().getRole());
        if (allowed != null) {
            qw.in(allowed.isEmpty(), Jd::getId, -1L);
            if (!allowed.isEmpty()) {
                qw.in(Jd::getId, allowed);
            }
        }
        return jdMapper.selectPage(new Page<>(pageNo, pageSize), qw);
    }

    public Jd get(Long id) {
        Jd jd = jdMapper.selectById(id);
        if (jd == null) {
            throw BizException.notFound("岗位不存在");
        }
        return jd;
    }

    @Transactional
    public Jd create(Jd jd) {
        jd.setId(null);
        jd.setStatus("ACTIVE");
        stripThresholdConfirmation(jd);
        jdMapper.insert(jd);
        opLogService.log("CREATE", "jd", jd.getId(), "创建岗位: " + jd.getTitle());
        return get(jd.getId());
    }

    @Transactional
    public Jd update(Long id, Jd jd) {
        get(id);
        jd.setId(id);
        stripThresholdConfirmation(jd);
        jdMapper.updateById(jd);
        opLogService.log("UPDATE", "jd", id, "更新岗位: " + jd.getTitle());
        return get(id);
    }

    /**
     * 屏蔽通用 JD 接口对门槛确认字段的写入(评审 Critical-1):
     * 门槛只能经 {@link JdThresholdService#confirm} 写入,防止任一登录用户经 POST/PUT /api/jd
     * 直接注入 scoreThreshold/thresholdConfirmedAt 绕过确认校验放行自动外发;
     * updateById 忽略 null 字段,故不会误清既有确认值。
     */
    private void stripThresholdConfirmation(Jd jd) {
        jd.setScoreThreshold(null);
        jd.setThresholdSuggestion(null);
        jd.setThresholdConfirmedBy(null);
        jd.setThresholdConfirmedAt(null);
        // 评分偏好字段(2026-09-29):只能经 /api/jd/{id}/scoring-preference 写入,
        // 防止任一登录用户经 POST/PUT /api/jd 注入 confirmed 字段绕过外发门禁(同 Critical-1 口径)
        jd.setScoringPrefConfirmedAt(null);
        jd.setScoringPrefConfirmedBy(null);
        jd.setMinCommStar(null);
        jd.setBonusPoints(null);
        jd.setVetoPoints(null);
        jd.setOtherRequirements(null);
    }

    /** 评分偏好文本域约束(与前端一致):≤10 行、行≤50 字 */
    private static final int PREF_MAX_LINES = 10;
    private static final int PREF_MAX_LINE_LENGTH = 50;

    /**
     * 保存并确认评分偏好(2026-09-29 星级模型):保存=确认(scoring_pref_confirmed_at/by),
     * 确认即放行该岗位自动外发(fail-closed 门禁);文本域校验行数/行宽。
     */
    @Transactional
    public Jd updateScoringPreference(Long id, Integer minCommStar, String bonusPoints,
                                      String vetoPoints, String otherRequirements, Long userId) {
        Jd jd = get(id);
        if (minCommStar == null || minCommStar < 1 || minCommStar > 5) {
            throw BizException.badRequest("最低主动沟通星级必须在 1-5 之间");
        }
        jd.setMinCommStar(minCommStar);
        jd.setBonusPoints(validatePreferenceText(bonusPoints, "加分点"));
        jd.setVetoPoints(validatePreferenceText(vetoPoints, "一票否决点"));
        jd.setOtherRequirements(validatePreferenceText(otherRequirements, "其他要求"));
        jd.setScoringPrefConfirmedBy(userId);
        jd.setScoringPrefConfirmedAt(LocalDateTime.now());
        jdMapper.updateById(jd);
        opLogService.log("UPDATE", "jd", id, "保存并确认评分偏好(最低星级 " + minCommStar + ")");
        return get(id);
    }

    /** 偏好文本规范化+校验:去空白行,行数与行宽超限 400;空文本归一为 null */
    private static String validatePreferenceText(String text, String field) {
        if (text == null || text.isBlank()) {
            return null;
        }
        String normalized = text.replace("\r\n", "\n").replace("\r", "\n").trim();
        List<String> lines = normalized.lines().map(String::trim).filter(s -> !s.isEmpty()).toList();
        if (lines.size() > PREF_MAX_LINES) {
            throw BizException.badRequest(field + " 最多 " + PREF_MAX_LINES + " 行,当前 " + lines.size() + " 行");
        }
        for (String line : lines) {
            if (line.length() > PREF_MAX_LINE_LENGTH) {
                throw BizException.badRequest(field + " 每行不超过 " + PREF_MAX_LINE_LENGTH + " 字: " + line);
            }
        }
        return String.join("\n", lines);
    }

    @Transactional
    public void delete(Long id) {
        get(id);
        jdMapper.deleteById(id);
        opLogService.log("DELETE", "jd", id, "删除岗位");
    }
}
