package com.hragent.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.fasterxml.jackson.databind.JsonNode;
import com.hragent.entity.Candidate;
import com.hragent.entity.GreetingRecord;
import com.hragent.entity.Jd;
import com.hragent.entity.LiepinAccount;
import com.hragent.entity.ResumeFile;
import com.hragent.executor.JsonExtractor;
import com.hragent.repository.CandidateMapper;
import com.hragent.repository.GreetingRecordMapper;
import com.hragent.repository.JdMapper;
import com.hragent.repository.LiepinAccountMapper;
import com.hragent.repository.ResumeFileMapper;
import com.hragent.storage.StorageService;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.security.MessageDigest;
import java.time.Duration;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.HexFormat;
import java.util.List;
import java.util.Optional;

/**
 * 简历收集(阶段 4):
 * 1. 同意状态检测:chatlist 查对方是否回复(direction=0 为对方发来)
 * 2. 有回复 → request-resume 索要简历(需先 greet 建立会话)
 * 3. 简历文件落库:StorageService(MinIO/本地)+ resume_file 元数据(按候选人去重)
 */
@Slf4j
@Service
public class ResumeCollectService {

    private final GreetingRecordMapper greetingMapper;
    private final CandidateMapper candidateMapper;
    private final LiepinAccountMapper accountMapper;
    private final ResumeFileMapper resumeFileMapper;
    private final LiepinCommandService commandService;
    private final StorageService storageService;
    private final JdMapper jdMapper;

    public ResumeCollectService(GreetingRecordMapper greetingMapper, CandidateMapper candidateMapper,
                                LiepinAccountMapper accountMapper, ResumeFileMapper resumeFileMapper,
                                LiepinCommandService commandService, StorageService storageService,
                                JdMapper jdMapper) {
        this.greetingMapper = greetingMapper;
        this.candidateMapper = candidateMapper;
        this.accountMapper = accountMapper;
        this.resumeFileMapper = resumeFileMapper;
        this.commandService = commandService;
        this.storageService = storageService;
        this.jdMapper = jdMapper;
    }

    /** 索要简历防重复窗口:24 小时内不重复请求（2026-09-27 实测:未确认保留原状态导致
     *  对同一候选人 30 分钟内重复索要;CLI 已改为直调 askfor 接口） */
    private static final Duration REQUEST_RETRY_WINDOW = Duration.ofHours(24);

    /** 索要简历累计尝试上限:达到后仅等待对方主动发送附件 */
    private static final int MAX_REQUEST_ATTEMPTS = 2;

    /**
     * 对岗位下已打招呼(SENT/REQUESTED)且未入库简历的候选人:
     * 检测聊天回复 → 有回复则索要简历。
     * 返回处理数。
     */
    @Transactional
    public int collectForJd(Long jdId, int limit) {
        List<GreetingRecord> records = greetingMapper.selectList(new LambdaQueryWrapper<GreetingRecord>()
                .in(GreetingRecord::getStatus, "SENT", "REQUESTED", "AGREED")
                .last("LIMIT " + Math.max(1, Math.min(limit, 100))));
        int processed = 0;
        for (GreetingRecord record : records) {
            Candidate candidate = candidateMapper.selectById(record.getCandidateId());
            if (candidate == null || candidate.getJdId() == null || !candidate.getJdId().equals(jdId)) {
                continue;
            }
            if (resumeFileMapper.selectCount(new LambdaQueryWrapper<ResumeFile>()
                    .eq(ResumeFile::getCandidateId, candidate.getId())) > 0) {
                continue; // 已入库
            }
            try {
                collectOne(record, candidate);
                processed++;
            } catch (Exception e) {
                log.warn("候选人 {} 简历收集失败: {}", candidate.getId(), e.getMessage());
            }
        }
        return processed;
    }

