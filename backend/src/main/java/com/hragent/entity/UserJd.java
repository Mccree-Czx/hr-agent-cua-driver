package com.hragent.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

@Data
@TableName("user_jd")
public class UserJd {

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long userId;

    private Long jdId;
}
