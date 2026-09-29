package com.hragent.ai;

import com.hragent.config.HrAgentProperties;
import io.agentscope.core.skill.AgentSkill;
import io.agentscope.core.skill.repository.ClasspathSkillRepository;
import io.agentscope.core.skill.util.MarkdownSkillParser;
import lombok.extern.slf4j.Slf4j;
import org.springframework.core.io.Resource;
import org.springframework.core.io.ResourceLoader;
import org.springframework.stereotype.Component;

import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * AgentScope 技能加载器(2026-09-28):三处 AI 系统提示词(评分/话术/门槛建议)迁移为
 * {@code agents/skills/<name>/SKILL.md} 技能包后,统一由此加载"技能正文"作 systemPrompt(静态注入;
 * 三处仍为单轮 {@link AiClient#chat},行为与成本不变)。
 *
 * <p>主路径:AgentScope {@link ClasspathSkillRepository} 按目录约定扫描解析(实测 frontmatter 自动剥离、
 * {@code version} 进入 metadata);失败时回退直读 SKILL.md,经同一 {@link MarkdownSkillParser} 解析——
 * 兼容 fat-jar 下目录枚举异常。加载结果进程内缓存:修改 SKILL.md 需重启生效;技能不存在/加载失败抛
 * {@link IllegalStateException}(fail-closed,绝不静默用空提示词调模型)。
 */
@Slf4j
@Component
public class AgentSkillLoader {

    private final HrAgentProperties properties;
    private final ResourceLoader resourceLoader;

    /** 进程内缓存(技能内容变更需重启生效) */
    private final ConcurrentHashMap<String, LoadedSkill> cache = new ConcurrentHashMap<>();

    public AgentSkillLoader(HrAgentProperties properties, ResourceLoader resourceLoader) {
        this.properties = properties;
        this.resourceLoader = resourceLoader;
    }

    /** 已加载技能:name/description/version 取自 frontmatter,systemPrompt=技能正文(不含 frontmatter) */
    public record LoadedSkill(String name, String description, String version, String systemPrompt) {
    }

    /**
     * 加载指定技能(带缓存)。失败抛 {@link IllegalStateException},消息包含技能名与 baseDir(便于诊断)。
     */
    public LoadedSkill load(String skillName) {
        if (skillName == null || skillName.isBlank()) {
            throw new IllegalStateException("技能名不能为空(baseDir=" + skillBaseDir() + ")");
        }
        return cache.computeIfAbsent(skillName, this::doLoad);
    }

    private LoadedSkill doLoad(String skillName) {
        String baseDir = skillBaseDir();
        try {
            AgentSkill skill = new ClasspathSkillRepository(baseDir).getSkill(skillName);
            if (skill == null || skill.getSkillContent() == null) {
                throw new IllegalStateException("技能不存在或正文为空: " + skillName);
            }
            LoadedSkill loaded = new LoadedSkill(skill.getName(), skill.getDescription(),
                    extractVersion(skill.getMetadata()), skill.getSkillContent());
            log.info("已加载 AgentScope 技能: {}@{} ({})", loaded.name(), loaded.version(), baseDir);
            return loaded;
        } catch (Exception primary) {
            log.warn("AgentScope 技能仓库加载失败,回退直读 SKILL.md: {}({}) — {}", skillName, baseDir,
                    primary.getMessage());
            return loadByResource(skillName, baseDir);
        }
    }

    /** 保底回退:直读 classpath:<base>/<name>/SKILL.md,经 AgentScope 解析器取正文与 frontmatter 元数据 */
    private LoadedSkill loadByResource(String skillName, String baseDir) {
        String location = "classpath:" + baseDir + "/" + skillName + "/SKILL.md";
        try {
            Resource resource = resourceLoader.getResource(location);
            String raw = new String(resource.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
            MarkdownSkillParser.ParsedMarkdown parsed = MarkdownSkillParser.parse(raw);
            String content = parsed.getContent();
            if (content == null || content.isBlank()) {
                throw new IllegalStateException("技能正文为空: " + skillName);
            }
            Map<String, Object> metadata = parsed.getMetadata();
            LoadedSkill loaded = new LoadedSkill(
                    metadataText(metadata, "name", skillName),
                    metadataText(metadata, "description", ""),
                    metadataText(metadata, "version", "unknown"),
                    content);
            log.info("已加载 AgentScope 技能(回退直读): {}@{} ({})", loaded.name(), loaded.version(), baseDir);
            return loaded;
        } catch (Exception e) {
            throw new IllegalStateException("技能加载失败: " + skillName + " (baseDir=" + baseDir + ")", e);
        }
    }

    private String skillBaseDir() {
        String baseDir = properties.getAi().getSkillBaseDir();
        return baseDir == null || baseDir.isBlank() ? "agents/skills" : baseDir;
    }

    private static String extractVersion(Map<String, Object> metadata) {
        Object version = metadata == null ? null : metadata.get("version");
        return version == null ? "unknown" : String.valueOf(version);
    }

    private static String metadataText(Map<String, Object> metadata, String key, String fallback) {
        Object value = metadata == null ? null : metadata.get(key);
        return value == null ? fallback : String.valueOf(value);
    }
}
