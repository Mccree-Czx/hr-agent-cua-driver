package com.hragent.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("liepin_account")
public class LiepinAccount {

    @TableId(type = IdType.AUTO)
    private Long id;

    private String name;

    private String userDataDir;

    private String loginStatus;

    private Boolean circuitBreaker;

    private String greetMode;

    private Integer dailyGreetQuota;

    /** 熔断恢复(重置)时刻:原冷却窗口判断用;冷却机制已于 2026-09-28 移除,字段保留兼容历史数据 */
    private LocalDateTime riskResetAt;

    private LocalDateTime createdAt;

    private LocalDateTime updatedAt;
}
