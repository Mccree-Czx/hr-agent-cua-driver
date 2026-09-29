package com.hragent.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.metadata.IPage;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.hragent.common.BizException;
import com.hragent.entity.SysUser;
import com.hragent.repository.SysUserMapper;
import com.hragent.security.UserContext;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class UserService {

    private final SysUserMapper sysUserMapper;
    private final AuthService authService;
    private final OpLogService opLogService;

    public UserService(SysUserMapper sysUserMapper, AuthService authService, OpLogService opLogService) {
        this.sysUserMapper = sysUserMapper;
        this.authService = authService;
        this.opLogService = opLogService;
    }

    public IPage<SysUser> page(int pageNo, int pageSize) {
        return sysUserMapper.selectPage(new Page<>(pageNo, pageSize),
                new LambdaQueryWrapper<SysUser>().orderByDesc(SysUser::getId));
    }

    @Transactional
    public SysUser create(String username, String rawPassword, String role) {
        if (sysUserMapper.selectCount(
                new LambdaQueryWrapper<SysUser>().eq(SysUser::getUsername, username)) > 0) {
            throw BizException.badRequest("用户名已存在");
        }
        SysUser user = new SysUser();
        user.setUsername(username);
        user.setPassword(authService.encodePassword(rawPassword));
        user.setRole(role == null ? "HR" : role);
        sysUserMapper.insert(user);
        opLogService.log("CREATE", "user", user.getId(), "新增用户: " + username);
        return user;
    }

    @Transactional
    public SysUser update(Long id, String role, String rawPassword) {
        SysUser user = sysUserMapper.selectById(id);
        if (user == null) {
            throw BizException.notFound("用户不存在");
        }
        if (role != null) {
            user.setRole(role);
        }
        if (rawPassword != null && !rawPassword.isBlank()) {
            user.setPassword(authService.encodePassword(rawPassword));
        }
        sysUserMapper.updateById(user);
        opLogService.log("UPDATE", "user", id, "更新用户: " + user.getUsername());
        return user;
    }

    @Transactional
    public void delete(Long id) {
        SysUser user = sysUserMapper.selectById(id);
        if (user == null) {
            throw BizException.notFound("用户不存在");
        }
        if (user.getId().equals(UserContext.get().getUserId())) {
            throw BizException.badRequest("不能删除自己");
        }
        sysUserMapper.deleteById(id);
        opLogService.log("DELETE", "user", id, "删除用户: " + user.getUsername());
    }
}
