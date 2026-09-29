package com.hragent.controller;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.metadata.IPage;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.fasterxml.jackson.databind.JsonNode;
import com.hragent.common.ApiResponse;
import com.hragent.common.BizException;
import com.hragent.config.HrAgentProperties;
import com.hragent.dto.CandidateDetail;
import com.hragent.dto.CandidateLedger;
import com.hragent.entity.Candidate;
import com.hragent.entity.GreetingRecord;
import com.hragent.entity.Jd;
import com.hragent.entity.LiepinAccount;
import com.hragent.entity.ResumeFile;
import com.hragent.entity.ScoreRecord;
import com.hragent.entity.SysUser;
import com.hragent.executor.CliException;
import com.hragent.executor.JsonExtractor;
import com.hragent.repository.CandidateMapper;
import com.hragent.repository.GreetingRecordMapper;
import com.hragent.repository.JdMapper;
import com.hragent.repository.LiepinAccountMapper;
import com.hragent.repository.ResumeFileMapper;
import com.hragent.repository.ScoreRecordMapper;
import com.hragent.repository.SysUserMapper;
import com.hragent.security.LoginUser;
import com.hragent.security.UserContext;
import com.hragent.service.LiepinCommandService;
import com.hragent.service.OpLogService;
import com.hragent.service.UserJdService;
import com.hragent.storage.StorageService;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;
import java.util.stream.Collectors;

/** 候选人台账:全流程状态可见(搜索→评分→打招呼→简历入库) */
@RestController
@RequestMapping("/api/candidate")
public class CandidateController {

    private final CandidateMapper candidateMapper;
    private final ScoreRecordMapper scoreRecordMapper;
    private final GreetingRecordMapper greetingMapper;
    private final ResumeFileMapper resumeFileMapper;
    private final JdMapper jdMapper;
    private final UserJdService userJdService;
    private final StorageService storageService;
    private final SysUserMapper sysUserMapper;
    private final LiepinCommandService commandService;
    private final LiepinAccountMapper accountMapper;
    private final HrAgentProperties properties;
    private final OpLogService opLogService;

    public CandidateController(CandidateMapper candidateMapper, ScoreRecordMapper scoreRecordMapper,
                               GreetingRecordMapper greetingMapper, ResumeFileMapper resumeFileMapper,
                               JdMapper jdMapper, UserJdService userJdService,
                               StorageService storageService, SysUserMapper sysUserMapper,
                               LiepinCommandService commandService, LiepinAccountMapper accountMapper,
                               HrAgentProperties properties, OpLogService opLogService) {
        this.candidateMapper = candidateMapper;
        this.scoreRecordMapper = scoreRecordMapper;
        this.greetingMapper = greetingMapper;
        this.resumeFileMapper = resumeFileMapper;
        this.jdMapper = jdMapper;
        this.userJdService = userJdService;
        this.storageService = storageService;
        this.sysUserMapper = sysUserMapper;
        this.commandService = commandService;
        this.accountMapper = accountMapper;
        this.properties = properties;
        this.opLogService = opLogService;
    }

