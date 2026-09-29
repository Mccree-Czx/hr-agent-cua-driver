package com.hragent.controller;

import com.baomidou.mybatisplus.core.metadata.IPage;
import com.hragent.common.ApiResponse;
import com.hragent.entity.OpLog;
import com.hragent.security.RequireRole;
import com.hragent.service.OpLogService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/audit")
@RequireRole("ADMIN")
public class AuditController {

    private final OpLogService opLogService;

    public AuditController(OpLogService opLogService) {
        this.opLogService = opLogService;
    }

    @GetMapping("/logs")
    public ApiResponse<IPage<OpLog>> page(@RequestParam(defaultValue = "1") int pageNo,
                                          @RequestParam(defaultValue = "20") int pageSize) {
        return ApiResponse.ok(opLogService.page(pageNo, pageSize));
    }
}
