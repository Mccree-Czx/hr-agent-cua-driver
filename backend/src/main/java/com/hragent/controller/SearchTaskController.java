package com.hragent.controller;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.metadata.IPage;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.hragent.common.ApiResponse;
import com.hragent.config.SearchTaskScheduler;
import com.hragent.dto.CreateSearchTaskRequest;
import com.hragent.entity.SearchTask;
import com.hragent.repository.SearchTaskMapper;
import com.hragent.security.RequireRole;
import com.hragent.service.SearchTaskService;
import jakarta.validation.Valid;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/search-task")
public class SearchTaskController {

    private final SearchTaskService searchTaskService;
    private final SearchTaskMapper taskMapper;
    private final ObjectProvider<SearchTaskScheduler> scheduler;

    public SearchTaskController(SearchTaskService searchTaskService, SearchTaskMapper taskMapper,
                                ObjectProvider<SearchTaskScheduler> scheduler) {
        this.searchTaskService = searchTaskService;
        this.taskMapper = taskMapper;
        this.scheduler = scheduler;
    }

    /** 创建搜索任务(入队) */
    @PostMapping
    public ApiResponse<SearchTask> create(@Valid @RequestBody CreateSearchTaskRequest request) {
        return ApiResponse.ok(searchTaskService.createTask(request.getJdId(), request.getAccountId()));
    }

    /** 创建平台推荐任务(拉取猎聘按已发布职位的推荐人选,入队) */
    @PostMapping("/recommend")
    public ApiResponse<SearchTask> createRecommend(@Valid @RequestBody CreateSearchTaskRequest request) {
        return ApiResponse.ok(searchTaskService.createRecommendTask(request.getJdId(), request.getAccountId()));
    }

    /** 任务列表 */
    @GetMapping
    public ApiResponse<IPage<SearchTask>> page(@RequestParam(defaultValue = "1") int pageNo,
                                               @RequestParam(defaultValue = "10") int pageSize,
                                               @RequestParam(required = false) String status) {
        LambdaQueryWrapper<SearchTask> qw = new LambdaQueryWrapper<SearchTask>()
                .eq(status != null && !status.isBlank(), SearchTask::getStatus, status)
                .orderByDesc(SearchTask::getId);
        return ApiResponse.ok(taskMapper.selectPage(new Page<>(pageNo, pageSize), qw));
    }

    /** 手动触发一轮调度(调试/验收用,管理员) */
    @PostMapping("/tick")
    @RequireRole("ADMIN")
    public ApiResponse<Void> tick() {
        scheduler.ifAvailable(SearchTaskScheduler::tick);
        return ApiResponse.ok(null);
    }
}