    @GetMapping
    public ApiResponse<IPage<CandidateLedger>> page(@RequestParam(defaultValue = "1") int pageNo,
                                                    @RequestParam(defaultValue = "10") int pageSize,
                                                    @RequestParam(required = false) Long jdId,
                                                    @RequestParam(required = false) String passStatus,
                                                    @RequestParam(required = false) Integer star,
                                                    @RequestParam(required = false) String recruitStatus,
                                                    @RequestParam(required = false) Boolean hasResumeFile,
                                                    @RequestParam(required = false) Boolean unassigned) {
        LoginUser user = UserContext.get();
        Set<Long> allowed = userJdService.allowedJdIds(user.getUserId(), user.getRole());
        boolean admin = allowed == null;

        boolean onlyWithResume = Boolean.TRUE.equals(hasResumeFile);
        boolean onlyUnassigned = Boolean.TRUE.equals(unassigned);

        // 待分配视图仅 ADMIN 可见(评审 I-1):该视图候选人无有效岗位,无法按岗位授权过滤,
        // 若放开非 ADMIN 将越权读取全系统无岗位/岗位已删候选人池;非 ADMIN 请求此参数返回空分页。
        if (onlyUnassigned && !admin) {
            return ApiResponse.ok(emptyLedgerPage(pageNo, pageSize));
        }

        LambdaQueryWrapper<Candidate> qw = new LambdaQueryWrapper<Candidate>()
                .eq(jdId != null, Candidate::getJdId, jdId)
                .eq(passStatus != null && !passStatus.isBlank(), Candidate::getPassStatus, passStatus)
                .eq(star != null, Candidate::getStar, star)
                .eq(recruitStatus != null && !recruitStatus.isBlank(), Candidate::getRecruitStatus, recruitStatus)
                .orderByDesc(Candidate::getId);

        // 已收简历视图:仅返回存在 resume_file 入库记录的候选人(设计 §3.4/§4.3)
        if (onlyWithResume) {
            Set<Long> withResume = resumeFileMapper.selectList(null).stream()
                    .map(ResumeFile::getCandidateId)
                    .filter(java.util.Objects::nonNull)
                    .collect(Collectors.toSet());
            if (withResume.isEmpty()) {
                return ApiResponse.ok(emptyLedgerPage(pageNo, pageSize));
            }
            qw.in(Candidate::getId, withResume);
        }

        // 待分配视图:jd_id 为空或指向已不存在的岗位(设计 §4.3)
        if (onlyUnassigned) {
            Set<Long> existingJdIds = jdMapper.selectList(null).stream()
                    .map(Jd::getId)
                    .collect(Collectors.toSet());
            // jd 表为空时,任何非空 jd_id 均视为失效 → 仅按 isNull / isNotNull 组合
            qw.and(w -> w.isNull(Candidate::getJdId)
                    .or(inner -> inner.isNotNull(Candidate::getJdId)
                            .notIn(!existingJdIds.isEmpty(), Candidate::getJdId, existingJdIds)));
        }

        // 岗位权限过滤(ADMIN 的 allowed 为 null 表示不限);待分配视图已在上面限定仅 ADMIN 可达。
        if (allowed != null) {
            if (allowed.isEmpty()) {
                return ApiResponse.ok(emptyLedgerPage(pageNo, pageSize));
            }
            qw.in(Candidate::getJdId, allowed);
        }

        Page<Candidate> page = candidateMapper.selectPage(new Page<>(pageNo, pageSize), qw);
        List<CandidateLedger> ledgers = assembleLedgers(page.getRecords());

        Page<CandidateLedger> result = new Page<>(page.getCurrent(), page.getSize(), page.getTotal());
        result.setRecords(ledgers);
        return ApiResponse.ok(result);
    }

    /** 空结果分页(权限不可见/过滤无命中时 total=0) */
    private Page<CandidateLedger> emptyLedgerPage(int pageNo, int pageSize) {
        Page<CandidateLedger> empty = new Page<>(pageNo, pageSize);
        empty.setRecords(new ArrayList<>());
        empty.setTotal(0);
        return empty;
    }

