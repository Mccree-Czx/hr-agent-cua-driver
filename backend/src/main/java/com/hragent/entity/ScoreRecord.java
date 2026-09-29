package com.hragent.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("score_record")
public class ScoreRecord {

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long candidateId;

    private Long jdId;

    private Integer score;

    /** 星级 1-5(2026-09-29 起;NULL=分数时代记录) */
    private Integer star;

    private String reason;

    private String ruleVersion;

    /** 疑似否决点命中(JSON 数组,待人工复核) */
    private String vetoSuspects;

    /** 加分点命中(JSON 数组) */
    private String bonusHits;

    /** 本次评分所用岗位偏好快照(审计) */
    private String prefSnapshot;

    private String model;

    private Integer tokenUsage;

    private LocalDateTime createdAt;
}
