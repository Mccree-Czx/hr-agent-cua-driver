package com.hragent.ai;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.ActiveProfiles;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * {@link AgentSkillLoader} 技能包加载测试(2026-09-28 三处 AI 提示词迁移):
 * 迁移保真断言(正文不含 frontmatter 头、关键段落齐全、version 正确)+ 未知技能 fail-closed。
 */
@SpringBootTest
@ActiveProfiles("test")
class AgentSkillLoaderTest {

    @Autowired
    private AgentSkillLoader loader;

    @Test
    void resumeScoringSkillLoadedVerbatim() {
        AgentSkillLoader.LoadedSkill skill = loader.load("resume-scoring");

        assertEquals("resume-scoring", skill.name());
        assertEquals("0.2.0", skill.version(), "version 应取自 frontmatter");
        String prompt = skill.systemPrompt();
        assertFalse(prompt.startsWith("---"), "systemPrompt 不应含 frontmatter 头");
        assertFalse(prompt.contains("name: resume-scoring"), "systemPrompt 不应含 frontmatter 键");
        assertTrue(prompt.contains("星级标准"), "应含星级标准段落(2026-09-29 v0.2.0)");
        assertTrue(prompt.contains("veto_suspects"), "应含疑似否决输出字段");
        assertTrue(prompt.contains("有交集即视为满足"), "薪资口径应为区间有交集即满足");
    }

    @Test
    void greetingWritingSkillLoaded() {
        AgentSkillLoader.LoadedSkill skill = loader.load("greeting-writing");

        assertEquals("0.1.0", skill.version());
        String prompt = skill.systemPrompt();
        assertFalse(prompt.isBlank(), "话术技能正文不能为空");
        assertTrue(prompt.contains("话术"), "应含话术正文特征段");
        assertTrue(prompt.contains("20-40 字"), "应含原文话术约束");
    }

    @Test
    void jdThresholdSkillLoaded() {
        AgentSkillLoader.LoadedSkill skill = loader.load("jd-threshold-suggest");

        String prompt = skill.systemPrompt();
        assertTrue(prompt.contains("threshold"), "应含 threshold JSON 结构关键词");
        assertTrue(prompt.contains("reason"), "应含 reason JSON 结构关键词");
    }

    @Test
    void unknownSkillFailsClosed() {
        IllegalStateException e = assertThrows(IllegalStateException.class,
                () -> loader.load("no-such-skill"));

        assertTrue(e.toString().contains("no-such-skill"), "错误信息应包含技能名与 baseDir 便于诊断");
    }
}