    /** 单个候选人:检测回复 + 索要简历 */
    public void collectOne(GreetingRecord record, Candidate candidate) {
        LiepinAccount account = accountMapper.selectById(record.getAccountId());
        if (account == null) {
            log.warn("候选人 {} 的打招呼账号 {} 不存在", candidate.getId(), record.getAccountId());
            return;
        }
        Duration timeout = Duration.ofMinutes(2);

        // 1. 同意状态检测:查聊天列表匹配该候选人
        boolean replied = checkReply(account, candidate, timeout);

        // 2. 有回复且未索要过 → 索要简历
        if (replied && !"REQUESTED".equals(record.getStatus()) && !"AGREED".equals(record.getStatus())) {
            requestResume(account, candidate, record, timeout);
            log.info("候选人 {} 已回复,索要处理状态: {}", candidate.getId(), record.getStatus());
        } else if (replied) {
            log.info("候选人 {} 已回复(已索要过简历,等待对方同意)", candidate.getId());
        } else {
            log.info("候选人 {} 尚未回复,跳过", candidate.getId());
        }
    }

    /**
     * 直接索要简历(不检测回复;供"对方已读我方消息"触发的索要路径,2026-09-26 新增)。
     * 守卫(fail-closed):打招呼记录必须为 SENT(未索要);评分 PASS;门槛与 resume_id 校验复用私有 requestResume。
     * 返回是否已确认发出(record 状态置 REQUESTED)。
     */
    public boolean requestResumeDirect(LiepinAccount account, Candidate candidate) {
        GreetingRecord record = greetingMapper.selectOne(new LambdaQueryWrapper<GreetingRecord>()
                .eq(GreetingRecord::getCandidateId, candidate.getId())
                .last("LIMIT 1"));
        if (record == null || !"SENT".equals(record.getStatus())) {
            return false;
        }
        if (!"PASS".equals(candidate.getPassStatus())) {
            return false;
        }
        requestResume(account, candidate, record, Duration.ofMinutes(2));
        return "REQUESTED".equals(record.getStatus());
    }

    /** 通过 chatlist 检测候选人是否回复(对方发来消息 direction=0) */
    boolean checkReply(LiepinAccount account, Candidate candidate, Duration timeout) {
        List<JsonNode> chats = commandService.chatlist(account, timeout);
        JsonNode snapshot = JsonExtractor.parse(candidate.getSnapshot()).orElse(null);
        String userId = snapshot == null ? "" : snapshot.path("user_id").asText("");
        String imId = snapshot == null ? "" : snapshot.path("im_id").asText("");
        for (JsonNode chat : chats) {
            String chatUserId = chat.path("user_id").asText("");
            String chatImId = chat.path("im_id").asText("");
            boolean samePerson = (!userId.isBlank() && userId.equals(chatUserId))
                    || (!imId.isBlank() && imId.equals(chatImId));
            if (!samePerson) {
                continue;
            }
            // 实测:direction=1 为候选人发来的消息(如回复),direction=0 为我方/平台发出
            if ("1".equals(chat.path("direction").asText(""))) {
                return true;
            }
        }
        return false;
    }

