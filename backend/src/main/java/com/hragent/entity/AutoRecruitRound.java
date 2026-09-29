package com.hragent.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

/** 自动招聘轮次历史(运行日志页;参照 HR Portal V2 运行日志,每轮结束时写入) */
@Data
@TableName("auto_recruit_round")
public class AutoRecruitRound {

    @TableId(type = IdType.AUTO)
    private Long id;

    /** 轮次开始时间 */
    private LocalDateTime startedAt;

    /** 轮次结束时间 */
    private LocalDateTime finishedAt;

    /** full=完整轮 / collectOnly=只收模式(外发开关 OFF) */
    private String mode;

    private Integer polled;

    private Integer scored;

    private Integer greeted;

    private Integer recommended;

    private Integer errors;

    /** 风控停轮 */
    private Boolean riskStopped;

    /** 无可用账号跳过 */
    private Boolean noAccount;

    /** 原始摘要 JSON(与 auto_recruit.last_run 一致,留档) */
    private String statsJson;

    private LocalDateTime createdAt;
}
