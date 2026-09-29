package com.hragent.dto;

import java.time.LocalDateTime;
import java.util.List;

/**
 * 驾驶舱聚合摘要（参照 HR Portal V2 驾驶舱：业务 KPI + 最新入库简历）。
 * 口径：候选人相关计数按当前用户授权岗位范围过滤；招聘状态计数以"已收简历"为分母
 * （与候选人列表"已收简历"页签口径一致，避免同指标两个数）。
 */
public record DashboardSummary(
        Jobs jobs,
        Candidates candidates,
        RecruitStatusCounts recruit,
        List<LatestResume> latestResumes) {

    public record Jobs(long total, long active, long thresholdConfirmed) {
    }

    public record Candidates(long total, long withResume) {
    }

    public record RecruitStatusCounts(long pendingReview, long qualified, long interviewScheduled, long notSuitable) {
    }

    public record LatestResume(Long candidateId, String name, String jdTitle, Integer score, Integer star,
                               LocalDateTime resumeCreatedAt) {
    }
}
