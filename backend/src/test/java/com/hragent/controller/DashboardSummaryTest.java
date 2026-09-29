package com.hragent.controller;

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
import com.hragent.storage.StorageService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.transaction.annotation.Transactional;

import java.nio.charset.StandardCharsets;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 驾驶舱聚合口径测试(2026-09-28):
 * KPI 计数与"已收简历"页签口径一致(招聘状态分母=已收简历);HR 按授权岗位范围过滤。
 * 共享 H2 可能有历史行(其他测试),一律用基线增量断言。
 */
@SpringBootTest
@ActiveProfiles("test")
@Transactional
class DashboardSummaryTest {

    private static final byte[] PDF = "%PDF-1.4\nresume".getBytes(StandardCharsets.UTF_8);

    @Autowired
    private DashboardController dashboardController;

    @Autowired
    private CandidateMapper candidateMapper;

    @Autowired
    private JdMapper jdMapper;

    @Autowired
    private ResumeFileMapper resumeFileMapper;

    @Autowired
    private UserJdService userJdService;

    @Autowired
    private StorageService storageService;

    @AfterEach
    void tearDown() {
        UserContext.clear();
    }

    private Jd createJd(String title) {
        Jd jd = new Jd();
        jd.setTitle(title);
        jd.setStatus("ACTIVE");
        jdMapper.insert(jd);
        return jd;
    }

    private Candidate createCandidate(Long jdId, String name) {
        Candidate candidate = new Candidate();
        candidate.setResumeId("r-dash-" + System.nanoTime());
        candidate.setName(name);
        candidate.setPassStatus("PASS");
        candidate.setJdId(jdId);
        candidateMapper.insert(candidate);
        return candidate;
    }

    private void storeResume(Candidate candidate) {
        String objectKey = "test/dash-" + candidate.getId() + "-简历.pdf";
        storageService.save(objectKey, PDF, "application/pdf");
        ResumeFile file = new ResumeFile();
        file.setCandidateId(candidate.getId());
        file.setObjectKey(objectKey);
        file.setFormat("pdf");
        file.setSize((long) PDF.length);
        resumeFileMapper.insert(file);
    }

    @Test
    void countsMatchReceivedResumeScope() {
        long baseCandidates = candidateMapper.selectCount(null);
        long baseJobs = jdMapper.selectCount(null);

        Jd jd = createJd("驾驶舱测试岗位");
        Candidate withResume = createCandidate(jd.getId(), "驾驶舱-已入库");
        withResume.setRecruitStatus("QUALIFIED");
        candidateMapper.updateById(withResume);
        storeResume(withResume);
        createCandidate(jd.getId(), "驾驶舱-未入库"); // 未入库:不计入 recruit 分母

        UserContext.set(new LoginUser(1L, "admin", "ADMIN"));
        DashboardSummary summary = dashboardController.summary().getData();

        assertEquals(baseJobs + 1, summary.jobs().total());
        assertEquals(baseCandidates + 2, summary.candidates().total(), "候选人库=全量");
        // 已收简历增量(本测试新入库 1 份)
        assertTrue(summary.candidates().withResume() >= 1);
        // 招聘状态分母=已收简历:本测试合格增量
        assertTrue(summary.recruit().qualified() >= 1);
        // 最新列表包含本测试入库的候选人(最新 id)
        List<DashboardSummary.LatestResume> latest = summary.latestResumes();
        assertTrue(latest.stream().anyMatch(r -> withResume.getId().equals(r.candidateId())),
                "最新入库简历应包含刚入库的候选人");
    }

    @Test
    void hrSeesOnlyAssignedJdScope() {
        Jd assignedJd = createJd("驾驶舱-授权岗位");
        Jd otherJd = createJd("驾驶舱-未授权岗位");
        userJdService.assign(95L, assignedJd.getId());

        Candidate visible = createCandidate(assignedJd.getId(), "驾驶舱-授权候选人");
        Candidate hidden = createCandidate(otherJd.getId(), "驾驶舱-未授权候选人");

        UserContext.set(new LoginUser(95L, "hr95", "HR"));
        DashboardSummary summary = dashboardController.summary().getData();

        assertTrue(summary.candidates().total() >= 1);
        List<Long> ids = summary.latestResumes().stream().map(DashboardSummary.LatestResume::candidateId).toList();
        assertFalse(ids.contains(hidden.getId()), "未授权岗位候选人不得出现在摘要中");
        assertFalse(summary.jobs().total() == 0, "授权岗位应计入");
        assertEquals(1, summary.jobs().total(), "HR 仅看到授权岗位(本测试仅分配 1 个)");
        // visible 未被要求必须出现在最新列表(无简历),仅验证范围过滤
        assertEquals("驾驶舱-授权候选人", candidateMapper.selectById(visible.getId()).getName());
    }
}