    /** 索要简历并更新打招呼记录状态 */
    private void requestResume(LiepinAccount account, Candidate candidate,
                               GreetingRecord record, Duration timeout) {
        // 评分偏好门禁(fail-closed,2026-09-29 起替代门槛确认):来源岗位未确认评分偏好 → 绝不外发索要,不改任何状态
        Jd jd = candidate.getJdId() == null ? null : jdMapper.selectById(candidate.getJdId());
        if (jd == null || jd.getScoringPrefConfirmedAt() == null) {
            log.warn("岗位未确认评分偏好,跳过索要简历(候选人 {}, JD {})", candidate.getId(), candidate.getJdId());
            return;
        }
        String resumeId = candidate.getResumeId();
        if (resumeId == null || resumeId.isBlank()) {
            log.warn("候选人 {} 缺少 resume_id,无法索要简历", candidate.getId());
            return;
        }
        // 对方 im_id 从候选人快照取(resume-view 响应不含 im 字段,askfor 接口必需)
        JsonNode snapshot = JsonExtractor.parse(candidate.getSnapshot()).orElse(null);
        String oppositeImId = snapshot == null ? "" : snapshot.path("im_id").asText("");
        // 防重复:24h 窗口 + 次数上限(接口受理即记尝试,不再因未回显而每轮重点)
        int attempts = record.getResumeRequestCount() == null ? 0 : record.getResumeRequestCount();
        if (attempts >= MAX_REQUEST_ATTEMPTS) {
            log.info("候选人 {} 索要简历已尝试 {} 次,停止重试,等待对方主动发送", candidate.getId(), attempts);
            return;
        }
        if (record.getResumeRequestedAt() != null
                && Duration.between(record.getResumeRequestedAt(), LocalDateTime.now())
                        .compareTo(REQUEST_RETRY_WINDOW) < 0) {
            log.info("候选人 {} 24h 内已索要过简历,跳过(等待对方响应)", candidate.getId());
            return;
        }
        Optional<JsonNode> result = commandService.requestResume(account, resumeId, oppositeImId, timeout);
        boolean called = result.filter(node -> node.path("success").asBoolean(false)).isPresent();
        boolean confirmed = result.filter(node -> node.path("success").asBoolean(false)
                && node.path("confirmed").asBoolean(false)).isPresent();
        if (!called) {
            // 接口未被受理(未发出去):不记尝试,下一轮可重试
            String detail = result.map(node -> node.path("message").asText("")).orElse("无输出");
            log.warn("候选人 {} 索要简历未受理,不记尝试: {}", candidate.getId(), detail);
            return;
        }
        // 接口已受理(无论会话侧是否回显)都记录本次尝试:24h 内不再重复请求
        record.setResumeRequestedAt(LocalDateTime.now());
        record.setResumeRequestCount(attempts + 1);
        if (confirmed) {
            record.setStatus("REQUESTED");
        }
        greetingMapper.updateById(record);
        if (confirmed) {
            log.info("索要简历已确认(account={}, candidate={})", account.getId(), candidate.getId());
        } else {
            log.info("候选人 {} 索要简历已发出(接口受理,未回显确认),已记录尝试(第 {} 次)",
                    candidate.getId(), attempts + 1);
        }
    }

    /**
     * 简历文件落库(适配点:文件字节来源待实测确认,可能是聊天下载/邮件附件):
     * 上传 StorageService + 写 resume_file 元数据,按候选人去重。
     */
    @Transactional
    public ResumeFile saveResumeFile(Long candidateId, String fileName, byte[] content, String contentType) {
        Candidate candidate = candidateMapper.selectById(candidateId);
        if (candidate == null) {
            throw new IllegalArgumentException("候选人不存在: " + candidateId);
        }
        ResumeFile existing = resumeFileMapper.selectOne(new LambdaQueryWrapper<ResumeFile>()
                .eq(ResumeFile::getCandidateId, candidateId)
                .last("LIMIT 1"));
        String objectKey = buildObjectKey(candidateId, fileName);
        storageService.save(objectKey, content, contentType);
        String sha256 = sha256(content);

        if (existing != null) {
            existing.setBucket(objectKey);
            existing.setObjectKey(objectKey);
            existing.setFormat(extractFormat(fileName));
            existing.setSize((long) content.length);
            existing.setSha256(sha256);
            resumeFileMapper.updateById(existing);
            return existing;
        }
        ResumeFile file = new ResumeFile();
        file.setCandidateId(candidateId);
        file.setBucket(objectKey);
        file.setObjectKey(objectKey);
        file.setFormat(extractFormat(fileName));
        file.setSize((long) content.length);
        file.setSha256(sha256);
        resumeFileMapper.insert(file);
        return file;
    }

    private String buildObjectKey(Long candidateId, String fileName) {
        String date = LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyyMMdd"));
        return "resumes/" + date + "/" + candidateId + "-" + safeName(fileName);
    }

    private String safeName(String fileName) {
        String name = fileName == null || fileName.isBlank() ? "resume.pdf" : fileName;
        return name.replaceAll("[^\\w\\u4e00-\\u9fa5.-]", "_");
    }

    private String extractFormat(String fileName) {
        int dot = fileName == null ? -1 : fileName.lastIndexOf('.');
        return dot >= 0 ? fileName.substring(dot + 1).toLowerCase() : "";
    }

    private String sha256(byte[] content) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            return HexFormat.of().formatHex(digest.digest(content));
        } catch (Exception e) {
            return "";
        }
    }
}
