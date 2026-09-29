package com.hragent.controller;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.hragent.common.ApiResponse;
import com.hragent.dto.DashboardSummary;
import com.hragent.entity.Candidate;
import com.hragent.entity.Jd;
import com.hragent.entity.ResumeFile;
import com.hragent.repository.CandidateMapper;
import com.hragent.repository.JdMapper;
import com.hragent.repository.ResumeFileMapper;
import com.hragent.security.LoginUser;
import com.hragent.security.UserContext;
import com.hragent.service.UserJdService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;
import java.util.stream.Collectors;

/**
 * 驾驶舱聚合端点（参照 HR Portal V2）：业务 KPI + 最新入库简历。
 * 全部按当前用户授权岗位范围过滤（ADMIN 不限，HR 仅其授权岗位）；
 * 自动化状态卡由前端复用 GET /api/auto-recruit/status（ADMIN 专用），不在此聚合。
 */
@RestController
@RequestMapping("/api/dashboard")
public class DashboardController {

    private static final int LATEST_RESUME_LIMIT = 8;

    private final CandidateMapper candidateMapper;
    private final JdMapper jdMapper;
    private final ResumeFileMapper resumeFileMapper;
    private final UserJdService userJdService;

    public DashboardController(CandidateMapper candidateMapper, JdMapper jdMapper,
                               ResumeFileMapper resumeFileMapper, UserJdService userJdService) {
        this.candidateMapper = candidateMapper;
        this.jdMapper = jdMapper;
        this.resumeFileMapper = resumeFileMapper;
        this.userJdService = userJdService;
    }

    @GetMapping("/summary")
    public ApiResponse<DashboardSummary> summary() {
        LoginUser user = UserContext.get();
        Set<Long> allowed = userJdService.allowedJdIds(user.getUserId(), user.getRole());
        boolean scoped = allowed != null;

        // 岗位（按授权范围）
        List<Jd> jobs = jdMapper.selectList(null).stream()
                .filter(j -> !scoped || allowed.contains(j.getId()))
                .toList();
        long activeJobs = jobs.stream().filter(j -> "ACTIVE".equals(j.getStatus())).count();
        long confirmedJobs = jobs.stream().filter(j -> j.getScoringPrefConfirmedAt() != null).count();
        Map<Long, String> jdTitles = jobs.stream().collect(Collectors.toMap(Jd::getId, Jd::getTitle, (a, b) -> a));

        // 候选人（按授权范围）
        List<Candidate> candidates = candidateMapper.selectList(null).stream()
                .filter(c -> !scoped || (c.getJdId() != null && allowed.contains(c.getJdId())))
                .toList();
        Map<Long, Candidate> candidateById = candidates.stream()
                .collect(Collectors.toMap(Candidate::getId, Function.identity(), (a, b) -> a));

        // 已收简历（授权范围内的入库记录，按最新排序）
        List<ResumeFile> scopedResumes = resumeFileMapper.selectList(
                        new LambdaQueryWrapper<ResumeFile>().orderByDesc(ResumeFile::getId)).stream()
                .filter(f -> candidateById.containsKey(f.getCandidateId()))
                .toList();
        Set<Long> withResumeIds = scopedResumes.stream()
                .map(ResumeFile::getCandidateId)
                .collect(Collectors.toSet());

        // 招聘跟进状态计数（分母 = 已收简历，与候选人"已收简历"页签口径一致）
        long pendingReview = 0;
        long qualified = 0;
        long interviewScheduled = 0;
        long notSuitable = 0;
        for (Candidate c : candidates) {
            if (!withResumeIds.contains(c.getId())) {
                continue;
            }
            String status = c.getRecruitStatus() == null ? "PENDING_REVIEW" : c.getRecruitStatus();
            switch (status) {
                case "QUALIFIED" -> qualified++;
                case "INTERVIEW_SCHEDULED" -> interviewScheduled++;
                case "NOT_SUITABLE" -> notSuitable++;
                default -> pendingReview++;
            }
        }

        List<DashboardSummary.LatestResume> latest = scopedResumes.stream()
                .limit(LATEST_RESUME_LIMIT)
                .map(f -> {
                    Candidate c = candidateById.get(f.getCandidateId());
                    return new DashboardSummary.LatestResume(
                            f.getCandidateId(),
                            c == null ? null : c.getName(),
                            c == null || c.getJdId() == null ? null : jdTitles.get(c.getJdId()),
                            c == null ? null : c.getScore(),
                            c == null ? null : c.getStar(),
                            f.getCreatedAt());
                })
                .toList();

        return ApiResponse.ok(new DashboardSummary(
                new DashboardSummary.Jobs(jobs.size(), activeJobs, confirmedJobs),
                new DashboardSummary.Candidates(candidates.size(), withResumeIds.size()),
                new DashboardSummary.RecruitStatusCounts(pendingReview, qualified, interviewScheduled, notSuitable),
                latest));
    }
}
