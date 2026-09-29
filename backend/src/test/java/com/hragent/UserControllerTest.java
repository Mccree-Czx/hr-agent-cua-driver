package com.hragent;

import com.fasterxml.jackson.databind.ObjectMapper;
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

@SpringBootTest
@AutoConfigureMockMvc
@ActiveProfiles("test")
@Transactional
class UserControllerTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Test
    void adminCanAccessUserApi() throws Exception {
        String token = TestAuthHelper.loginAsAdmin(mockMvc, objectMapper);
        mockMvc.perform(get("/api/user").header("Authorization", "Bearer " + token))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(0));
    }

    @Test
    void hrCannotAccessUserApi() throws Exception {
        String adminToken = TestAuthHelper.loginAsAdmin(mockMvc, objectMapper);

        // admin 创建一个 HR 角色用户
        mockMvc.perform(post("/api/user")
                        .header("Authorization", "Bearer " + adminToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "username", "hr01",
                                "password", "hr123456",
                                "role", "HR"))))
                .andExpect(status().isOk());

        // HR 登录后访问 /api/user 应被拒绝(403)
        String hrToken = TestAuthHelper.login(mockMvc, objectMapper, "hr01", "hr123456");
        mockMvc.perform(get("/api/user").header("Authorization", "Bearer " + hrToken))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value(403));
    }

    @Test
    void hrCanAccessJdApi() throws Exception {
        String adminToken = TestAuthHelper.loginAsAdmin(mockMvc, objectMapper);

        mockMvc.perform(post("/api/user")
                        .header("Authorization", "Bearer " + adminToken)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "username", "hr02",
                                "password", "hr123456",
                                "role", "HR"))))
                .andExpect(status().isOk());

        String hrToken = TestAuthHelper.login(mockMvc, objectMapper, "hr02", "hr123456");
        mockMvc.perform(get("/api/jd").header("Authorization", "Bearer " + hrToken))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(0));
    }
}
