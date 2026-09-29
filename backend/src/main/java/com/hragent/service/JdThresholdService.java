package com.hragent.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.hragent.ai.AgentSkillLoader;
import com.hragent.ai.AiClient;
import com.hragent.common.BizException;
import com.hragent.entity.Jd;
import com.hragent.executor.JsonExtractor;
import com.hragent.repository.JdMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;

/**
 * 岗位评分门槛(设计 3.3:门槛确认为外发前提)。
 * - suggest:依据 JD 调 AI 生成建议门槛与理由,写入 threshold_suggestion(格式 建议{N}分:{理由});
 *   仅为建议,不构成确认;AI 失败或输出非法 → BizException,不落半成品。
 * - confirm:人工确认/修改门槛(校验 1..100),写 score_threshold + threshold_confirmed_by/at;
 *   threshold_confirmed_at 非空是外发门禁的唯一放行依据(fail-closed)。
 */
@Slf4j
@Service
public class JdThresholdService {

    /** 门槛建议技能名(AgentScope 技能包 agents/skills/jd-threshold-suggest/SKILL.md,2026-09-28 由常量迁移) */
    private static final String THRESHOLD_SKILL = "jd-threshold-suggest";

    private final JdMapper jdMapper;
    private final AiClient aiClient;
    private final AgentSkillLoader skillLoader;

    public JdThresholdService(JdMapper jdMapper, AiClient aiClient, AgentSkillLoader skillLoader) {
        this.jdMapper = jdMapper;
        this.aiClient = aiClient;
        this.skillLoader = skillLoader;
    }

    /** 依据 JD 生成建议门槛并落库 threshold_suggestion,返回建议文本(不构成确认) */
    @Transactional
    public String suggest(Long jdId) {
        Jd jd = requireJd(jdId);
        String output;
        try {
            output = aiClient.chat(skillLoader.load(THRESHOLD_SKILL).systemPrompt(), buildUserPrompt(jd));
        } catch (Exception e) {
            log.warn("岗位 {} 门槛建议 AI 调用失败: {}", jdId, e.getMessage());
            throw BizException.badRequest("门槛建议生成失败: " + e.getMessage());
        }
        int threshold;
        String reason;
        try {
            JsonNode node = JsonExtractor.parse(output).orElseThrow(
                    () -> new IllegalArgumentException("模型输出无 JSON"));
            JsonNode thresholdNode = node.get("threshold");
            if (thresholdNode == null || !thresholdNode.isInt()) {
                throw new IllegalArgumentException("缺少合法 threshold 字段");
            }
            threshold = thresholdNode.asInt();
            if (threshold < 1 || threshold > 100) {
                throw new IllegalArgumentException("threshold 越界: " + threshold);
            }
            reason = node.path("reason").asText("").trim();
        } catch (Exception e) {
            log.warn("岗位 {} 门槛建议输出非法: {}", jdId, e.getMessage());
            throw BizException.badRequest("门槛建议输出非法: " + e.getMessage());
        }
        String suggestion = "建议" + threshold + "分:" + reason;
        jd.setThresholdSuggestion(suggestion);
        jdMapper.updateById(jd);
        return suggestion;
    }

    /** 人工确认门槛:校验 1..100 后写 score_threshold + 确认人/时间(确认时间非空即放行外发) */
    @Transactional
    public Jd confirm(Long jdId, int threshold, Long userId) {
        if (threshold < 1 || threshold > 100) {
            throw BizException.badRequest("门槛分数必须在 1..100 之间: " + threshold);
        }
        Jd jd = requireJd(jdId);
        jd.setScoreThreshold(threshold);
        jd.setThresholdConfirmedBy(userId);
        jd.setThresholdConfirmedAt(LocalDateTime.now());
        jdMapper.updateById(jd);
        log.info("岗位 {} 门槛已确认: {} 分(确认人 {})", jdId, threshold, userId);
        return jd;
    }

    private Jd requireJd(Long jdId) {
        Jd jd = jdId == null ? null : jdMapper.selectById(jdId);
        if (jd == null) {
            throw BizException.notFound("岗位不存在: " + jdId);
        }
        return jd;
    }

    private String buildUserPrompt(Jd jd) {
        StringBuilder sb = new StringBuilder();
        sb.append("## 岗位信息\n");
        sb.append("- 岗位名称: ").append(jd.getTitle()).append("\n");
        sb.append("- 对外 JD: ").append(jd.getExternalJd() == null ? "" : jd.getExternalJd()).append("\n");
        if (jd.getSalaryMin() != null || jd.getSalaryMax() != null) {
            sb.append("- 薪资预算(元/月): ").append(jd.getSalaryMin()).append(" ~ ").append(jd.getSalaryMax()).append("\n");
        }
        if (jd.getExperienceReq() != null) {
            sb.append("- 经验要求: ").append(jd.getExperienceReq()).append("\n");
        }
        if (jd.getDegreeReq() != null) {
            sb.append("- 学历要求: ").append(jd.getDegreeReq()).append("\n");
        }
        sb.append("\n请给出建议的评分通过门槛与理由。\n");
        return sb.toString();
    }
}
