package com.hragent.executor;

import com.hragent.config.HrAgentProperties;
import org.springframework.stereotype.Component;

/**
 * 命令级路由开关(2026-09-29 全量替换 W1):决定某命令走 UI 通道还是 legacy CDP 通道。
 *
 * <p>判定:hr-agent.cua.enabled=true 且 commands.<命令>=ui 时走 UI 通道;
 * 默认(总开关关闭 / 命令未配置 / 显式为 legacy)一律走 legacy CDP 通道,
 * 既有行为完全不变。W2+ 按波次逐命令切换。
 */
@Component
public class CuaCommandResolver {

    /** UI 通道配置值(大小写不敏感) */
    public static final String CHANNEL_UI = "ui";

    private final HrAgentProperties properties;

    public CuaCommandResolver(HrAgentProperties properties) {
        this.properties = properties;
    }

    /** 该命令是否走 UI 通道 */
    public boolean useUi(String command) {
        if (!properties.getCua().isEnabled()) {
            return false;
        }
        return CHANNEL_UI.equalsIgnoreCase(properties.getCua().getCommands().get(command));
    }
}
