package com.hragent.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("op_log")
public class OpLog {

    @TableId(type = IdType.AUTO)
    private Long id;

    private String operator;

    private String action;

    private String targetType;

    private String targetId;

    private String detail;

    private LocalDateTime createdAt;
}
