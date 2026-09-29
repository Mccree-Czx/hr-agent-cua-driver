package com.hragent.dto;

import jakarta.validation.constraints.NotNull;
import lombok.Data;

@Data
public class CreateSearchTaskRequest {

    @NotNull(message = "岗位不能为空")
    private Long jdId;

    @NotNull(message = "猎聘账号不能为空")
    private Long accountId;
}
