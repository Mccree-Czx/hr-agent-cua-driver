package com.hragent.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.hragent.common.BizException;
import com.hragent.config.HrAgentProperties;
import com.hragent.entity.Candidate;
import com.hragent.entity.Jd;
import com.hragent.entity.LiepinAccount;
import com.hragent.entity.SearchTask;
import com.hragent.executor.CliException;
import com.hragent.notify.NotifyService;
import com.hragent.repository.CandidateMapper;
import com.hragent.repository.JdMapper;
import com.hragent.repository.LiepinAccountMapper;
import com.hragent.repository.SearchTaskMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Duration;
import java.util.List;

/**
 * 搜索任务流程:JD 关键词 → liepin search → 候选人快照落库(按 resume_id+name 去重)。
 */
@Slf4j
@Service
public class SearchTaskService {

    private final SearchTaskMapper taskMapper;
    private final JdMapper jdMapper;
    private final LiepinAccountMapper accountMapper;
    private final CandidateMapper candidateMapper;
    private final LiepinCommandService commandService;
    private final TaskQueueService queueService;
    private final HrAgentProperties properties;
    private final NotifyService notifyService;
    private final RiskSuspectGuard riskSuspectGuard;
    private final ObjectMapper objectMapper = new ObjectMapper();

    public SearchTaskService(SearchTaskMapper taskMapper, JdMapper jdMapper,
                             LiepinAccountMapper accountMapper, CandidateMapper candidateMapper,
                             LiepinCommandService commandService, TaskQueueService queueService,
                             HrAgentProperties properties, NotifyService notifyService,
                             RiskSuspectGuard riskSuspectGuard) {
        this.taskMapper = taskMapper;
        this.jdMapper = jdMapper;
        this.accountMapper = accountMapper;
        this.candidateMapper = candidateMapper;
        this.commandService = commandService;
        this.queueService = queueService;
        this.properties = properties;
        this.notifyService = notifyService;
        this.riskSuspectGuard = riskSuspectGuard;
    }

    /** 创建搜索任务(关键词取 JD 对内寻源备注,为空则用岗位名) */
    @Transactional
    public SearchTask createTask(Long jdId, Long accountId) {
        Jd jd = jdMapper.selectById(jdId);
        if (jd == null) {
            throw BizException.notFound("岗位不存在");
        }
        LiepinAccount account = accountMapper.selectById(accountId);
        if (account == null) {
            throw BizException.notFound("猎聘账号不存在");
        }
        String keywords = (jd.getInternalNotes() == null || jd.getInternalNotes().isBlank())
                ? jd.getTitle() : jd.getInternalNotes();

        SearchTask task = new SearchTask();
        task.setJdId(jdId);
        task.setAccountId(accountId);
        task.setTaskType("SEARCH");
        task.setKeywords(keywords);
        task.setStatus("QUEUED");
        task.setRetryCount(0);
        taskMapper.insert(task);
        return task;
    }

    /** 创建平台推荐任务(拉取猎聘按已发布职位的推荐人选) */
    @Transactional
    public SearchTask createRecommendTask(Long jdId, Long accountId) {
        Jd jd = jdMapper.selectById(jdId);
        if (jd == null) {
            throw BizException.notFound("岗位不存在");
        }
        LiepinAccount account = accountMapper.selectById(accountId);
        if (account == null) {
            throw BizException.notFound("猎聘账号不存在");
        }
        requireRecommendJobId(jd);
        SearchTask task = new SearchTask();
        task.setJdId(jdId);
        task.setAccountId(accountId);
        task.setTaskType("RECOMMEND");
        task.setKeywords(jd.getTitle());
        task.setStatus("QUEUED");
        task.setRetryCount(0);
        taskMapper.insert(task);
        return task;
    }

