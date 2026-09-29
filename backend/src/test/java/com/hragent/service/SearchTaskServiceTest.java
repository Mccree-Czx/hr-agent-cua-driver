package com.hragent.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.hragent.entity.Candidate;
import com.hragent.entity.Jd;
import com.hragent.entity.LiepinAccount;
import com.hragent.entity.SearchTask;
import com.hragent.repository.CandidateMapper;
import com.hragent.repository.JdMapper;
import com.hragent.repository.LiepinAccountMapper;
import com.hragent.repository.SearchTaskMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.transaction.annotation.Transactional;

import java.time.Duration;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@SpringBootTest
@ActiveProfiles("test")
@Transactional
class SearchTaskServiceTest {

    @Autowired
    private SearchTaskService searchTaskService;

    @Autowired
    private SearchTaskMapper taskMapper;

    @Autowired
    private JdMapper jdMapper;

    @Autowired
    private LiepinAccountMapper accountMapper;

    @Autowired
    private CandidateMapper candidateMapper;

    @MockitoBean
    private LiepinCommandService commandService;

    private final ObjectMapper objectMapper = new ObjectMapper();

    private Long jdId;
    private Long accountId;

    @BeforeEach
    void setUp() {
        taskMapper.delete(new LambdaQueryWrapper<>());
        candidateMapper.delete(new LambdaQueryWrapper<>());
        jdMapper.delete(new LambdaQueryWrapper<>());
        accountMapper.delete(new LambdaQueryWrapper<>());

        Jd jd = new Jd();
        jd.setTitle("Java 后端工程师");
        jd.setLiepinJobId("123");
        jd.setInternalNotes("java springboot 微服务");
        jdMapper.insert(jd);
        jdId = jd.getId();

        LiepinAccount account = new LiepinAccount();
        account.setName("测试账号");
        account.setLoginStatus("NORMAL");
        account.setCircuitBreaker(false);
        accountMapper.insert(account);
        accountId = account.getId();
    }

    /** 创建任务并认领为 RUNNING(模拟调度器行为) */
    private SearchTask createAndClaimTask() {
        searchTaskService.createTask(jdId, accountId);
        SearchTask claimed = taskMapper.selectNextQueued(accountId);
        taskMapper.tryClaim(claimed.getId(), java.time.LocalDateTime.now().plusMinutes(5));
        return taskMapper.selectById(claimed.getId());
    }

    private List<JsonNode> candidatesJson() throws Exception {
        return List.of(
                objectMapper.readTree("{\"name\":\"张三\",\"resume_id\":\"r1\",\"city\":\"北京\"}"),
                objectMapper.readTree("{\"name\":\"李四\",\"resume_id\":\"r2\",\"city\":\"上海\"}"));
    }

    @Test
    void createTaskUsesKeywordsFromJd() {
        SearchTask task = searchTaskService.createTask(jdId, accountId);
        assertEquals("java springboot 微服务", task.getKeywords());
        assertEquals("QUEUED", task.getStatus());
    }

    @Test
    void createTaskFallsBackToTitleWhenNoNotes() {
        jdMapper.update(null, new com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper<Jd>()
                .eq(Jd::getId, jdId).set(Jd::getInternalNotes, null));
        SearchTask task = searchTaskService.createTask(jdId, accountId);
        assertEquals("Java 后端工程师", task.getKeywords());
    }

    @Test
    void executeSavesCandidatesAndDedups() throws Exception {
        when(commandService.search(any(LiepinAccount.class), anyString(), anyInt(), any(Duration.class)))
                .thenReturn(candidatesJson());

        SearchTask task = createAndClaimTask();
        searchTaskService.execute(task);

        assertEquals("DONE", taskMapper.selectById(task.getId()).getStatus());
        assertEquals(2, candidateMapper.selectCount(null), "两名候选人落库");

        // 同一账号再搜一次,同 resume_id 去重(更新而非新增)
        SearchTask task2 = createAndClaimTask();
        searchTaskService.execute(task2);
        assertEquals("DONE", taskMapper.selectById(task2.getId()).getStatus());
        assertEquals(2, candidateMapper.selectCount(null), "重复搜索应去重");
        Candidate c = candidateMapper.selectOne(
                new LambdaQueryWrapper<Candidate>().eq(Candidate::getResumeId, "r1"));
        assertNotNull(c);
        assertEquals("PENDING", c.getPassStatus());
    }

    @Test
    void executeSkipsWhenCircuitBreaker() throws Exception {
        LiepinAccount account = accountMapper.selectById(accountId);
        account.setCircuitBreaker(true);
        accountMapper.updateById(account);

        SearchTask task = createAndClaimTask();
        searchTaskService.execute(task);

        SearchTask after = taskMapper.selectById(task.getId());
        assertEquals("FAILED", after.getStatus());
        verify(commandService, never()).search(any(), anyString(), anyInt(), any());
    }

    @Test
    void executeBackoffWhenNeedScan() throws Exception {
        LiepinAccount account = accountMapper.selectById(accountId);
        account.setLoginStatus("NEED_SCAN");
        accountMapper.updateById(account);

        SearchTask task = createAndClaimTask();
        searchTaskService.execute(task);

        SearchTask after = taskMapper.selectById(task.getId());
        assertEquals("QUEUED", after.getStatus());
        assertEquals(1, after.getRetryCount());
        verify(commandService, never()).search(any(), anyString(), anyInt(), any());
    }

    @Test
    void saveCandidatesSkipsBlankFields() throws Exception {
        List<JsonNode> nodes = List.of(
                objectMapper.readTree("{\"name\":\"\",\"resume_id\":\"\"}"),
                objectMapper.readTree("{\"name\":\"有效\",\"resume_id\":\"r9\"}"));
        int saved = searchTaskService.saveCandidates(jdId, nodes);
        assertEquals(1, saved, "空 resume_id/name 应跳过");
        assertEquals(1, candidateMapper.selectCount(null));
    }

    @Test
    void createRecommendTask() {
        SearchTask task = searchTaskService.createRecommendTask(jdId, accountId);
        assertEquals("RECOMMEND", task.getTaskType());
        assertEquals("QUEUED", task.getStatus());
    }

    @Test
    void executeRecommendTaskPullsRecommendations() throws Exception {
        when(commandService.recommend(any(LiepinAccount.class), org.mockito.ArgumentMatchers.eq("123"), any(Duration.class)))
                .thenReturn(List.of(objectMapper.readTree(
                        "{\"name\":\"推荐人\",\"talentId\":\"t1\"," +
                                "\"url\":\"https://lpt.liepin.com/cvview?resIdEncode=rec001&job_id=123\"}")));

        SearchTask task = searchTaskService.createRecommendTask(jdId, accountId);
        // 模拟调度器认领
        taskMapper.tryClaim(task.getId(), java.time.LocalDateTime.now().plusMinutes(5));
        searchTaskService.execute(task);

        assertEquals("DONE", taskMapper.selectById(task.getId()).getStatus());
        // 推荐数据无 resume_id,应从 url 提取 resIdEncode
        Candidate c = candidateMapper.selectOne(
                new LambdaQueryWrapper<Candidate>().eq(Candidate::getResumeId, "rec001"));
        assertNotNull(c, "推荐候选人应以 url 中 resIdEncode 作为 resume_id 落库");
        assertEquals("推荐人", c.getName());
    }
}
