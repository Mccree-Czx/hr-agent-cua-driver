package com.hragent.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.hragent.entity.SearchTask;
import com.hragent.repository.SearchTaskMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

@SpringBootTest
@ActiveProfiles("test")
@Transactional
class TaskQueueServiceTest {

    @Autowired
    private TaskQueueService queueService;

    @Autowired
    private SearchTaskMapper taskMapper;

    @BeforeEach
    void clean() {
        taskMapper.delete(new LambdaQueryWrapper<>());
    }

    private SearchTask insertTask(Long accountId, String status, LocalDateTime leaseExpireAt, int retryCount) {
        SearchTask task = new SearchTask();
        task.setJdId(1L);
        task.setAccountId(accountId);
        task.setKeywords("java");
        task.setStatus(status);
        task.setLeaseExpireAt(leaseExpireAt);
        task.setRetryCount(retryCount);
        taskMapper.insert(task);
        return task;
    }

    @Test
    void claimSingleAccountSerial() {
        insertTask(1L, "QUEUED", null, 0);
        insertTask(1L, "QUEUED", null, 0);

        SearchTask first = queueService.claim(1L);
        assertNotNull(first);
        assertEquals("RUNNING", taskMapper.selectById(first.getId()).getStatus());
        assertTrue(queueService.isRunning(1L), "认领后账号应有 RUNNING 任务");

        // 单账号串行:第二个任务不可被认领
        assertNull(queueService.claim(1L));

        // 完成第一个后可认领第二个
        queueService.complete(first.getId());
        assertEquals("DONE", taskMapper.selectById(first.getId()).getStatus());
        SearchTask second = queueService.claim(1L);
        assertNotNull(second);
        assertEquals(first.getId() + 1, second.getId());
    }

    @Test
    void completeIsIdempotent() {
        SearchTask task = insertTask(1L, "QUEUED", null, 0);
        queueService.claim(1L);
        queueService.complete(task.getId());
        // 重复 complete 不影响状态(仍为 DONE,非异常)
        queueService.complete(task.getId());
        assertEquals("DONE", taskMapper.selectById(task.getId()).getStatus());
    }

    @Test
    void releaseExpiredLeases() {
        SearchTask task = insertTask(1L, "RUNNING",
                LocalDateTime.now().minusMinutes(1), 0);
        int released = queueService.releaseExpiredLeases();
        assertEquals(1, released);
        SearchTask after = taskMapper.selectById(task.getId());
        assertEquals("QUEUED", after.getStatus());
        assertNull(after.getLeaseExpireAt());
    }

    @Test
    void releaseDoesNotTouchActiveLease() {
        SearchTask task = insertTask(1L, "RUNNING",
                LocalDateTime.now().plusMinutes(5), 0);
        queueService.releaseExpiredLeases();
        assertEquals("RUNNING", taskMapper.selectById(task.getId()).getStatus());
    }

    @Test
    void failRetriesWithBackoffThenFails() {
        SearchTask task = insertTask(1L, "RUNNING", LocalDateTime.now().plusMinutes(5), 0);

        // 第 1 次失败:回 QUEUED + 延迟重试
        queueService.fail(task.getId(), "boom-1", 0);
        SearchTask t1 = taskMapper.selectById(task.getId());
        assertEquals("QUEUED", t1.getStatus());
        assertEquals(1, t1.getRetryCount());
        assertTrue(t1.getLeaseExpireAt().isAfter(LocalDateTime.now()), "退避时间应在未来");
        assertEquals("boom-1", t1.getErrorMsg());

        // 重试(第 2 次失败):retryCount=1
        taskMapper.tryClaim(task.getId(), LocalDateTime.now().plusMinutes(5));
        queueService.fail(task.getId(), "boom-2", 1);
        SearchTask t2 = taskMapper.selectById(task.getId());
        assertEquals("QUEUED", t2.getStatus());
        assertEquals(2, t2.getRetryCount());

        // 第 3 次失败:retryCount=2
        taskMapper.tryClaim(task.getId(), LocalDateTime.now().plusMinutes(5));
        queueService.fail(task.getId(), "boom-3", 2);
        SearchTask t3 = taskMapper.selectById(task.getId());
        assertEquals("QUEUED", t3.getStatus());
        assertEquals(3, t3.getRetryCount());

        // 第 4 次失败:retryCount=3 ≥ MAX_RETRY → 终态 FAILED
        taskMapper.tryClaim(task.getId(), LocalDateTime.now().plusMinutes(5));
        queueService.fail(task.getId(), "boom-4", 3);
        SearchTask t4 = taskMapper.selectById(task.getId());
        assertEquals("FAILED", t4.getStatus());
        assertEquals(4, t4.getRetryCount());
    }
}