    /**
     * 简历文件下载(HR 筛选工作台,2026-09-26):ADMIN 或候选人所属岗位在分配范围内才可访问。
     * 越权 403;候选人不存在/未入库/存储缺失 404;返回 PDF 流(inline,可预览或下载)。
     */
    @GetMapping("/{id}/resume")
    public ResponseEntity<byte[]> resume(@PathVariable Long id) {
        LoginUser user = UserContext.get();
        Set<Long> allowed = userJdService.allowedJdIds(user.getUserId(), user.getRole());

        Candidate candidate = candidateMapper.selectById(id);
        if (candidate == null) {
            throw BizException.notFound("候选人不存在");
        }
        if (allowed != null && (candidate.getJdId() == null || !allowed.contains(candidate.getJdId()))) {
            throw BizException.forbidden("无权查看该候选人简历");
        }

        ResumeFile file = resumeFileMapper.selectOne(new LambdaQueryWrapper<ResumeFile>()
                .eq(ResumeFile::getCandidateId, id)
                .orderByDesc(ResumeFile::getId)
                .last("LIMIT 1"));
        if (file == null || file.getObjectKey() == null) {
            throw BizException.notFound("简历未入库");
        }
        byte[] bytes = storageService.load(file.getObjectKey());
        if (bytes == null || bytes.length == 0) {
            throw BizException.notFound("简历文件缺失");
        }

        // 读标记(参照 HR Portal V2 约定:预览成功即记录最后查看人/时间)
        candidate.setResumeLastViewedAt(LocalDateTime.now());
        candidate.setResumeLastViewedBy(user.getUserId());
        candidateMapper.updateById(candidate);

        MediaType mediaType = "pdf".equalsIgnoreCase(file.getFormat())
                ? MediaType.APPLICATION_PDF : MediaType.APPLICATION_OCTET_STREAM;
        return ResponseEntity.ok()
                .contentType(mediaType)
                .contentLength(bytes.length)
                .header(HttpHeaders.CONTENT_DISPOSITION, ContentDisposition.inline()
                        .filename(displayName(file), StandardCharsets.UTF_8).build().toString())
                .body(bytes);
    }

    /** 招聘跟进状态合法值(单一来源;中文标签在前端 labels.js 单一映射表) */
    private static final Set<String> RECRUIT_STATUSES = Set.of(
            "PENDING_REVIEW", "QUALIFIED", "INTERVIEW_SCHEDULED", "NOT_SUITABLE");

    /**
     * 更新招聘跟进状态(HR 筛选工作台;参照 HR Portal V2 工作流)。
     * 非法值 400;非 ADMIN 仅限其授权岗位下的候选人,否则 403。
     */
    @PatchMapping("/{id}/recruit-status")
    public ApiResponse<Candidate> setRecruitStatus(@PathVariable Long id,
                                                   @RequestBody RecruitStatusRequest request) {
        String status = request == null || request.recruitStatus() == null ? "" : request.recruitStatus().trim();
        if (!RECRUIT_STATUSES.contains(status)) {
            throw BizException.badRequest("非法的招聘状态: " + status);
        }
        Candidate candidate = requireVisibleCandidate(id, "无权操作该候选人");
        candidate.setRecruitStatus(status);
        candidateMapper.updateById(candidate);
        return ApiResponse.ok(candidate);
    }

    /**
     * 疑似否决改判(2026-09-29 一票否决闭环):仅对 HOLD 状态候选人可用;
     * confirm → FAIL(确认淘汰);reject → 按星级恢复(≥3星 PASS / 2星 KEPT / 其余 FAIL);写改判人/时间 + 审计。
     */
    @PatchMapping("/{id}/veto")
    public ApiResponse<Candidate> resolveVeto(@PathVariable Long id, @RequestBody VetoRequest request) {
        String action = request == null || request.action() == null ? "" : request.action().trim();
        if (!VETO_ACTIONS.contains(action)) {
            throw BizException.badRequest("非法的改判动作: " + action);
        }
        Candidate candidate = requireVisibleCandidate(id, "无权操作该候选人");
        if (!"HOLD".equals(candidate.getPassStatus())) {
            throw BizException.badRequest("该候选人当前非疑似否决(HOLD)状态,无需改判");
        }
        LoginUser user = UserContext.get();
        String resolved;
        if ("confirm".equals(action)) {
            resolved = "FAIL";
        } else {
            int star = candidate.getStar() == null ? 1 : candidate.getStar();
            resolved = star >= 3 ? "PASS" : star == 2 ? "KEPT" : "FAIL";
        }
        candidate.setPassStatus(resolved);
        candidate.setVetoConfirmedBy(user.getUserId());
        candidate.setVetoConfirmedAt(LocalDateTime.now());
        candidateMapper.updateById(candidate);
        opLogService.log("UPDATE", "candidate", id,
                ("confirm".equals(action) ? "疑似否决确认淘汰" : "疑似否决驳回,恢复为 " + resolved)
                        + ": " + candidate.getName());
        return ApiResponse.ok(candidate);
    }

