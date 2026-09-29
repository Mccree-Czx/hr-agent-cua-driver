package com.hragent.controller;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.hragent.common.ApiResponse;
import com.hragent.dto.RecruitRunRequest;
import com.hragent.entity.Candidate;
import com.hragent.repository.CandidateMapper;
import com.hragent.scoring.ScoringEngine;
import com.hragent.service.GreetingService;
import com.hragent.service.ResumeCollectService;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** 招聘流程接口:评分、重新打分、打招呼 */
@RestController
@RequestMapping("/api/recruit")
public class RecruitFlowController {

    private final ScoringEngine scoringEngine;
    private final GreetingService greetingService;
    private final ResumeCollectService resumeCollectService;
    private final CandidateMapper candidateMapper;

    public RecruitFlowController(ScoringEngine scoringEngine, GreetingService greetingService,
                                 ResumeCollectService resumeCollectService,
                                 CandidateMapper candidateMapper) {
        this.scoringEngine = scoringEngine;
        this.greetingService = greetingService;
        this.resumeCollectService = resumeCollectService;
        this.candidateMapper = candidateMapper;
    }

    /** 对岗位下 PENDING 候选人评分(上限 limit) */
    @PostMapping("/score")
    public ApiResponse<Map<String, Object>> score(@Valid @RequestBody RecruitRunRequest request) {
        List<Candidate> candidates = candidateMapper.selectList(new LambdaQueryWrapper<Candidate>()
                .eq(Candidate::getJdId, request.getJdId())
                .eq(Candidate::getPassStatus, "PENDING")
                .last("LIMIT " + Math.max(1, Math.min(request.getLimit(), 100))));
        int passCount = 0;
        for (Candidate candidate : candidates) {
            scoringEngine.scoreAndSave(candidate.getId());
            Candidate after = candidateMapper.selectById(candidate.getId());
            if ("PASS".equals(after.getPassStatus())) {
                passCount++;
            }
        }
        Map<String, Object> result = new HashMap<>();
        result.put("scored", candidates.size());
        result.put("passed", passCount);
        return ApiResponse.ok(result);
    }

    /** 单个候选人重新打分(评审 P2-11:Web 手动重新打分) */
    @PostMapping("/score/{candidateId}/redo")
    public ApiResponse<Void> redo(@PathVariable Long candidateId) {
        scoringEngine.scoreAndSave(candidateId);
        return ApiResponse.ok(null);
    }

    /** 对岗位下评分通过且未联系的候选人打招呼(上限 limit) */
    @PostMapping("/greet")
    public ApiResponse<Map<String, Object>> greet(@Valid @RequestBody RecruitRunRequest request) {
        int created = greetingService.greetPassed(request.getJdId(), request.getLimit());
        Map<String, Object> result = new HashMap<>();
        result.put("greeted", created);
        return ApiResponse.ok(result);
    }

    /** 简历收集:检测候选人回复并索要简历(上限 limit) */
    @PostMapping("/collect")
    public ApiResponse<Map<String, Object>> collect(@Valid @RequestBody RecruitRunRequest request) {
        int processed = resumeCollectService.collectForJd(request.getJdId(), request.getLimit());
        Map<String, Object> result = new HashMap<>();
        result.put("processed", processed);
        return ApiResponse.ok(result);
    }
}
