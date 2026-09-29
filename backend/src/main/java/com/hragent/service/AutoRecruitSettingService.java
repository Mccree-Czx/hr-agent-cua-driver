package com.hragent.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.hragent.config.HrAgentProperties;
import com.hragent.entity.AppSetting;
import com.hragent.repository.AppSettingMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;

import java.time.LocalDateTime;
import java.util.Optional;

/**
 * 自动招聘运行时设置(app_setting KV,存库持久化,重启/部署保持):
 * <ul>
 *     <li>{@code auto_recruit.enabled}:"自动外发"开关——只停主动外发(打招呼/索要);
 *         检测回复/附件下载/评分/拉推荐照常。库中无值时以
 *         {@code hr-agent.auto-recruit.enabled} 配置作首次种子(迁移语义:初始值=升级时的启动配置值,
 *         之后完全由界面控制,env 不再影响运行)</li>
 *     <li>{@code auto_recruit.last_run}:上一轮运行摘要 JSON(状态接口展示)</li>
 * </ul>
 */
@Slf4j
@Service
public class AutoRecruitSettingService {

    /** 外发开关 key */
    static final String KEY_ENABLED = "auto_recruit.enabled";
    /** 上轮运行摘要 key */
    static final String KEY_LAST_RUN = "auto_recruit.last_run";

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private final AppSettingMapper settingMapper;
    private final HrAgentProperties properties;
    private final OpLogService opLogService;

    public AutoRecruitSettingService(AppSettingMapper settingMapper, HrAgentProperties properties,
                                     OpLogService opLogService) {
        this.settingMapper = settingMapper;
        this.properties = properties;
        this.opLogService = opLogService;
    }

    /**
     * 自动外发开关:读库;库中无值时以配置 {@code hr-agent.auto-recruit.enabled} 为种子落库并返回。
     * 非法值按关闭处理(fail-closed,记 warn)。
     */
    public boolean isEnabled() {
        String value = get(KEY_ENABLED);
        if (value == null) {
            boolean seed = properties.getAutoRecruit().isEnabled();
            put(KEY_ENABLED, String.valueOf(seed));
            log.info("自动招聘开关首次初始化(种子来自启动配置): {}", seed);
            return seed;
        }
        if (!"true".equals(value) && !"false".equals(value)) {
            log.warn("自动招聘开关值非法({}),按关闭处理", value);
            return false;
        }
        return "true".equals(value);
    }

    /** 设置开关(存库持久化 + 审计日志,操作人取 UserContext) */
    public void setEnabled(boolean enabled) {
        put(KEY_ENABLED, String.valueOf(enabled));
        opLogService.log("AUTO_RECRUIT_TOGGLE", "setting", 1,
                "自动外发开关 → " + (enabled ? "开启" : "关闭"));
    }

    /** 上一轮运行摘要(无/解析失败返回 empty) */
    public Optional<JsonNode> lastRun() {
        String json = get(KEY_LAST_RUN);
        if (json == null || json.isBlank()) {
            return Optional.empty();
        }
        try {
            return Optional.of(MAPPER.readTree(json));
        } catch (Exception e) {
            log.warn("上轮运行摘要 JSON 解析失败: {}", e.getMessage());
            return Optional.empty();
        }
    }

    /** 保存上一轮运行摘要 */
    public void saveLastRun(String json) {
        put(KEY_LAST_RUN, json);
    }

    private String get(String key) {
        AppSetting setting = settingMapper.selectById(key);
        return setting == null ? null : setting.getSettingValue();
    }

    private void put(String key, String value) {
        AppSetting setting = settingMapper.selectById(key);
        if (setting == null) {
            setting = new AppSetting();
            setting.setSettingKey(key);
            setting.setSettingValue(value);
            setting.setUpdatedAt(LocalDateTime.now());
            try {
                settingMapper.insert(setting);
            } catch (DuplicateKeyException e) {
                // 并发首次写入竞争:主键冲突视为已有他人写入,转为更新
                setting = settingMapper.selectById(key);
                setting.setSettingValue(value);
                setting.setUpdatedAt(LocalDateTime.now());
                settingMapper.updateById(setting);
            }
            return;
        }
        setting.setSettingValue(value);
        setting.setUpdatedAt(LocalDateTime.now());
        settingMapper.updateById(setting);
    }
}
