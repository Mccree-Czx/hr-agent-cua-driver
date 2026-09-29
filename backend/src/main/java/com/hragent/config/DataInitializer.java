package com.hragent.config;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.hragent.entity.SysUser;
import com.hragent.repository.SysUserMapper;
import com.hragent.service.AuthService;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.stereotype.Component;

/**
 * 首次启动时创建默认管理员账号 admin / admin123(生产环境请立即修改)。
 */
@Slf4j
@Component
public class DataInitializer implements ApplicationRunner {

    private final SysUserMapper sysUserMapper;
    private final AuthService authService;

    public DataInitializer(SysUserMapper sysUserMapper, AuthService authService) {
        this.sysUserMapper = sysUserMapper;
        this.authService = authService;
    }

    @Override
    public void run(ApplicationArguments args) {
        if (sysUserMapper.selectCount(new LambdaQueryWrapper<>()) == 0) {
            SysUser admin = new SysUser();
            admin.setUsername("admin");
            admin.setPassword(authService.encodePassword("admin123"));
            admin.setRole("ADMIN");
            sysUserMapper.insert(admin);
            log.warn("已创建默认管理员账号 admin / admin123,请尽快登录修改密码");
        }
    }
}
