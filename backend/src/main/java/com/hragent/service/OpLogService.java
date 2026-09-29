package com.hragent.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.metadata.IPage;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.hragent.entity.OpLog;
import com.hragent.repository.OpLogMapper;
import com.hragent.security.UserContext;
import org.springframework.stereotype.Service;

@Service
public class OpLogService {

    private final OpLogMapper opLogMapper;

    public OpLogService(OpLogMapper opLogMapper) {
        this.opLogMapper = opLogMapper;
    }

    public void log(String action, String targetType, Object targetId, String detail) {
        OpLog log = new OpLog();
        log.setOperator(UserContext.currentUsername());
        log.setAction(action);
        log.setTargetType(targetType);
        log.setTargetId(targetId == null ? null : String.valueOf(targetId));
        log.setDetail(detail);
        opLogMapper.insert(log);
    }

    public IPage<OpLog> page(int pageNo, int pageSize) {
        return opLogMapper.selectPage(new Page<>(pageNo, pageSize),
                new LambdaQueryWrapper<OpLog>().orderByDesc(OpLog::getId));
    }
}
