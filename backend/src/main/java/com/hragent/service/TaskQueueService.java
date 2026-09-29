package com.hragent.service;

import com.hragent.entity.SearchTask;
import com.hragent.repository.SearchTaskMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.time.LocalDateTime;

/**
 * 搜索任务队列语义(评审 P1-7):
 * - 单账号串行:同一账号同时只有一个 RUNNING 任务(selectRunning 判断 + tryClaim 原子认领)
 * - 租约/心跳:执行中周期续约;进程崩溃后由调度器 releaseExpiredLeases 兜底释放
 * - 幂等:complete/fail 均以 status='RUNNING' 为条件更新,重复调用不生效
 * - 指数退避:重试延迟 30s * 2^retryCount,超过 MAX_RETRY 进入 FAILED 终态
 */
@Slf4j
@Service
public class TaskQueueService {

    public static final int MAX_RETRY = 3;
    public static final long LEASE_SECONDS = 600;
    public static final long BASE_BACKOFF_SECONDS = 30;

    private final SearchTaskMapper taskMapper;

    public TaskQueueService(SearchTaskMapper taskMapper) {
        this.taskMapper = taskMapper;
    }

    /** 该账号是否正在执行任务(租约内) */
    public boolean isRunning(Long accountId) {
        return taskMapper.selectRunning(accountId) != null;
    }

    /** 原子认领下一个排队任务;无任务或认领失败返回 null */
    public SearchTask claim(Long accountId) {
        if (isRunning(accountId)) {
            return null;
        }
        SearchTask next = taskMapper.selectNextQueued(accountId);
        if (next == null) {
            return null;
        }
        int updated = taskMapper.tryClaim(next.getId(), LocalDateTime.now().plusSeconds(LEASE_SECONDS));
        if (updated == 0) {
            return null;
        }
        return taskMapper.selectById(next.getId());
    }

    public void heartbeat(Long taskId) {
        taskMapper.heartbeat(taskId, LocalDateTime.now().plusSeconds(LEASE_SECONDS));
    }

    public void complete(Long taskId) {
        taskMapper.markDone(taskId);
    }

    /** 失败处理:指数退避重试,超上限终态失败 */
    public void fail(Long taskId, String errorMsg, int retryCount) {
        String truncated = errorMsg == null || errorMsg.length() <= 900
                ? errorMsg : errorMsg.substring(0, 900);
        if (retryCount >= MAX_RETRY) {
            taskMapper.markFailed(taskId, truncated);
            log.warn("任务 {} 超过重试上限,终态失败: {}", taskId, truncated);
        } else {
            long delay = BASE_BACKOFF_SECONDS * (1L << retryCount);
            taskMapper.retryWithBackoff(taskId, LocalDateTime.now().plusSeconds(delay), truncated);
            log.info("任务 {} 第 {} 次失败,{} 秒后重试", taskId, retryCount + 1, delay);
        }
    }

    /** 兜底:释放租约过期的 RUNNING 任务(进程崩溃恢复) */
    public int releaseExpiredLeases() {
        return taskMapper.releaseExpiredLeases();
    }
}