    /** 疑似否决改判动作合法值(单一来源) */
    private static final Set<String> VETO_ACTIONS = Set.of("confirm", "reject");

    public record VetoRequest(String action) {
    }

    /**
     * 候选人详情(抽屉三区:基本信息 / AI 评分 / 简历资料)。
     * 授权同简历下载:ADMIN 或候选人所属岗位在分配范围内。
     */
    @GetMapping("/{id}/detail")
    public ApiResponse<CandidateDetail> detail(@PathVariable Long id) {
        Candidate candidate = requireVisibleCandidate(id, "无权查看该候选人");
        ScoreRecord latestScore = scoreRecordMapper.selectOne(new LambdaQueryWrapper<ScoreRecord>()
                .eq(ScoreRecord::getCandidateId, id)
                .orderByDesc(ScoreRecord::getId)
                .last("LIMIT 1"));
        ResumeFile resumeFile = resumeFileMapper.selectOne(new LambdaQueryWrapper<ResumeFile>()
                .eq(ResumeFile::getCandidateId, id)
                .orderByDesc(ResumeFile::getId)
                .last("LIMIT 1"));
        Jd jd = candidate.getJdId() == null ? null : jdMapper.selectById(candidate.getJdId());
        return ApiResponse.ok(new CandidateDetail(
                candidate,
                jd == null ? null : jd.getTitle(),
                latestScore,
                resumeFile,
                resumeFile == null ? null : displayName(resumeFile),
                nameOf(candidate.getResumeLastViewedBy())));
    }

    /**
     * 在线简历(实时拉取,2026-09-28):调 CLI resume 获取平台在线简历详情,原样返回结构化 JSON。
     * 每次调用为一次平台读取(只读轻足迹);成功即打读标记(与附件预览约定一致)。
     * 风控/登录态异常由 CLI 链路标记与告警,这里返回可读原因。
     */
    @PostMapping("/{id}/online-resume")
    public ApiResponse<JsonNode> onlineResume(@PathVariable Long id) {
        Candidate candidate = requireVisibleCandidate(id, "无权查看该候选人简历");
        String resumeId = resumeDetailId(candidate);
        if (resumeId.isEmpty()) {
            throw BizException.badRequest("该候选人无可用的简历标识,无法查看在线简历");
        }
        LiepinAccount account = accountMapper.selectOne(new LambdaQueryWrapper<LiepinAccount>()
                .eq(LiepinAccount::getLoginStatus, "NORMAL")
                .orderByAsc(LiepinAccount::getId)
                .last("LIMIT 1"));
        if (account == null) {
            throw BizException.badRequest("无可用猎聘账号(登录态非 NORMAL),无法拉取在线简历");
        }
        JsonNode detail;
        try {
            detail = commandService.resume(account, resumeId,
                    Duration.ofMinutes(properties.getLiepin().getShortTimeoutMinutes())).orElse(null);
        } catch (CliException e) {
            throw BizException.badRequest(e.getMessage());
        }
        if (detail == null || !detail.isObject()) {
            throw BizException.badRequest("平台未返回在线简历详情(简历标识无效或无查看权限)");
        }
        candidate.setResumeLastViewedAt(LocalDateTime.now());
        candidate.setResumeLastViewedBy(UserContext.get().getUserId());
        candidateMapper.updateById(candidate);
        return ApiResponse.ok(detail);
    }

    /** 在线简历详情入参:优先快照内 resume_id,其次落库主列(与 ScoringEngine 同口径) */
    private String resumeDetailId(Candidate candidate) {
        JsonNode snapshot = JsonExtractor.parse(candidate.getSnapshot()).orElse(null);
        if (snapshot != null) {
            String fromSnapshot = snapshot.path("resume_id").asText("").trim();
            if (!fromSnapshot.isEmpty()) {
                return fromSnapshot;
            }
        }
        String stored = candidate.getResumeId();
        return stored == null ? "" : stored.trim();
    }