    /**
     * 执行任务主流程(由调度器调用):
     * 账号熔断直接终态失败;CLI 异常按类型重试或终态;成功则候选人落库并 DONE。
     */
    public void execute(SearchTask task) {
        LiepinAccount account = accountMapper.selectById(task.getAccountId());
        if (account == null) {
            queueService.fail(task.getId(), "账号不存在", task.getRetryCount());
            return;
        }
        if (Boolean.TRUE.equals(account.getCircuitBreaker())) {
            queueService.fail(task.getId(), "账号已熔断,停止调度", TaskQueueService.MAX_RETRY);
            return;
        }
        if ("NEED_SCAN".equals(account.getLoginStatus())) {
            queueService.fail(task.getId(), "账号需扫码登录,任务挂起", task.getRetryCount());
            return;
        }

        try {
            List<JsonNode> candidates;
            if ("RECOMMEND".equals(task.getTaskType())) {
                // 平台推荐:拉取猎聘按已发布职位推送的推荐人选
                String jobId = requireRecommendJobId(jdMapper.selectById(task.getJdId()));
                candidates = commandService.recommend(
                        account, jobId, Duration.ofMinutes(properties.getLiepin().getShortTimeoutMinutes()));
            } else {
                Duration timeout = Duration.ofMinutes(properties.getLiepin().getSearchTimeoutMinutes());
                candidates = commandService.search(
                        account, task.getKeywords(), properties.getLiepin().getSearchLimit(), timeout);
            }
            int saved = saveCandidates(task.getJdId(), candidates);
            queueService.complete(task.getId());
            log.info("任务 {} 完成:{} 条候选人,落库/更新 {} 条", task.getId(), candidates.size(), saved);
        } catch (CliException e) {
            if (e.getType() == CliException.Type.RISK_CONTROL) {
                if (riskSuspectGuard.isHolding(task.getAccountId())) {
                    // 首次命中:已进入冻结退避——任务按普通失败重试排期(调度器门禁保证解冻后才重试,
                    // 该重试即天然复测);不终态
                    queueService.fail(task.getId(), "疑似风控拦截,退避后重试: " + e.getMessage(),
                            task.getRetryCount());
                } else {
                    // 真实熔断(复测再次命中/退避关闭):账号已置 RESTRICTED,任务无重试意义 → 终态失败
                    queueService.fail(task.getId(), "账号触发风控熔断: " + e.getMessage(), TaskQueueService.MAX_RETRY);
                }
            } else {
                queueService.fail(task.getId(), e.getMessage(), task.getRetryCount());
            }
        } catch (Exception e) {
            log.error("任务 {} 执行异常", task.getId(), e);
            queueService.fail(task.getId(), "执行异常: " + e.getMessage(), task.getRetryCount());
        }

        // 终态失败告警(评审 P2-14)
        SearchTask after = taskMapper.selectById(task.getId());
        if (after != null && "FAILED".equals(after.getStatus())) {
            notifyService.alert("搜索任务终态失败",
                    "任务: #" + task.getId() + " 岗位: " + task.getJdId() + " 关键词: " + task.getKeywords()
                            + "\n原因: " + after.getErrorMsg());
        }
    }

    /** 候选人落库:按 (resume_id, name) 去重,存在则更新快照;兼容平台推荐数据 */
    @Transactional
    public int saveCandidates(Long jdId, List<JsonNode> nodes) {
        int saved = 0;
        for (JsonNode node : nodes) {
            String resumeId = extractResumeId(node);
            String name = node.path("name").asText("");
            if (resumeId.isBlank() || name.isBlank()) {
                continue;
            }
            Candidate existing = candidateMapper.selectOne(new LambdaQueryWrapper<Candidate>()
                    .eq(Candidate::getResumeId, resumeId)
                    .eq(Candidate::getName, name));
            if (existing != null) {
                existing.setSnapshot(toJson(node));
                candidateMapper.updateById(existing);
            } else {
                Candidate candidate = new Candidate();
                candidate.setResumeId(resumeId);
                candidate.setName(name);
                candidate.setSnapshot(toJson(node));
                candidate.setPassStatus("PENDING");
                candidate.setJdId(jdId);
                candidateMapper.insert(candidate);
            }
            saved++;
        }
        return saved;
    }

    /**
     * 提取简历 ID:
     * - 搜索数据:resume_id 字段
     * - 平台推荐数据:url 中的 resIdEncode 参数,缺失时回退 talentId
     */
    private String extractResumeId(JsonNode node) {
        String resumeId = node.path("resume_id").asText("");
        if (!resumeId.isBlank()) {
            return resumeId;
        }
        String url = node.path("url").asText("");
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("resIdEncode=([^&]+)").matcher(url);
        if (m.find()) {
            return m.group(1);
        }
        return node.path("talentId").asText("");
    }

    private String requireRecommendJobId(Jd jd) {
        if (jd == null || jd.getLiepinJobId() == null || !jd.getLiepinJobId().matches("[1-9][0-9]*")) {
            throw BizException.badRequest("岗位不存在或未关联有效的猎聘岗位 ID，禁止默认推荐");
        }
        return jd.getLiepinJobId();
    }

    private String toJson(JsonNode node) {
        try {
            return objectMapper.writeValueAsString(node);
        } catch (JsonProcessingException e) {
            return "{}";
        }
    }
}
