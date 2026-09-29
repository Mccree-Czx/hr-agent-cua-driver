package com.hragent.controller;

import com.hragent.common.BizException;
import com.hragent.dto.CandidateDetail;
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
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.transaction.annotation.Transactional;

import java.nio.charset.StandardCharsets;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 简历下载接口测试(HR 筛选工作台):
 * ADMIN 或分配岗位内可下载;越权 403;未入库/文件缺失/候选人不存在 404。
 * 真实 mapper(H2)+ 真实本地存储(target/test-resumes)。
 */
@SpringBootTest
@ActiveProfiles("test")
@Transactional
class CandidateResumeTest {

    private static final byte[] PDF = "%PDF-1.4\nresume-download-test".getBytes(StandardCharsets.UTF_8);

    @Autowired
    private CandidateController candidateController;

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

    private Long createJd() {
        Jd jd = new Jd();
        jd.setTitle("测试岗位");
        jd.setStatus("ACTIVE");
        jdMapper.insert(jd);
        return jd.getId();
    }

    private Candidate createCandidate(Long jdId) {
        Candidate candidate = new Candidate();
        candidate.setResumeId("r-resume-" + System.nanoTime());
        candidate.setName("测试候选人");
        candidate.setPassStatus("PASS");
        candidate.setJdId(jdId);
        candidateMapper.insert(candidate);
        return candidate;
    }

    private void storeResume(Candidate candidate) {
        String objectKey = "test/" + candidate.getId() + "-简历.pdf";
        storageService.save(objectKey, PDF, "application/pdf");
        ResumeFile file = new ResumeFile();
        file.setCandidateId(candidate.getId());
        file.setBucket(objectKey);
        file.setObjectKey(objectKey);
        file.setFormat("pdf");
        file.setSize((long) PDF.length);
        file.setSha256("test-sha");
        resumeFileMapper.insert(file);
    }

    private static LoginUser admin() {
        return new LoginUser(1L, "admin", "ADMIN");
    }

    private static LoginUser hr(long id) {
        return new LoginUser(id, "hr" + id, "HR");
    }

    @Test
    void adminDownloadsResume() {
        Candidate candidate = createCandidate(createJd());
        storeResume(candidate);
        UserContext.set(admin());

        ResponseEntity<byte[]> response = candidateController.resume(candidate.getId());

        assertEquals(200, response.getStatusCode().value());
        assertArrayEquals(PDF, response.getBody());
        assertNotNull(response.getHeaders().getContentType());
        assertTrue(response.getHeaders().getContentType().toString().contains("application/pdf"));
        String disposition = response.getHeaders().getFirst("Content-Disposition");
        assertNotNull(disposition);
        assertTrue(disposition.contains("inline"), "应可直接预览(不强制下载)");
        assertTrue(disposition.contains(".pdf"), "文件名应保留 pdf 后缀");
    }

    @Test
    void assignedHrDownloadsResume() {
        Long jdId = createJd();
        userJdService.assign(99L, jdId);
        Candidate candidate = createCandidate(jdId);
        storeResume(candidate);
        UserContext.set(hr(99L));

        ResponseEntity<byte[]> response = candidateController.resume(candidate.getId());

        assertEquals(200, response.getStatusCode().value());
        assertArrayEquals(PDF, response.getBody());
    }

    @Test
    void unassignedHrForbidden() {
        Candidate candidate = createCandidate(createJd());
        storeResume(candidate);
        UserContext.set(hr(98L)); // 未分配该岗位

        BizException e = assertThrows(BizException.class,
                () -> candidateController.resume(candidate.getId()));
        assertEquals(403, e.getCode());
    }

    @Test
    void candidateWithoutJdForbiddenForHr() {
        userJdService.assign(97L, createJd()); // HR 有分配,但候选人无岗位(待分配池)
        Candidate candidate = createCandidate(null);
        storeResume(candidate);
        UserContext.set(hr(97L));

        BizException e = assertThrows(BizException.class,
                () -> candidateController.resume(candidate.getId()));
        assertEquals(403, e.getCode());
    }

    @Test
    void notArchivedNotFound() {
        Candidate candidate = createCandidate(createJd());
        UserContext.set(admin());

        BizException e = assertThrows(BizException.class,
                () -> candidateController.resume(candidate.getId()));
        assertEquals(404, e.getCode());
    }

    @Test
    void missingStoredFileNotFound() {
        Candidate candidate = createCandidate(createJd());
        ResumeFile file = new ResumeFile();
        file.setCandidateId(candidate.getId());
        file.setObjectKey("test/not-exists-" + candidate.getId() + ".pdf");
        file.setFormat("pdf");
        file.setSize(1L);
        resumeFileMapper.insert(file);
        UserContext.set(admin());

        BizException e = assertThrows(BizException.class,
                () -> candidateController.resume(candidate.getId()));
        assertEquals(404, e.getCode(), "元数据在但存储缺失应 404");
    }

    @Test
    void candidateNotExistsNotFound() {
        UserContext.set(admin());

        BizException e = assertThrows(BizException.class,
                () -> candidateController.resume(999999L));
        assertEquals(404, e.getCode());
    }

    // ---------- 读标记(参照 HR Portal V2:预览成功记录最后查看人/时间,2026-09-28) ----------

    @Test
    void resumePreviewRecordsLastViewer() {
        Candidate candidate = createCandidate(createJd());
        storeResume(candidate);
        UserContext.set(admin());

        candidateController.resume(candidate.getId());

        Candidate after = candidateMapper.selectById(candidate.getId());
        assertNotNull(after.getResumeLastViewedAt(), "预览成功应写入最后查看时间");
        assertEquals(1L, after.getResumeLastViewedBy(), "最后查看人应为当前用户");
    }

    // ---------- 招聘跟进状态(HR 筛选工作台,2026-09-28) ----------

    @Test
    void adminUpdatesRecruitStatus() {
        Candidate candidate = createCandidate(createJd());
        UserContext.set(admin());

        Candidate updated = candidateController.setRecruitStatus(
                candidate.getId(), new CandidateController.RecruitStatusRequest("QUALIFIED")).getData();

        assertEquals("QUALIFIED", updated.getRecruitStatus());
        assertEquals("QUALIFIED", candidateMapper.selectById(candidate.getId()).getRecruitStatus());
    }

    @Test
    void invalidRecruitStatusRejected() {
        Candidate candidate = createCandidate(createJd());
        UserContext.set(admin());

        BizException e = assertThrows(BizException.class, () -> candidateController.setRecruitStatus(
                candidate.getId(), new CandidateController.RecruitStatusRequest("NOT_A_STATUS")));
        assertEquals(400, e.getCode());
    }

    @Test
    void unassignedHrCannotUpdateRecruitStatus() {
        Candidate candidate = createCandidate(createJd());
        UserContext.set(hr(96L)); // 未分配该岗位

        BizException e = assertThrows(BizException.class, () -> candidateController.setRecruitStatus(
                candidate.getId(), new CandidateController.RecruitStatusRequest("QUALIFIED")));
        assertEquals(403, e.getCode());
    }

    @Test
    void detailExposesResumeAndFileName() {
        Candidate candidate = createCandidate(createJd());
        storeResume(candidate);
        UserContext.set(admin());

        CandidateDetail detail = candidateController.detail(candidate.getId()).getData();

        assertEquals(candidate.getId(), detail.getCandidate().getId());
        assertNotNull(detail.getResumeFile());
        assertNotNull(detail.getResumeFileName());
        assertTrue(detail.getResumeFileName().endsWith(".pdf"));
    }
}
