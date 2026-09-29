package com.hragent.ai;

import com.hragent.config.HrAgentProperties;
import io.agentscope.core.ReActAgent;
import io.agentscope.core.agent.RuntimeContext;
import io.agentscope.core.message.Msg;
import io.agentscope.core.message.UserMessage;
import io.agentscope.extensions.model.openai.OpenAIChatModel;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.util.List;
import java.util.concurrent.TimeoutException;

/**
 * AgentScope Java 实现的 AI 调用:
 * 底层 OpenAIChatModel 接 OpenAI 兼容接口(DeepSeek/Qwen/GLM 均可配置 baseUrl/apiKey/model)。
 *
 * 每次调用按动态 systemPrompt 构建轻量 ReActAgent(无工具、单轮推理);
 * 模型实例进程内单例复用。
 */
@Slf4j
@Component
public class AgentScopeAiClient implements AiClient {

    private final OpenAIChatModel model;
    private final HrAgentProperties properties;

    public AgentScopeAiClient(OpenAIChatModel model, HrAgentProperties properties) {
        this.model = model;
        this.properties = properties;
    }

    @Override
    public String chat(String systemPrompt, String userPrompt) {
        ReActAgent agent = ReActAgent.builder()
                .name("task-agent")
                .sysPrompt(systemPrompt)
                .model(model)
                .checkRunning(false)
                .build();

        Duration timeout = Duration.ofSeconds(properties.getAi().getTimeoutSeconds());
        try {
            Msg result = agent.call(List.of(new UserMessage(userPrompt)), RuntimeContext.empty())
                    .block(timeout);
            if (result == null) {
                throw new IllegalStateException("模型调用超时(" + timeout.toSeconds() + "s)");
            }
            return result.getTextContent();
        } catch (Exception e) {
            if (e.getCause() instanceof TimeoutException || e instanceof java.util.concurrent.TimeoutException) {
                throw new IllegalStateException("模型调用超时(" + timeout.toSeconds() + "s)");
            }
            log.error("AgentScope 调用失败", e);
            throw new IllegalStateException("模型调用失败: " + e.getMessage(), e);
        }
    }
}
