package com.hragent;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.hragent.config.AutoRecruitScheduler;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.annotation.Transactional;

import java.util.Map;

import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * AutoRecruitController 手动触发端点测试:
 * <ul>
 *     <li>开启 hr-agent.auto-recruit.enabled 以注册调度器与控制器 bean(与生产一致)</li>
 *     <li>mock AutoRecruitScheduler,避免真实触发多岗位编排</li>
 * </ul>
 */
@SpringBootTest(properties = "hr-agent.auto-recruit.enabled=true")
@AutoConfigureMockMvc
@ActiveProfiles("test")
@Transactional
class AutoRecruitControllerTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    @MockitoBean
    private AutoRecruitScheduler autoRecruitScheduler;

    @Test
    void adminCanTriggerRunOnce() throws Exception {
        String token = TestAuthHelper.loginAsAdmin(mockMvc, objectMapper);

        mockMvc.perform(post("/api/auto-recruit/run-once").header("Authorization", "Bearer " + token))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(0));

        verify(autoRecruitScheduler).runRoundInternal();
    }

    @Test
    void nonAdminForbidden() throws Exception {
        String adminToken = TestAuthHelper.loginAsAdmin(mockMvc, objectMapper);

        // admin 创建一个 HR 角色用户
        mockMvc.perform(post("/api/user")
                        .header("Authorization", "Bearer " + adminToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "username", "hr_ar01",
                                "password", "hr123456",
                                "role", "HR"))))
                .andExpect(status().isOk());

        // HR 触发手动端点应被拒绝(403),且不执行编排
        String hrToken = TestAuthHelper.login(mockMvc, objectMapper, "hr_ar01", "hr123456");
        mockMvc.perform(post("/api/auto-recruit/run-once").header("Authorization", "Bearer " + hrToken))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value(403));

        verifyNoInteractions(autoRecruitScheduler);
    }
}
