package com.hragent.repository;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.hragent.entity.SearchTask;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Update;

import java.time.LocalDateTime;

public interface SearchTaskMapper extends BaseMapper<SearchTask> {

    /** 该账号是否有仍在租约内的 RUNNING 任务(单账号串行依据) */
    @Select("""
            SELECT * FROM search_task
            WHERE account_id = #{accountId} AND status = 'RUNNING' AND lease_expire_at > NOW()
            LIMIT 1
            """)
    SearchTask selectRunning(@Param("accountId") Long accountId);

    /** 该账号最早的一个排队任务 */
    @Select("""
            SELECT * FROM search_task
            WHERE account_id = #{accountId} AND status = 'QUEUED'
            ORDER BY id LIMIT 1
            """)
    SearchTask selectNextQueued(@Param("accountId") Long accountId);

    /** 原子认领:仅 QUEUED 可认领为 RUNNING(幂等,并发下只有一方成功) */
    @Update("""
            UPDATE search_task
            SET status = 'RUNNING', lease_expire_at = #{leaseExpireAt}, updated_at = NOW()
            WHERE id = #{id} AND status = 'QUEUED'
            """)
    int tryClaim(@Param("id") Long id, @Param("leaseExpireAt") LocalDateTime leaseExpireAt);

    /** 释放所有租约过期的 RUNNING(进程崩溃兜底,由调度器周期调用) */
    @Update("""
            UPDATE search_task
            SET status = 'QUEUED', lease_expire_at = NULL, updated_at = NOW()
            WHERE status = 'RUNNING' AND lease_expire_at < NOW()
            """)
    int releaseExpiredLeases();

    /** 心跳续约(仅 RUNNING 状态生效,幂等) */
    @Update("""
            UPDATE search_task
            SET lease_expire_at = #{leaseExpireAt}, updated_at = NOW()
            WHERE id = #{id} AND status = 'RUNNING'
            """)
    int heartbeat(@Param("id") Long id, @Param("leaseExpireAt") LocalDateTime leaseExpireAt);

    /** 完成(仅 RUNNING 状态生效,幂等:重复调用不生效) */
    @Update("""
            UPDATE search_task
            SET status = 'DONE', lease_expire_at = NULL, updated_at = NOW()
            WHERE id = #{id} AND status = 'RUNNING'
            """)
    int markDone(@Param("id") Long id);

    /** 失败重试:回 QUEUED 并延迟到 nextRunAt(指数退避),retry_count+1 */
    @Update("""
            UPDATE search_task
            SET status = 'QUEUED',
                lease_expire_at = #{nextRunAt},
                retry_count = retry_count + 1,
                error_msg = #{errorMsg},
                updated_at = NOW()
            WHERE id = #{id} AND status = 'RUNNING'
            """)
    int retryWithBackoff(@Param("id") Long id, @Param("nextRunAt") LocalDateTime nextRunAt,
                         @Param("errorMsg") String errorMsg);

    /** 超过重试上限 → 终态失败 */
    @Update("""
            UPDATE search_task
            SET status = 'FAILED',
                retry_count = retry_count + 1,
                error_msg = #{errorMsg},
                lease_expire_at = NULL,
                updated_at = NOW()
            WHERE id = #{id} AND status = 'RUNNING'
            """)
    int markFailed(@Param("id") Long id, @Param("errorMsg") String errorMsg);

    /** 该账号最近一次"执行相关"任务的更新时间(RUNNING/DONE/FAILED;QUEUED 创建不计入)
     *  ——用于调度器最小执行间隔门禁(防任务接力暴发,2026-09-28) */
    @Select("""
            SELECT MAX(updated_at) FROM search_task
            WHERE account_id = #{accountId} AND status IN ('RUNNING', 'DONE', 'FAILED')
            """)
    LocalDateTime selectLastExecutedAt(@Param("accountId") Long accountId);
}
