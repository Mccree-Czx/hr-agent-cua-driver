package com.hragent.executor;

import com.hragent.config.HrAgentProperties;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 命令级路由开关测试(2026-09-29 W1):
 * 默认一律 legacy;仅当总开关开启且命令显式配置为 ui 时走 UI 通道。
 */
class CuaCommandResolverTest {

    private HrAgentProperties properties() {
        return new HrAgentProperties();
    }

    @Test
    void defaultAllLegacy() {
        CuaCommandResolver resolver = new CuaCommandResolver(properties());
        assertFalse(resolver.useUi("greet"));
        assertFalse(resolver.useUi("chatlist"));
    }

    @Test
    void enabledWithUiCommandRoutesToUi() {
        HrAgentProperties properties = properties();
        properties.getCua().setEnabled(true);
        properties.getCua().getCommands().put("greet", "ui");
        CuaCommandResolver resolver = new CuaCommandResolver(properties);

        assertTrue(resolver.useUi("greet"));
        assertFalse(resolver.useUi("chatlist"), "未配置的命令仍走 legacy");
    }

    @Test
    void masterSwitchOffOverridesCommandConfig() {
        HrAgentProperties properties = properties();
        properties.getCua().setEnabled(false);
        properties.getCua().getCommands().put("greet", "ui");
        assertFalse(new CuaCommandResolver(properties).useUi("greet"));
    }

    @Test
    void channelValueCaseInsensitiveAndLegacyExplicit() {
        HrAgentProperties properties = properties();
        properties.getCua().setEnabled(true);
        properties.getCua().getCommands().put("greet", "UI");
        properties.getCua().getCommands().put("chatlist", "legacy");
        CuaCommandResolver resolver = new CuaCommandResolver(properties);

        assertTrue(resolver.useUi("greet"));
        assertFalse(resolver.useUi("chatlist"));
    }
}
