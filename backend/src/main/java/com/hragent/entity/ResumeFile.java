package com.hragent.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("resume_file")
public class ResumeFile {

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long candidateId;

    private String bucket;

    private String objectKey;

    private String format;

    private Long size;

    private String sha256;

    private LocalDateTime createdAt;
}
