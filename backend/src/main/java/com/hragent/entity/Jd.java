package com.hragent.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("jd")
public class Jd {

    @TableId(type = IdType.AUTO)
    private Long id;

    private String title;

    private String externalJd;

    private String internalNotes;

    private String city;

    private String district;

    /** 猎聘职位类别编码(如 N000330) */
    private String jobCategory;

    /** 经验要求文本(如 5-10年) */
    private String experienceReq;

    /** 学历要求文本(如 本科) */
    private String degreeReq;

    /** 薪资月数(如 13) */
    private Integer salaryMonths;

    private Integer salaryMin;

    private Integer salaryMax;

    private String status;

    /** NOT_PUBLISHED/PUBLISHING/PUBLISHED/FAILED */
    private String publishStatus;

    /** 猎聘职位 ID(发布后回填) */
    private String liepinJobId;

    private String publishError;

    /** 已确认的评分通过门槛(1-100);NULL=未确认(禁止外发) */
    private Integer scoreThreshold;

    /** AI 建议门槛与理由(格式:建议{N}分:{理由}) */
    private String thresholdSuggestion;

    /** 门槛确认人 sys_user.id */
    private Long thresholdConfirmedBy;

    /** 门槛确认时间;非空=已确认(允许自动外发) */
    private LocalDateTime thresholdConfirmedAt;

    /** 评分偏好确认时间;非空=已确认(2026-09-29 起作为外发门禁唯一放行依据) */
    private LocalDateTime scoringPrefConfirmedAt;

    /** 评分偏好确认人 sys_user.id */
    private Long scoringPrefConfirmedBy;

    /** 最低主动沟通星级(1-5,默认 3=招呼线) */
    private Integer minCommStar;

    /** 加分点(每行一项) */
    private String bonusPoints;

    /** 一票否决点(每行一项,命中→疑似否决待人工复核) */
    private String vetoPoints;

    /** 其他要求(每行一项) */
    private String otherRequirements;

    /** LOCAL=系统创建 / SYNCED=猎聘同步 */
    private String source;

    private LocalDateTime createdAt;

    private LocalDateTime updatedAt;
}
