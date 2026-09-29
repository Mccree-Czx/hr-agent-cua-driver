package com.hragent.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.metadata.IPage;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.hragent.common.BizException;
import com.hragent.entity.LiepinAccount;
import com.hragent.repository.LiepinAccountMapper;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class AccountService {

    private final LiepinAccountMapper accountMapper;
    private final OpLogService opLogService;

    public AccountService(LiepinAccountMapper accountMapper, OpLogService opLogService) {
        this.accountMapper = accountMapper;
        this.opLogService = opLogService;
    }

    public IPage<LiepinAccount> page(int pageNo, int pageSize) {
        return accountMapper.selectPage(new Page<>(pageNo, pageSize),
                new LambdaQueryWrapper<LiepinAccount>().orderByDesc(LiepinAccount::getId));
    }

    public LiepinAccount get(Long id) {
        LiepinAccount account = accountMapper.selectById(id);
        if (account == null) {
            throw BizException.notFound("账号不存在");
        }
        return account;
    }

    @Transactional
    public LiepinAccount create(LiepinAccount account) {
        account.setId(null);
        account.setLoginStatus("NEED_SCAN");
        account.setCircuitBreaker(false);
        account.setGreetMode("AUTO");
        // 默认配额 50:猎聘开聊权益约 100 点/天,预留安全余量
        account.setDailyGreetQuota(50);
        accountMapper.insert(account);
        opLogService.log("CREATE", "account", account.getId(), "新增猎聘账号: " + account.getName());
        return get(account.getId());
    }

    @Transactional
    public LiepinAccount update(Long id, LiepinAccount account) {
        get(id); // 存在性校验
        account.setId(id);
        accountMapper.updateById(account);
        opLogService.log("UPDATE", "account", id, "更新猎聘账号: " + account.getName());
        return get(id);
    }

    @Transactional
    public void delete(Long id) {
        get(id);
        accountMapper.deleteById(id);
        opLogService.log("DELETE", "account", id, "删除猎聘账号");
    }
}
