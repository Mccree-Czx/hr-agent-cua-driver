package com.hragent.dto;

import jakarta.validation.constraints.NotNull;
import lombok.Data;

@Data
public class RecruitRunRequest {

    @NotNull(message = "岗位不能为空")
    private Long jdId;

    /** 本轮处理上限,默认 10 */
    private Integer limit = 10;
}
