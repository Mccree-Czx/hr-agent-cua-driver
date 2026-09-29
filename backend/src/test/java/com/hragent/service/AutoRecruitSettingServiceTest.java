package com.hragent.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.hragent.config.HrAgentProperties;
import com.hragent.entity.AppSetting;
import com.hragent.entity.OpLog;
import com.hragent.repository.AppSettingMapper;
import com.hragent.repository.OpLogMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 自动招聘运行时开关(存库持久化 + 首次种子 + 审计)。
 * 语义:开关只停主动外发;库值一旦存在即完全以库为准(重启/部署保持)。
 */
@SpringBootTest
@ActiveProfiles("test")
@Transactional
class AutoRecruitSettingServiceTest {

    @Autowired
    private AutoRecruitSettingService settingService;

    @Autowired
    private AppSettingMapper settingMapper;

    @Autowired
    private OpLogMapper opLogMapper;

    @Autowired
    private HrAgentProperties properties;

    @BeforeEach
    void setUp() {
        properties.getAutoRecruit().setEnabled(true);
    }

    @Test
    void seedsFromPropertyWhenAbsent() {
        assertNull(settingMapper.selectById("auto_recruit.enabled"), "前置:库中不应有开关值");

        assertTrue(settingService.isEnabled(), "库空时应以启动配置为种子(true)");
        assertEquals("true", settingMapper.selectById("auto_recruit.enabled").getSettingValue(),
                "种子应落库,后续完全以库为准");
    }

    @Test
    void persistedValueWinsOverProperty() {
        settingService.setEnabled(false);
        properties.getAutoRecruit().setEnabled(true); // 启动配置翻转不影响已落库值

        assertFalse(settingService.isEnabled(), "库中已有 false 时应以库为准,不受配置影响");
    }

    @Test
    void toggleWritesOpLog() {
        long before = opLogMapper.selectCount(new LambdaQueryWrapper<OpLog>()
                .eq(OpLog::getAction, "AUTO_RECRUIT_TOGGLE"));

        settingService.setEnabled(false);

        long after = opLogMapper.selectCount(new LambdaQueryWrapper<OpLog>()
                .eq(OpLog::getAction, "AUTO_RECRUIT_TOGGLE"));
        assertEquals(before + 1, after, "开关操作必须留审计日志");
        assertEquals("false", settingMapper.selectById("auto_recruit.enabled").getSettingValue());
    }

    @Test
    void lastRunRoundTrip() {
        assertTrue(settingService.lastRun().isEmpty(), "初始无上轮摘要");

        settingService.saveLastRun("{\"at\":\"2026-09-26T18:00:00\",\"greeted\":3,\"mode\":\"full\"}");

        assertEquals(3, settingService.lastRun().orElseThrow().path("greeted").asInt());
        assertEquals("full", settingService.lastRun().orElseThrow().path("mode").asText());
    }

    @Test
    void invalidStoredValueTreatedAsFalse() {
        AppSetting raw = new AppSetting();
        raw.setSettingKey("auto_recruit.enabled");
        raw.setSettingValue("yes");
        raw.setUpdatedAt(LocalDateTime.now());
        settingMapper.insert(raw);

        assertFalse(settingService.isEnabled(), "非法值应 fail-closed 按关闭处理");
    }
}
