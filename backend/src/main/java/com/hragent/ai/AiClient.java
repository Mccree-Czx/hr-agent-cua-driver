package com.hragent.ai;

/** AI 调用抽象层(评审回退策略:AgentScope 阻塞时可切换为直连模型 API 实现) */
public interface AiClient {

    /**
     * 调用模型,返回原始文本输出。
     *
     * @param systemPrompt 系统提示词(评分细则/角色设定)
     * @param userPrompt   用户输入(JD + 候选人快照等)
     */
    String chat(String systemPrompt, String userPrompt);
}
