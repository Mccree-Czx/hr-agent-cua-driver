package com.hragent.controller;

import com.baomidou.mybatisplus.core.metadata.IPage;
import com.hragent.common.ApiResponse;
import com.hragent.dto.CreateUserRequest;
import com.hragent.entity.SysUser;
import com.hragent.entity.UserJd;
import com.hragent.security.RequireRole;
import com.hragent.service.UserJdService;
import com.hragent.service.UserService;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/user")
@RequireRole("ADMIN")
public class UserController {

    private final UserService userService;
    private final UserJdService userJdService;

    public UserController(UserService userService, UserJdService userJdService) {
        this.userService = userService;
        this.userJdService = userJdService;
    }

    @GetMapping
    public ApiResponse<IPage<SysUser>> page(@RequestParam(defaultValue = "1") int pageNo,
                                            @RequestParam(defaultValue = "10") int pageSize) {
        return ApiResponse.ok(userService.page(pageNo, pageSize));
    }

    @PostMapping
    public ApiResponse<SysUser> create(@Valid @RequestBody CreateUserRequest request) {
        return ApiResponse.ok(userService.create(request.getUsername(), request.getPassword(), request.getRole()));
    }

    @PutMapping("/{id}")
    public ApiResponse<SysUser> update(@PathVariable Long id, @RequestBody CreateUserRequest request) {
        return ApiResponse.ok(userService.update(id, request.getRole(), request.getPassword()));
    }

    @DeleteMapping("/{id}")
    public ApiResponse<Void> delete(@PathVariable Long id) {
        userService.delete(id);
        return ApiResponse.ok(null);
    }

    /** 查询用户已分配岗位 */
    @GetMapping("/{id}/jd")
    public ApiResponse<java.util.List<UserJd>> listJd(@PathVariable Long id) {
        return ApiResponse.ok(userJdService.listByUser(id));
    }

    /** 分配岗位 */
    @PostMapping("/{id}/jd/{jdId}")
    public ApiResponse<Void> assignJd(@PathVariable Long id, @PathVariable Long jdId) {
        userJdService.assign(id, jdId);
        return ApiResponse.ok(null);
    }

    /** 取消岗位分配 */
    @DeleteMapping("/{id}/jd/{jdId}")
    public ApiResponse<Void> unassignJd(@PathVariable Long id, @PathVariable Long jdId) {
        userJdService.unassign(id, jdId);
        return ApiResponse.ok(null);
    }
}
