package com.hragent;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.hragent.entity.Candidate;
import com.hragent.entity.LiepinAccount;
import com.hragent.executor.CliException;
import com.hragent.repository.CandidateMapper;
import com.hragent.repository.LiepinAccountMapper;
import com.hragent.service.LiepinCommandService;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.annotation.Transactional;

import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 候选人"在线简历"端点测试(2026-09-28):实时拉取(mock CLI)+ 读标记 + 异常路径。
 */
@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
@Transactional
class CandidateOnlineResumeTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private CandidateMapper candidateMapper;

    @Autowired
    private LiepinAccountMapper accountMapper;

    @MockitoBean
    private LiepinCommandService commandService;

    @Test
    void adminGetsOnlineResumeAndReadMarkerWritten() throws Exception {
        String token = TestAuthHelper.loginAsAdmin(mockMvc, objectMapper);
        Candidate candidate = seedCandidate();
        seedNormalAccount();

        when(commandService.resume(any(), eq("e27ddee194f2Oc3f00ac2472a"), any()))
                .thenReturn(Optional.of(objectMapper.readTree(
                        "{\"name\":\"张三\",\"want_title\":\"跨境电商运营\",\"work_history\":\"2020-2024 某公司 / 运营\"}")));

        mockMvc.perform(post("/api/candidate/" + candidate.getId() + "/online-resume")
                        .header("Authorization", "Bearer " + token))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(0))
                .andExpect(jsonPath("$.data.name").value("张三"))
                .andExpect(jsonPath("$.data.want_title").value("跨境电商运营"));

        Candidate after = candidateMapper.selectById(candidate.getId());
        assertNotNull(after.getResumeLastViewedAt(), "查看在线简历应写入读标记时间");
        assertNotNull(after.getResumeLastViewedBy(), "查看在线简历应写入读标记人");
    }

    @Test
    void noNormalAccountReturnsBadRequest() throws Exception {
        String token = TestAuthHelper.loginAsAdmin(mockMvc, objectMapper);
        Candidate candidate = seedCandidate();
        // 清掉可能存在的 NORMAL 种子账号(事务内,测试结束回滚)
        accountMapper.delete(new LambdaQueryWrapper<LiepinAccount>()
                .eq(LiepinAccount::getLoginStatus, "NORMAL"));

        mockMvc.perform(post("/api/candidate/" + candidate.getId() + "/online-resume")
                        .header("Authorization", "Bearer " + token))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value(400))
                .andExpect(jsonPath("$.message").value(org.hamcrest.Matchers.containsString("无可用猎聘账号")));
    }

    @Test
    void riskControlExceptionReturnsReadableMessage() throws Exception {
        String token = TestAuthHelper.loginAsAdmin(mockMvc, objectMapper);
        Candidate candidate = seedCandidate();
        seedNormalAccount();

        when(commandService.resume(any(), any(), any()))
                .thenThrow(new CliException(CliException.Type.RISK_CONTROL, "检测到风控拦截特征 [安全验证]"));

        mockMvc.perform(post("/api/candidate/" + candidate.getId() + "/online-resume")
                        .header("Authorization", "Bearer " + token))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value(400))
                .andExpect(jsonPath("$.message").value(org.hamcrest.Matchers.containsString("风控")));
    }

    private Candidate seedCandidate() {
        Candidate candidate = new Candidate();
        candidate.setResumeId("e27ddee194f2Oc3f00ac2472a");
        candidate.setName("测试候选人");
        candidate.setSnapshot("{\"resume_id\":\"e27ddee194f2Oc3f00ac2472a\"}");
        candidate.setPassStatus("PASS");
        candidate.setRecruitStatus("PENDING_REVIEW");
        candidateMapper.insert(candidate);
        return candidate;
    }

    private void seedNormalAccount() {
        LiepinAccount account = new LiepinAccount();
        account.setName("测试账号");
        account.setLoginStatus("NORMAL");
        account.setCircuitBreaker(false);
        account.setGreetMode("AUTO");
        account.setDailyGreetQuota(50);
        accountMapper.insert(account);
    }
}
