package com.hragent.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("greeting_record")
public class GreetingRecord {

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long candidateId;

    private Long accountId;

    /** 打招呼实际关联的猎聘职位 ID(来源岗位的 liepin_job_id,审计用) */
    private String liepinJobId;

    /** 附件探测标记:已探测的会话最新消息 ID(同一消息不重复探测;NULL=从未探测) */
    private String attachProbeMsgId;

    /** 最近一次索要简历时间(NULL=从未索要;防重复:24h 窗口内不重复请求) */
    private LocalDateTime resumeRequestedAt;

    /** 索要简历尝试次数(含接口受理但未回显确认的尝试;上限 2 次后仅等对方自发附件) */
    private Integer resumeRequestCount;

    private String message;

    private String status;

    private String mode;

    private LocalDateTime createdAt;
}
