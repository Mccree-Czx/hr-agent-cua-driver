package com.hragent.controller;

import com.baomidou.mybatisplus.core.metadata.IPage;
import com.hragent.common.ApiResponse;
import com.hragent.entity.LiepinAccount;
import com.hragent.security.RequireRole;
import com.hragent.service.AccountService;
import com.hragent.service.LoginService;
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
@RequestMapping("/api/account")
public class AccountController {

    private final AccountService accountService;
    private final LoginService loginService;

    public AccountController(AccountService accountService, LoginService loginService) {
        this.accountService = accountService;
        this.loginService = loginService;
    }

    @GetMapping
    public ApiResponse<IPage<LiepinAccount>> page(@RequestParam(defaultValue = "1") int pageNo,
                                                  @RequestParam(defaultValue = "10") int pageSize) {
        return ApiResponse.ok(accountService.page(pageNo, pageSize));
    }

    @GetMapping("/{id}")
    public ApiResponse<LiepinAccount> get(@PathVariable Long id) {
        return ApiResponse.ok(accountService.get(id));
    }

    @PostMapping
    public ApiResponse<LiepinAccount> create(@RequestBody LiepinAccount account) {
        return ApiResponse.ok(accountService.create(account));
    }

    @PutMapping("/{id}")
    public ApiResponse<LiepinAccount> update(@PathVariable Long id, @RequestBody LiepinAccount account) {
        return ApiResponse.ok(accountService.update(id, account));
    }

    @DeleteMapping("/{id}")
    public ApiResponse<Void> delete(@PathVariable Long id) {
        accountService.delete(id);
        return ApiResponse.ok(null);
    }

    /** 发起扫码登录(浏览器弹出窗口,本机扫码;前端轮询 login-status) */
    @PostMapping("/{id}/login")
    @RequireRole("ADMIN")
    public ApiResponse<Void> startLogin(@PathVariable Long id) {
        loginService.startLogin(id);
        return ApiResponse.ok(null);
    }

    /** 登录状态轮询:返回 loginStatus 与是否登录中 */
    @GetMapping("/{id}/login-status")
    public ApiResponse<java.util.Map<String, Object>> loginStatus(@PathVariable Long id) {
        LiepinAccount account = accountService.get(id);
        return ApiResponse.ok(java.util.Map.of(
                "loginStatus", account.getLoginStatus() == null ? "" : account.getLoginStatus(),
                "loggingIn", loginService.isLoggingIn(id)));
    }
}