    /** 授权校验:候选人存在 + (ADMIN 或所属岗位在授权范围内);否则 404 / 403 */
    private Candidate requireVisibleCandidate(Long id, String forbiddenMessage) {
        LoginUser user = UserContext.get();
        Set<Long> allowed = userJdService.allowedJdIds(user.getUserId(), user.getRole());
        Candidate candidate = candidateMapper.selectById(id);
        if (candidate == null) {
            throw BizException.notFound("候选人不存在");
        }
        if (allowed != null && (candidate.getJdId() == null || !allowed.contains(candidate.getJdId()))) {
            throw BizException.forbidden(forbiddenMessage);
        }
        return candidate;
    }

    /** 用户显示名(username;不存在返回 null) */
    private String nameOf(Long userId) {
        if (userId == null) {
            return null;
        }
        SysUser user = sysUserMapper.selectById(userId);
        return user == null ? null : user.getUsername();
    }

    /** 招聘状态请求体 */
    public record RecruitStatusRequest(String recruitStatus) {
    }

    /** 展示文件名:取 objectKey 文件名部分并去除候选 ID 前缀(objectKey 形如 resumes/20260926/{id}-{safeName}) */
    private static String displayName(ResumeFile file) {
        String key = file.getObjectKey();
        int slash = key.lastIndexOf('/');
        String base = slash >= 0 ? key.substring(slash + 1) : key;
        String prefix = file.getCandidateId() + "-";
        if (base.startsWith(prefix)) {
            base = base.substring(prefix.length());
        }
        return base.isBlank() ? "resume.pdf" : base;
    }

    /** 组装台账:批量取最新评分/打招呼/简历文件 */
    private List<CandidateLedger> assembleLedgers(List<Candidate> candidates) {
        if (candidates.isEmpty()) {
            return new ArrayList<>();
        }
        List<Long> ids = candidates.stream().map(Candidate::getId).toList();

        Map<Long, ScoreRecord> scores = scoreRecordMapper.selectList(
                        new LambdaQueryWrapper<ScoreRecord>().in(ScoreRecord::getCandidateId, ids))
                .stream().collect(Collectors.toMap(ScoreRecord::getCandidateId, Function.identity(),
                        (a, b) -> a.getId() > b.getId() ? a : b));
        Map<Long, GreetingRecord> greetings = greetingMapper.selectList(
                        new LambdaQueryWrapper<GreetingRecord>().in(GreetingRecord::getCandidateId, ids))
                .stream().collect(Collectors.toMap(GreetingRecord::getCandidateId, Function.identity(), (a, b) -> a));
        Map<Long, ResumeFile> resumes = resumeFileMapper.selectList(
                        new LambdaQueryWrapper<ResumeFile>().in(ResumeFile::getCandidateId, ids))
                .stream().collect(Collectors.toMap(ResumeFile::getCandidateId, Function.identity(), (a, b) -> a));
        // 最后查看人显示名:单次批量查询,避免 N+1
        Set<Long> viewedByIds = candidates.stream()
                .map(Candidate::getResumeLastViewedBy)
                .filter(java.util.Objects::nonNull)
                .collect(Collectors.toSet());
        Map<Long, String> viewerNames = viewedByIds.isEmpty() ? Map.of()
                : sysUserMapper.selectBatchIds(viewedByIds).stream()
                        .collect(Collectors.toMap(SysUser::getId, SysUser::getUsername, (a, b) -> a));

        List<CandidateLedger> ledgers = new ArrayList<>();
        for (Candidate candidate : candidates) {
            Long viewedBy = candidate.getResumeLastViewedBy();
            ledgers.add(new CandidateLedger(
                    candidate,
                    scores.get(candidate.getId()),
                    greetings.get(candidate.getId()),
                    resumes.get(candidate.getId()),
                    viewedBy == null ? null : viewerNames.get(viewedBy)));
        }
        return ledgers;
    }
}
