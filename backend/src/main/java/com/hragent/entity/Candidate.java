package com.hragent.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("candidate")
public class Candidate {

    @TableId(type = IdType.AUTO)
    private Long id;

    private String resumeId;

    private String name;

    /** 在线简历快照(结构化字段 JSON) */
    private String snapshot;

    private Integer score;

    /** 最新星级(1-5;NULL=分数时代,2026-09-29 起) */
    private Integer star;

    /** PASS(≥3星)/FAIL(1星/确认否决)/KEPT(2星留库)/HOLD(疑似否决待复核)/PENDING(待评) */
    private String passStatus;

    /** 招聘跟进状态(HR 工作流):PENDING_REVIEW/QUALIFIED/INTERVIEW_SCHEDULED/NOT_SUITABLE */
    private String recruitStatus;

    /** 疑似否决改判人 sys_user.id */
    private Long vetoConfirmedBy;

    /** 疑似否决改判时间 */
    private LocalDateTime vetoConfirmedAt;

    /** 简历最后查看时间(NULL=未查看) */
    private LocalDateTime resumeLastViewedAt;

    /** 简历最后查看人(sys_user.id) */
    private Long resumeLastViewedBy;

    private Long jdId;

    private LocalDateTime createdAt;

    private LocalDateTime updatedAt;
}
