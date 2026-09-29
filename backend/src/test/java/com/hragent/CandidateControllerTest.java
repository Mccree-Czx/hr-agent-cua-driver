package com.hragent;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.hragent.entity.Candidate;
import com.hragent.entity.Jd;
import com.hragent.entity.ResumeFile;
import com.hragent.repository.CandidateMapper;
import com.hragent.repository.JdMapper;
import com.hragent.repository.ResumeFileMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.annotation.Transactional;

import java.util.Map;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 候选人库视图过滤测试(Task 5 / 设计 §3.4、§4.3):
 * - hasResumeFile=true:仅返回存在 resume_file 入库记录的候选人(「已收简历」视图)
 * - unassigned=true:仅返回 jd_id 为空或指向已不存在岗位者(「待分配」视图)
 * - 组合过滤生效;缺省(不传参)保持原有行为
 */
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
@Transactional
class CandidateControllerTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private CandidateMapper candidateMapper;

    @Autowired
    private ResumeFileMapper resumeFileMapper;

    @Autowired
    private JdMapper jdMapper;

    private String token() throws Exception {
        return TestAuthHelper.loginAsAdmin(mockMvc, objectMapper);
    }

    @BeforeEach
    void clean() {
        resumeFileMapper.delete(new LambdaQueryWrapper<>());
        candidateMapper.delete(new LambdaQueryWrapper<>());
        jdMapper.delete(new LambdaQueryWrapper<>());
    }

    private Jd seedJd(String title) {
        Jd jd = new Jd();
        jd.setTitle(title);
        jdMapper.insert(jd);
        return jd;
    }

    private Candidate seedCandidate(String name, Long jdId) {
        Candidate candidate = new Candidate();
        candidate.setResumeId("resume-" + name);
        candidate.setName(name);
        candidate.setPassStatus("PENDING");
        candidate.setJdId(jdId);
        candidateMapper.insert(candidate);
        return candidate;
    }

    private void seedResumeFile(Long candidateId) {
        ResumeFile file = new ResumeFile();
        file.setCandidateId(candidateId);
        file.setBucket("test-bucket");
        file.setObjectKey("test-key-" + candidateId);
        file.setFormat("pdf");
        file.setSize(1024L);
        file.setSha256("deadbeef");
        resumeFileMapper.insert(file);
    }

    /** 缺省查询(不传新参数)应返回全部候选人,原有行为不变 */
    @Test
    void defaultQueryReturnsAllCandidatesUnchanged() throws Exception {
        Jd jd = seedJd("默认查询岗位");
        seedCandidate("默认甲", jd.getId());
        seedCandidate("默认乙", null);

        mockMvc.perform(get("/api/candidate").header("Authorization", "Bearer " + token()))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(0))
                .andExpect(jsonPath("$.data.total").value(2))
                .andExpect(jsonPath("$.data.records.length()").value(2));
    }

    /** hasResumeFile=true 仅返回有入库附件的候选人 */
    @Test
    void hasResumeFileFilterReturnsOnlyCandidatesWithResume() throws Exception {
        Jd jd = seedJd("附件过滤岗位");
        Candidate withFile = seedCandidate("有附件", jd.getId());
        seedCandidate("无附件", jd.getId());
        seedResumeFile(withFile.getId());

        mockMvc.perform(get("/api/candidate").header("Authorization", "Bearer " + token())
                        .param("hasResumeFile", "true"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.total").value(1))
                .andExpect(jsonPath("$.data.records[0].candidate.name").value("有附件"))
                .andExpect(jsonPath("$.data.records[0].resumeFile.format").value("pdf"));
    }

    /** hasResumeFile=false 视为不过滤,行为与缺省一致 */
    @Test
    void hasResumeFileFalseDoesNotFilter() throws Exception {
        Jd jd = seedJd("附件不过滤岗位");
        seedCandidate("甲", jd.getId());
        seedCandidate("乙", jd.getId());

        mockMvc.perform(get("/api/candidate").header("Authorization", "Bearer " + token())
                        .param("hasResumeFile", "false"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.total").value(2));
    }

    /** unassigned=true 仅返回 jd_id 为空或指向不存在岗位者 */
    @Test
    void unassignedFilterReturnsNullOrMissingJdCandidates() throws Exception {
        Jd jd = seedJd("在岗岗位");
        seedCandidate("已分配", jd.getId());
        seedCandidate("无岗位", null);
        seedCandidate("失效岗位", 999999L);

        mockMvc.perform(get("/api/candidate").header("Authorization", "Bearer " + token())
                        .param("unassigned", "true"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.total").value(2))
                .andExpect(jsonPath("$.data.records.length()").value(2));
    }

    /** 组合过滤:unassigned=true 且 hasResumeFile=true */
    @Test
    void unassignedCombinedWithHasResumeFile() throws Exception {
        Jd jd = seedJd("组合岗位");
        Candidate fileUnassigned = seedCandidate("待分配有附件", null);
        seedResumeFile(fileUnassigned.getId());
        Candidate fileAssigned = seedCandidate("已分配有附件", jd.getId());
        seedResumeFile(fileAssigned.getId());
        seedCandidate("待分配无附件", null);

        mockMvc.perform(get("/api/candidate").header("Authorization", "Bearer " + token())
                        .param("unassigned", "true")
                        .param("hasResumeFile", "true"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.total").value(1))
                .andExpect(jsonPath("$.data.records[0].candidate.name").value("待分配有附件"));
    }

    /** 组合过滤:jdId 与 hasResumeFile 同时生效 */
    @Test
    void jdIdFilterCombinedWithHasResumeFile() throws Exception {
        Jd jdA = seedJd("岗位A");
        Jd jdB = seedJd("岗位B");
        Candidate a = seedCandidate("A有附件", jdA.getId());
        seedResumeFile(a.getId());
        seedCandidate("A无附件", jdA.getId());
        Candidate b = seedCandidate("B有附件", jdB.getId());
        seedResumeFile(b.getId());

        mockMvc.perform(get("/api/candidate").header("Authorization", "Bearer " + token())
                        .param("jdId", String.valueOf(jdA.getId()))
                        .param("hasResumeFile", "true"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.total").value(1))
                .andExpect(jsonPath("$.data.records[0].candidate.name").value("A有附件"));
    }

    /** 无任何入库附件时,hasResumeFile=true 返回空分页而非报错 */
    @Test
    void emptyResumeFileTableYieldsEmptyPage() throws Exception {
        Jd jd = seedJd("空附件岗位");
        seedCandidate("某人", jd.getId());

        mockMvc.perform(get("/api/candidate").header("Authorization", "Bearer " + token())
                        .param("hasResumeFile", "true"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.total").value(0))
                .andExpect(jsonPath("$.data.records").isEmpty());
    }

    /** 无任何有效岗位时,unassigned=true 仍可返回全部孤立候选人,不依赖岗位存在 */
    @Test
    void unassignedWithNoJdAtAllReturnsAllOrphans() throws Exception {
        seedCandidate("孤立甲", null);
        seedCandidate("孤立乙", 888888L);

        mockMvc.perform(get("/api/candidate").header("Authorization", "Bearer " + token())
                        .param("unassigned", "true"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.total").value(2));
    }

    /**
     * 评审 I-1:unassigned=true 仅 ADMIN 生效。非 ADMIN 请求该参数时返回空分页(与既有空分页处理一致,不报 500),
     * 避免越权读取全系统无岗位/岗位已删候选人池。
     */
    @Test
    void unassignedForbiddenForNonAdminReturnsEmptyPage() throws Exception {
        seedCandidate("孤立甲", null);
        seedCandidate("孤立乙", 777777L);

        String adminToken = token();
        mockMvc.perform(post("/api/user")
                        .header("Authorization", "Bearer " + adminToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "username", "hr-unassigned",
                                "password", "hr123456",
                                "role", "HR"))))
                .andExpect(status().isOk());
        String hrToken = TestAuthHelper.login(mockMvc, objectMapper, "hr-unassigned", "hr123456");

        mockMvc.perform(get("/api/candidate").header("Authorization", "Bearer " + hrToken)
                        .param("unassigned", "true"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(0))
                .andExpect(jsonPath("$.data.total").value(0))
                .andExpect(jsonPath("$.data.records").isEmpty());
    }

    /** ADMIN 请求 unassigned=true 仍正常返回孤立候选人(I-1 收口不得误伤 ADMIN) */
    @Test
    void unassignedForAdminStillReturnsOrphans() throws Exception {
        Jd jd = seedJd("正常岗位");
        seedCandidate("已分配", jd.getId());
        seedCandidate("无岗位", null);

        mockMvc.perform(get("/api/candidate").header("Authorization", "Bearer " + token())
                        .param("unassigned", "true"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(0))
                .andExpect(jsonPath("$.data.total").value(1))
                .andExpect(jsonPath("$.data.records[0].candidate.name").value("无岗位"));
    }
}
