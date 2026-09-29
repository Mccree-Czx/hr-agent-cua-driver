package com.hragent.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.hragent.common.BizException;
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
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.when;

@SpringBootTest
@ActiveProfiles("test")
@Transactional
class JdPublishServiceTest {

    @Autowired
    private JdPublishService jdPublishService;

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

    private Jd createJd() {
        Jd jd = new Jd();
        jd.setTitle("招聘主管");
        jd.setExternalJd("负责招聘全流程");
        jd.setJobCategory("N000330");
        jd.setExperienceReq("5-10年");
        jd.setDegreeReq("本科");
        jd.setSalaryMonths(13);
        jd.setSalaryMin(12000);
        jd.setSalaryMax(18000);
        jd.setPublishStatus("NOT_PUBLISHED");
        jd.setSource("LOCAL");
        jdMapper.insert(jd);
        return jd;
    }

    @Test
    void publishSuccessBackfillsJobId() throws Exception {
        when(commandService.jobPublish(any(), anyString(), any(Duration.class)))
                .thenReturn(Optional.of(objectMapper.readTree(
                        "{\"success\":true,\"job_id\":\"85869999\",\"message\":\"职位已发布\"}")));

        Jd jd = createJd();
        Jd result = jdPublishService.publish(jd.getId());

        assertEquals("PUBLISHED", result.getPublishStatus());
        assertEquals("85869999", result.getLiepinJobId());
        Jd after = jdMapper.selectById(jd.getId());
        assertEquals("PUBLISHED", after.getPublishStatus());
    }

    @Test
    void publishRejectedWhenAlreadyPublished() {
        Jd jd = createJd();
        jd.setPublishStatus("PUBLISHED");
        jd.setLiepinJobId("85027561");
        jdMapper.updateById(jd);

        BizException e = assertThrows(BizException.class, () -> jdPublishService.publish(jd.getId()));
        assertTrue(e.getMessage().contains("不可重复发布"));
    }

    @Test
    void publishFailedRecordsError() throws Exception {
        when(commandService.jobPublish(any(), anyString(), any(Duration.class)))
                .thenReturn(Optional.of(objectMapper.readTree(
                        "{\"success\":false,\"message\":\"类别无效\"}")));

        Jd jd = createJd();
        assertThrows(BizException.class, () -> jdPublishService.publish(jd.getId()));
        Jd after = jdMapper.selectById(jd.getId());
        assertEquals("FAILED", after.getPublishStatus());
        assertTrue(after.getPublishError().contains("类别无效"));
    }

    @Test
    void parseExperience() {
        assertArrayEquals(new int[]{5, 10}, jdPublishService.parseExperience("5-10年"));
        assertArrayEquals(new int[]{3, 5}, jdPublishService.parseExperience("3-5年"));
        assertArrayEquals(new int[]{0, 99}, jdPublishService.parseExperience("不限"));
        assertArrayEquals(new int[]{0, 99}, jdPublishService.parseExperience(null));
    }

    @Test
    void resolveDegreeCode() {
        assertEquals("040", jdPublishService.resolveDegreeCode("本科"));
        assertEquals("040", jdPublishService.resolveDegreeCode(null));
        assertEquals("050", jdPublishService.resolveDegreeCode("050"));
    }

    @Test
    void deleteWithoutLiepinJobIdDirectlyRemoves() {
        Jd jd = createJd();
        jdPublishService.deleteWithSync(jd.getId());
        assertEquals(0, jdMapper.selectCount(null));
    }

    @Test
    void deleteWithLiepinJobIdSyncsToLiepin() throws Exception {
        when(commandService.jobDelete(any(), anyString(), any(Duration.class)))
                .thenReturn(Optional.of(objectMapper.readTree(
                        "{\"success\":true,\"deleted\":[\"85869999\"],\"message\":\"已删除 1 个职位\"}")));

        Jd jd = createJd();
        jd.setLiepinJobId("85869999");
        jd.setPublishStatus("PUBLISHED");
        jdMapper.updateById(jd);

        jdPublishService.deleteWithSync(jd.getId());
        assertEquals(0, jdMapper.selectCount(null), "猎聘删除成功后应删系统记录");
    }

    @Test
    void deleteAbortsAndKeepsRecordWhenLiepinFails() throws Exception {
        // 删除命令失败 + 复核确认职位仍在猎聘 → 保留系统记录
        when(commandService.jobDelete(any(), anyString(), any(Duration.class)))
                .thenReturn(Optional.of(objectMapper.readTree(
                        "{\"success\":false,\"message\":\"网络错误\"}")));
        when(commandService.jobList(any(), any(Duration.class)))
                .thenReturn(List.of(objectMapper.readTree(
                        "{\"title\":\"招聘主管\",\"jobId\":\"85869999\",\"status\":\"招聘中\"}")));

        Jd jd = createJd();
        jd.setLiepinJobId("85869999");
        jd.setPublishStatus("PUBLISHED");
        jdMapper.updateById(jd);

        assertThrows(BizException.class, () -> jdPublishService.deleteWithSync(jd.getId()));
        assertEquals(1, jdMapper.selectCount(null), "猎聘删除失败且职位仍在时应保留系统记录");
    }

    @Test
    void deleteRecheckPassesWhenJobGoneFromLiepin() throws Exception {
        // 删除命令报错(如风控特征误判),但复核发现猎聘上已不存在 → 视为成功,删系统记录
        when(commandService.jobDelete(any(), anyString(), any(Duration.class)))
                .thenThrow(new com.hragent.executor.CliException(
                        com.hragent.executor.CliException.Type.RISK_CONTROL, "检测到风控拦截特征 [安全验证]"));
        when(commandService.jobList(any(), any(Duration.class)))
                .thenReturn(List.of(objectMapper.readTree(
                        "{\"title\":\"其他职位\",\"jobId\":\"11111\",\"status\":\"招聘中\"}")));

        Jd jd = createJd();
        jd.setLiepinJobId("85869999");
        jd.setPublishStatus("PUBLISHED");
        jdMapper.updateById(jd);

        jdPublishService.deleteWithSync(jd.getId());
        assertEquals(0, jdMapper.selectCount(null), "复核确认职位已不存在后应删系统记录");
    }

    @Test
    void deleteRecheckFailsWhenRecheckUnavailable() throws Exception {
        // 删除命令失败且复核也不可用 → 保守保留
        when(commandService.jobDelete(any(), anyString(), any(Duration.class)))
                .thenThrow(new com.hragent.executor.CliException(
                        com.hragent.executor.CliException.Type.RISK_CONTROL, "安全验证"));
        when(commandService.jobList(any(), any(Duration.class)))
                .thenThrow(new com.hragent.executor.CliException(
                        com.hragent.executor.CliException.Type.RISK_CONTROL, "安全验证"));

        Jd jd = createJd();
        jd.setLiepinJobId("85869999");
        jd.setPublishStatus("PUBLISHED");
        jdMapper.updateById(jd);

        assertThrows(BizException.class, () -> jdPublishService.deleteWithSync(jd.getId()));
        assertEquals(1, jdMapper.selectCount(null), "复核不可用时保留系统记录");
    }
}
