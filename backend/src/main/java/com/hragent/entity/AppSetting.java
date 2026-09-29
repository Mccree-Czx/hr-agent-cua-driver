package com.hragent.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

/** 运行时设置(KV;自动招聘开关/上轮摘要等,存库持久化) */
@Data
@TableName("app_setting")
public class AppSetting {

    @TableId(value = "setting_key", type = IdType.INPUT)
    private String settingKey;

    private String settingValue;

    private LocalDateTime updatedAt;
}
