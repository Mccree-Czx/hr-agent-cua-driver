package com.hragent;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.hragent.dto.LoginRequest;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/** 测试辅助:登录并返回 JWT token */
public final class TestAuthHelper {

    private TestAuthHelper() {
    }

    public static String login(MockMvc mockMvc, ObjectMapper objectMapper, String username, String password)
            throws Exception {
        LoginRequest request = new LoginRequest();
        request.setUsername(username);
        request.setPassword(password);

        String body = mockMvc.perform(post("/api/auth/login")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(request)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.token").isNotEmpty())
                .andReturn().getResponse().getContentAsString();

        JsonNode node = objectMapper.readTree(body);
        return node.path("data").path("token").asText();
    }

    public static String loginAsAdmin(MockMvc mockMvc, ObjectMapper objectMapper) throws Exception {
        return login(mockMvc, objectMapper, "admin", "admin123");
    }
}
