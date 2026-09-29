package com.hragent.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.hragent.entity.UserJd;
import com.hragent.repository.UserJdMapper;
import com.hragent.security.UserContext;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.Set;
import java.util.stream.Collectors;

/** 用户↔岗位分配(评审 P1-8:普通 HR 只操作被分配岗位) */
@Service
public class UserJdService {

    private final UserJdMapper userJdMapper;

    public UserJdService(UserJdMapper userJdMapper) {
        this.userJdMapper = userJdMapper;
    }

    /** 当前用户可操作的岗位集合;ADMIN 返回 null 表示不限 */
    public Set<Long> allowedJdIds(Long userId, String role) {
        if ("ADMIN".equals(role)) {
            return null;
        }
        return userJdMapper.selectList(new LambdaQueryWrapper<UserJd>()
                        .eq(UserJd::getUserId, userId))
                .stream().map(UserJd::getJdId).collect(Collectors.toSet());
    }

    @Transactional
    public void assign(Long userId, Long jdId) {
        if (userJdMapper.selectCount(new LambdaQueryWrapper<UserJd>()
                .eq(UserJd::getUserId, userId).eq(UserJd::getJdId, jdId)) > 0) {
            return;
        }
        UserJd userJd = new UserJd();
        userJd.setUserId(userId);
        userJd.setJdId(jdId);
        userJdMapper.insert(userJd);
    }

    @Transactional
    public void unassign(Long userId, Long jdId) {
        userJdMapper.delete(new LambdaQueryWrapper<UserJd>()
                .eq(UserJd::getUserId, userId).eq(UserJd::getJdId, jdId));
    }

    public List<UserJd> listByUser(Long userId) {
        return userJdMapper.selectList(new LambdaQueryWrapper<UserJd>()
                .eq(UserJd::getUserId, userId));
    }
}
