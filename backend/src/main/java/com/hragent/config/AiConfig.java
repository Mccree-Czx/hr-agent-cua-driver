package com.hragent.config;

import com.hragent.ai.AgentScopeAiClient;
import io.agentscope.extensions.model.openai.OpenAIChatModel;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class AiConfig {

    /** OpenAI 兼容模型实例(进程内单例,DeepSeek/Qwen/GLM 通过配置切换) */
    @Bean
    public OpenAIChatModel chatModel(HrAgentProperties properties) {
        return OpenAIChatModel.builder()
                .apiKey(properties.getAi().getApiKey())
                .baseUrl(properties.getAi().getBaseUrl())
                .modelName(properties.getAi().getModel())
                .stream(false)
                .build();
    }

    @Bean
    public AgentScopeAiClient agentScopeAiClient(OpenAIChatModel chatModel, HrAgentProperties properties) {
        return new AgentScopeAiClient(chatModel, properties);
    }
}
