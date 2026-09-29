package com.hragent.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.hragent.entity.Jd;
import com.hragent.entity.LiepinAccount;
import com.hragent.repository.JdMapper;
import com.hragent.repository.LiepinAccountMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.transaction.annotation.Transactional;

import java.time.Duration;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.when;

@SpringBootTest
@ActiveProfiles("test")
@Transactional
class LiepinJobSyncServiceTest {

    @Autowired
    private LiepinJobSyncService syncService;

    @Autowired
    private JdMapper jdMapper;

    @Autowired
    private LiepinAccountMapper accountMapper;

    @MockitoBean
    private LiepinCommandService commandService;

    private final ObjectMapper objectMapper = new ObjectMapper();

    @BeforeEach
    void setUp() {
        jdMapper.delete(new LambdaQueryWrapper<>());
        accountMapper.delete(new LambdaQueryWrapper<>());

        LiepinAccount account = new LiepinAccount();
        account.setName("测试账号");
        account.setLoginStatus("NORMAL");
        account.setCircuitBreaker(false);
        accountMapper.insert(account);
    }

    private List<com.fasterxml.jackson.databind.JsonNode> sampleJobs() throws Exception {
        return List.of(
                objectMapper.readTree("{\"title\":\"资深亚马逊运营\",\"jobId\":\"85027561\",\"salary\":\"15-24k·13薪\",\"city\":\"上海-虹口区\",\"status\":\"招聘中\"}"),
                objectMapper.readTree("{\"title\":\"高级结构工程师\",\"jobId\":\"84173349\",\"salary\":\"25-40k·13薪\",\"city\":\"上海-虹口区\",\"status\":\"招聘中\"}"));
    }

    @Test
    void syncCreatesThenUpdates() throws Exception {
        when(commandService.jobList(any(LiepinAccount.class), any(Duration.class)))
                .thenReturn(sampleJobs());

        Map<String, Integer> first = syncService.sync(null);
        assertEquals(2, first.get("created"));
        assertEquals(0, first.get("updated"));

        Jd synced = jdMapper.selectOne(new LambdaQueryWrapper<Jd>()
                .eq(Jd::getLiepinJobId, "85027561"));
        assertEquals("资深亚马逊运营", synced.getTitle());
        assertEquals("SYNCED", synced.getSource());
        assertEquals("PUBLISHED", synced.getPublishStatus());
        assertEquals("ACTIVE", synced.getStatus());
        assertEquals("上海", synced.getCity());
        assertEquals("虹口区", synced.getDistrict());
        assertEquals(15000, synced.getSalaryMin());
        assertEquals(24000, synced.getSalaryMax());
        assertEquals(13, synced.getSalaryMonths());

        // 二次同步 → 全部 update,不重复插入
        Map<String, Integer> second = syncService.sync(null);
        assertEquals(0, second.get("created"));
        assertEquals(2, second.get("updated"));
        assertEquals(2, jdMapper.selectCount(null));
    }

    @Test
    void parseCity() {
        assertArrayEquals(new String[]{"上海", "虹口区"}, syncService.parseCity("上海-虹口区"));
        assertArrayEquals(new String[]{"北京", ""}, syncService.parseCity("北京"));
        assertArrayEquals(new String[]{"", ""}, syncService.parseCity(""));
    }

    @Test
    void parseSalary() {
        assertArrayEquals(new int[]{15000, 24000, 13}, syncService.parseSalary("15-24k·13薪"));
        assertArrayEquals(new int[]{30000, 30000, 0}, syncService.parseSalary("30K"));
        assertArrayEquals(new int[]{0, 0, 0}, syncService.parseSalary("面议"));
    }
}
