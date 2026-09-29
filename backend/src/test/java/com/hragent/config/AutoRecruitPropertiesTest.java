package com.hragent.config;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.ActiveProfiles;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * 自动招聘配置默认值契约:打招呼单轮上限 2026-09-28 晚工作量翻倍为 30
 * (同日早先熔断治理曾降档 50→15;50=过激会触发平台风控)。该断言锁定定档值——防止无意回退。
 */
@SpringBootTest
@ActiveProfiles("test")
class AutoRecruitPropertiesTest {

    @Autowired
    private HrAgentProperties properties;

    @Test
    void greetBatchLimitDefaultsToNegotiatedValue() {
        assertEquals(30, properties.getAutoRecruit().getGreetBatchLimit(),
                "单轮打招呼上限默认应为 30(2026-09-28 工作量翻倍档)");
    }
}
