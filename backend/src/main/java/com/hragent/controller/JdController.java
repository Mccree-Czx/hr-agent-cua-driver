package com.hragent.controller;

import com.baomidou.mybatisplus.core.metadata.IPage;
import com.hragent.common.ApiResponse;
import com.hragent.common.BizException;
import com.hragent.entity.Jd;
import com.hragent.security.LoginUser;
import com.hragent.security.RequireRole;
import com.hragent.security.UserContext;
import com.hragent.service.JdPublishService;
import com.hragent.service.JdService;
import com.hragent.service.JdThresholdService;
import com.hragent.service.LiepinJobSyncService;
import com.hragent.service.UserJdService;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/jd")
public class JdController {

    private final JdService jdService;
    private final JdPublishService jdPublishService;
    private final LiepinJobSyncService jobSyncService;
    private final JdThresholdService thresholdService;
    private final UserJdService userJdService;

    public JdController(JdService jdService, JdPublishService jdPublishService,
                        LiepinJobSyncService jobSyncService, JdThresholdService thresholdService,
                        UserJdService userJdService) {
        this.jdService = jdService;
        this.jdPublishService = jdPublishService;
        this.jobSyncService = jobSyncService;
        this.thresholdService = thresholdService;
        this.userJdService = userJdService;
    }

    @GetMapping
    public ApiResponse<IPage<Jd>> page(@RequestParam(defaultValue = "1") int pageNo,
                                       @RequestParam(defaultValue = "10") int pageSize,
                                       @RequestParam(required = false) String status) {
        return ApiResponse.ok(jdService.page(pageNo, pageSize, status));
    }

    @GetMapping("/{id}")
    public ApiResponse<Jd> get(@PathVariable Long id) {
        return ApiResponse.ok(jdService.get(id));
    }

    @PostMapping
    public ApiResponse<Jd> create(@Valid @RequestBody Jd jd) {
        return ApiResponse.ok(jdService.create(jd));
    }

    @PutMapping("/{id}")
    public ApiResponse<Jd> update(@PathVariable Long id, @RequestBody Jd jd) {
        return ApiResponse.ok(jdService.update(id, jd));
    }

    /** 评分偏好读取(2026-09-29 星级模型):最低主动沟通星级 + 三个文本域 + 确认状态 */
    @GetMapping("/{id}/scoring-preference")
    public ApiResponse<ScoringPreferenceResponse> scoringPreference(@PathVariable Long id) {
        Jd jd = jdService.get(id);
        return ApiResponse.ok(new ScoringPreferenceResponse(
                jd.getMinCommStar() == null ? 3 : jd.getMinCommStar(),
                jd.getBonusPoints(), jd.getVetoPoints(), jd.getOtherRequirements(),
                jd.getScoringPrefConfirmedAt(), jd.getScoringPrefConfirmedBy()));
    }

    /**
     * 保存并确认评分偏好(2026-09-29):保存=确认(写 scoring_pref_confirmed_at/by),
     * 确认后该岗位才允许自动外发(fail-closed 门禁唯一放行依据);仅 ADMIN。
     */
    @RequireRole("ADMIN")
    @PutMapping("/{id}/scoring-preference")
    public ApiResponse<Jd> saveScoringPreference(@PathVariable Long id,
                                                 @RequestBody ScoringPreferenceRequest request) {
        LoginUser user = UserContext.get();
        return ApiResponse.ok(jdService.updateScoringPreference(id,
                request == null ? null : request.minCommStar(),
                request == null ? null : request.bonusPoints(),
                request == null ? null : request.vetoPoints(),
                request == null ? null : request.otherRequirements(),
                user == null ? null : user.getUserId()));
    }

    public record ScoringPreferenceRequest(Integer minCommStar, String bonusPoints,
                                           String vetoPoints, String otherRequirements) {
    }

    public record ScoringPreferenceResponse(Integer minCommStar, String bonusPoints, String vetoPoints,
                                            String otherRequirements, java.time.LocalDateTime confirmedAt,
                                            Long confirmedBy) {
    }

    /** 删除岗位:有关联猎聘职位时同步删除猎聘职位(先删猎聘成功后删系统记录) */
    @DeleteMapping("/{id}")
    public ApiResponse<Void> delete(@PathVariable Long id) {
        jdPublishService.deleteWithSync(id);
        return ApiResponse.ok(null);
    }

    /** 发布到猎聘(草稿→正式上线;已发布拒绝重复;import 是公开不可逆动作) */
    @PostMapping("/{id}/publish")
    public ApiResponse<Jd> publish(@PathVariable Long id) {
        return ApiResponse.ok(jdPublishService.publish(id));
    }

    /** 同步猎聘在招职位到系统岗位管理(按职位 ID 幂等) */
    @PostMapping("/sync-liepin")
    public ApiResponse<java.util.Map<String, Integer>> syncLiepin(
            @RequestParam(required = false) Long accountId) {
        return ApiResponse.ok(jobSyncService.sync(accountId));
    }

    /** AI 生成建议门槛与理由(仅建议,不构成确认) */
    @PostMapping("/{id}/threshold/suggest")
    public ApiResponse<String> suggestThreshold(@PathVariable Long id) {
        requireJdPermission(id);
        return ApiResponse.ok(thresholdService.suggest(id));
    }

    /** 人工确认门槛(1..100);确认后该岗位才允许自动外发 */
    @PutMapping("/{id}/threshold/confirm")
    public ApiResponse<Jd> confirmThreshold(@PathVariable Long id,
                                            @RequestBody ThresholdConfirmRequest request) {
        requireJdPermission(id);
        Long userId = UserContext.get() == null ? null : UserContext.get().getUserId();
        return ApiResponse.ok(thresholdService.confirm(id, request.threshold(), userId));
    }

    /**
     * 门槛接口岗位授权校验(跨任务安全观察):仅 ADMIN 或该岗位已分配给当前用户可操作,
     * 否则任一登录 HR 可为他人岗位打开自动外发。无权限抛 403。
     */
    private void requireJdPermission(Long jdId) {
        LoginUser user = UserContext.get();
        java.util.Set<Long> allowed = userJdService.allowedJdIds(user.getUserId(), user.getRole());
        if (allowed != null && !allowed.contains(jdId)) {
            throw BizException.forbidden("无权操作该岗位门槛");
        }
    }

    /** 门槛确认请求体 */
    public record ThresholdConfirmRequest(int threshold) {
    }
}
