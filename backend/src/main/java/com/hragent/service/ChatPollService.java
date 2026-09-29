package com.hragent.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.hragent.config.HrAgentProperties;
import com.hragent.entity.Candidate;
import com.hragent.entity.GreetingRecord;
import com.hragent.entity.Jd;
import com.hragent.entity.LiepinAccount;
import com.hragent.entity.ResumeFile;
import com.hragent.executor.CliException;
import com.hragent.executor.JsonExtractor;
import com.hragent.repository.CandidateMapper;
import com.hragent.repository.GreetingRecordMapper;
import com.hragent.repository.JdMapper;
import com.hragent.repository.LiepinAccountMapper;
import com.hragent.repository.ResumeFileMapper;
import com.hragent.scoring.ScoringEngine;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.Duration;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * 来信轮询与附件收集入口(被动通道,设计 §3.2)。
 *
 * <p>每轮由 {@code AutoRecruitScheduler} 在来信阶段调用一次;本轮内单账号串行,对每个会话:
 * <ol>
 *     <li>chatlist 拉会话(每会话带 {@code im_id}/{@code direction}/{@code name});仅处理
 *         {@code direction=1}(候选人最后发言)的会话——无新来信则既无附件也无回复。</li>
 *     <li><b>已知候选人</b>(候选人在 snapshot 中带有该 im_id):
 *         <ul>
 *             <li>对方最后发言且 {@code resume_file} 无记录 → CLI {@code attach-fetch}(纯接口:消息 ext
 *                 {@code bizType=7} 检出附件卡 → attachmentSign 换下载地址 → 浏览器下载通道)下载到工作目录 →
 *                 {@code saveResumeFile} 入库(<b>不看分数/门槛</b>);消息级防抖
 *                 ({@code greeting_record.attach_probe_msg_id}):无附件记标记跳过、失败不记标记下轮重试。
 *                 (2026-09-26 检测信号重构:旧“payload.bodies 扫描”实测恒空,导致附件从未入库)</li>
 *             <li>仅文本回复 → 门槛已确认 + 评分 PASS + 未 REQUESTED → 复用既有索要路径。</li>
 *         </ul></li>
 *     <li><b>陌生来话</b>(im_id 未匹配任何候选人):chatmsg 提取在线简历卡片的 {@code enresId};
 *         成功 → 建候选人(能由消息 job 字段映射到岗位则关联,否则 jd_id 为空=待分配)并走评分门禁;
 *         提取失败 → 只记日志,<b>不建、不猜、不评分</b>。</li>
 * </ol>
 *
 * <p>容错:单会话失败不中断其余会话;风控({@link CliException.Type#RISK_CONTROL})与登录失效
 * ({@link CliException.Type#NOT_LOGGED_IN})立即中断本轮并上抛,交由既有熔断链路处理。
 * 外发动作(附件下载、索要简历)与打招呼统一由 {@link AccountPaceGuard} 按账号维度节流(评审 I-2)。
 *
 * <p>外发门禁(2026-09-26 运行时开关):开关关闭(只停主动外发)时,索要路径
 * (回复触发/已读触发/陌生评分后)全部跳过并「攒着」——候选状态不改,检测/附件下载不受影响;
 * 开关恢复后下一轮自动补做。手动路径(ADMIN 手动触发的 /api/recruit/*)不经过本服务,不受开关限制。
 */
@Slf4j
@Service
public class ChatPollService {

    /** 附件临时下载目录(CLI 要求绝对路径;相对路径按 JVM 工作目录解析) */
    private static final String ATTACH_WORK_DIR = "runtime/attach-poll";
    /** 在线简历卡的简历标识字段 */
    private static final String RESUME_ID_FIELD = "enresId";
    /** 消息中关联岗位的候选字段(按序取首个非空) */
    private static final List<String> JOB_ID_FIELDS = List.of("ejobId", "jobId", "ejob_id");
    /** chatmsg 发送方标识:对方发来(我方=「我」;无法判定=「未知」,不猜) */
    private static final String SENDER_OTHER = "对方";
    /** 陌生来话占位 resume_id 前缀(明确占位,不冒充真实简历 ID) */
    private static final String PLACEHOLDER_RESUME_ID_PREFIX = "im:";

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private final LiepinCommandService commandService;
    private final ResumeCollectService resumeCollectService;
    private final ScoringEngine scoringEngine;
    private final CandidateMapper candidateMapper;
    private final GreetingRecordMapper greetingMapper;
    private final ResumeFileMapper resumeFileMapper;
    private final JdMapper jdMapper;
    private final LiepinAccountMapper accountMapper;
    private final HrAgentProperties properties;
    private final AccountPaceGuard paceGuard;
    private final AutoRecruitSettingService settingService;

    public ChatPollService(LiepinCommandService commandService, ResumeCollectService resumeCollectService,
                           ScoringEngine scoringEngine, CandidateMapper candidateMapper,
                           GreetingRecordMapper greetingMapper, ResumeFileMapper resumeFileMapper,
                           JdMapper jdMapper, LiepinAccountMapper accountMapper,
                           HrAgentProperties properties, AccountPaceGuard paceGuard,
                           AutoRecruitSettingService settingService) {
        this.commandService = commandService;
        this.resumeCollectService = resumeCollectService;
        this.scoringEngine = scoringEngine;
        this.candidateMapper = candidateMapper;
        this.greetingMapper = greetingMapper;
        this.resumeFileMapper = resumeFileMapper;
        this.jdMapper = jdMapper;
        this.accountMapper = accountMapper;
        this.properties = properties;
        this.paceGuard = paceGuard;
        this.settingService = settingService;
    }

    /**
     * 轮询来信与附件(每轮总入口,内部单账号串行);返回本轮产生动作(附件入库/索要/建候选人)的会话数。
     */
    public int poll() {
        LiepinAccount account = accountMapper.selectOne(new LambdaQueryWrapper<LiepinAccount>()
                .eq(LiepinAccount::getLoginStatus, "NORMAL")
                .orderByAsc(LiepinAccount::getId)
                .last("LIMIT 1"));
        if (account == null) {
            log.warn("来信轮询:无可用猎聘账号(login_status=NORMAL),本轮跳过");
            return 0;
        }
        int processed = pollOnce(account);
        log.info("来信轮询完成:账号 {},处理 {} 个会话", account.getId(), processed);
        return processed;
    }

    /**
     * 对指定账号执行一次来信轮询;返回本轮产生动作(附件入库/索要/建候选人)的会话数。
     */
    public int pollOnce(LiepinAccount account) {
        Duration timeout = Duration.ofMinutes(properties.getLiepin().getShortTimeoutMinutes());
        asksThisPoll = 0; // 轮内索要预算重置(2026-09-28 熔断治理)
        List<JsonNode> sessions = fetchSessionsWithRetry(account, timeout);
        if (sessions == null) {
            return 0;
        }
        int processed = 0;
        for (JsonNode session : sessions) {
            try {
                if (handleSession(account, session, timeout)) {
                    processed++;
                }
            } catch (CliException e) {
                if (e.getType() == CliException.Type.RISK_CONTROL
                        || e.getType() == CliException.Type.NOT_LOGGED_IN) {
                    log.error("来信轮询遇账号级异常,立即停止本轮: {}", e.getMessage());
                    throw e;
                }
                log.warn("会话处理失败,跳过: {}", e.getMessage());
            } catch (Exception e) {
                // 单会话失败不中断其余会话
                log.warn("会话处理异常,跳过: {}", e.getMessage(), e);
            }
        }
        return processed;
    }

    // ---------- 节拍循环入口(2026-09-28 平摊改造:轮次按节拍逐会话/逐刷新消费) ----------

    /** 轮开始标记:重置轮内索要预算(节拍循环每轮调用一次;不重置则预算跨轮累计) */
    public void beginRound() {
        asksThisPoll = 0;
    }

    /**
     * 拉取会话列表(节拍循环按 {@code poll-list-interval-minutes} 周期刷新)。
     * 非账号级失败已内含一次重试;仍失败返回 null,调用方跳过本次刷新(不断轮)。
     */
    public List<JsonNode> fetchSessions(LiepinAccount account) {
        return fetchSessionsWithRetry(account, shortTimeout());
    }

    /**
     * 处理单个会话(节拍循环一 tick 一个);返回是否产生落库/外发动作。
     * 风控/登录失效上抛(由轮次的"冻结-复测"策略处理);其余失败仅记日志并返回 false。
     */
    public boolean handleSession(LiepinAccount account, JsonNode session) {
        try {
            return handleSession(account, session, shortTimeout());
        } catch (CliException e) {
            if (e.getType() == CliException.Type.RISK_CONTROL
                    || e.getType() == CliException.Type.NOT_LOGGED_IN) {
                throw e;
            }
            log.warn("会话处理失败,跳过: {}", e.getMessage());
            return false;
        } catch (Exception e) {
            log.warn("会话处理异常,跳过: {}", e.getMessage(), e);
            return false;
        }
    }

    private Duration shortTimeout() {
        return Duration.ofMinutes(properties.getLiepin().getShortTimeoutMinutes());
    }

    /**
     * 轮内自动索要预算(2026-09-28 熔断治理):每轮最多 {@code askBatchLimit} 次自动索要,
     * 用尽则攒着下轮继续——与 60s 账号级外发间隔共同压低平台可见密度。
     */
    private int asksThisPoll;

    /**
     * 消耗一次轮内索要预算;星级≥4 豁免(2026-09-29 专道福利:不占预算、即时发送);
     * 预算用尽返回 false(调用方跳过并攒着)。
     */
    private boolean tryConsumeAskBudget(Candidate candidate) {
        if (candidate != null && candidate.getStar() != null && candidate.getStar() >= 4) {
            return true;
        }
        int limit = Math.max(0, properties.getAutoRecruit().getAskBatchLimit());
        if (asksThisPoll >= limit) {
            log.info("本轮自动索要已达上限 {}(熔断治理),暂停索要攒着,下轮继续", limit);
            return false;
        }
        asksThisPoll++;
        return true;
    }

    /**
     * 拉取会话列表:非风控/登录类失败时等待片刻重试一次;仍失败返回 null(本轮跳过来信处理,不阻断后续岗位)。
     * 2026-09-26 实测:chatlist 曾因页面级挂起连续两轮超时,回复/已读因此完全未被处理;轮内重试提升及时性。
     */
    private List<JsonNode> fetchSessionsWithRetry(LiepinAccount account, Duration timeout) {
        try {
            return commandService.chatlist(account, timeout);
        } catch (CliException first) {
            // 风控/登录失效 → 中断本轮上抛,由既有熔断链路处理
            if (first.getType() == CliException.Type.RISK_CONTROL
                    || first.getType() == CliException.Type.NOT_LOGGED_IN) {
                throw first;
            }
            long delayMillis = Math.max(0, properties.getAutoRecruit().getPollRetryDelayMillis());
            log.warn("来信会话列表拉取失败,{}ms 后重试一次: {}", delayMillis, first.getMessage());
            sleepQuietly(delayMillis);
            try {
                return commandService.chatlist(account, timeout);
            } catch (CliException retry) {
                if (retry.getType() == CliException.Type.RISK_CONTROL
                        || retry.getType() == CliException.Type.NOT_LOGGED_IN) {
                    throw retry;
                }
                log.warn("来信会话列表重试仍失败,本轮跳过来信处理: {}", retry.getMessage());
                return null;
            }
        }
    }

    private static void sleepQuietly(long millis) {
        if (millis <= 0) {
            return;
        }
        try {
            Thread.sleep(millis);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    /** 处理单个会话;返回是否已产生落库/外发动作 */
    private boolean handleSession(LiepinAccount account, JsonNode session, Duration timeout) {
        String imId = session.path("im_id").asText("").trim();
        String name = session.path("name").asText("").trim();
        if (imId.isEmpty() && name.isEmpty()) {
            log.warn("会话缺少 im_id 与 name,跳过(不猜测)");
            return false;
        }
        String direction = session.path("direction").asText("");
        // 已知候选人匹配:优先 im_id → user_id → name(UI 通道无 im_id 时的会话名键回退)
        Candidate candidate = imId.isEmpty() ? null : findCandidateByImId(imId);
        if (candidate == null) {
            String userId = session.path("user_id").asText("").trim();
            if (!userId.isEmpty()) {
                candidate = findCandidateByUserId(userId);
            }
        }
        if (candidate == null && !name.isEmpty()) {
            candidate = findCandidateByName(name);
        }
        if (candidate != null) {
            return handleKnownCandidate(account, candidate, imId, direction, session, timeout);
        }
        return handleStranger(account, session, imId, direction, timeout);
    }

    /**
     * 会话名键匹配(UI 通道适配:chatlist 的 records 无对方 im_id,以会话名定位候选人)。
     * 同名多命中时跳过并记日志(保守,不猜测)。
     */
    private Candidate findCandidateByName(String name) {
        List<Candidate> list = candidateMapper.selectList(new LambdaQueryWrapper<Candidate>()
                .eq(Candidate::getName, name)
                .last("LIMIT 2"));
        if (list.isEmpty()) {
            return null;
        }
        if (list.size() > 1) {
            log.warn("会话名「{}」匹配到多个候选人,跳过(不猜测)", name);
            return null;
        }
        return list.get(0);
    }

    /**
     * 已知候选人:先经 attach-fetch 探测/获取附件卡片(附件优先入库,不看分数);
     * 无附件则按回复索要;对方未回复但已读我方最新消息(会话级 oppositeRead=1)同样索要(不等回复)。
     *
     * <p>2026-09-26 检测信号重构:附件卡片不是消息体的附件块,而是挂在候选人消息的
     * {@code payload.ext.extBody.bizData}(bizType=7)上,旧的消息体扫描恒空、附件从未入库;
     * 现由 CLI attach-fetch 纯接口检出(零已读副作用),需消息级防抖避免重复探测。</p>
     */
    private boolean handleKnownCandidate(LiepinAccount account, Candidate candidate, String imId,
                                         String direction, JsonNode session, Duration timeout) {
        // 去重键:resume_file 是否已有该候选人记录(服务端每次下载会重新生成 PDF,SHA-256 会变)
        if (hasResumeFile(candidate.getId())) {
            return false;
        }
        if ("1".equals(direction)) {
            // 候选人最后发言:先经 attach-fetch 探测/获取附件(API 路线)
            if (fetchAttachmentIfNew(account, candidate, imId, session, timeout)) {
                return true;
            }
            // 无附件/已探测过/获取失败 → 走既有"回复索要"逻辑
            return requestResumeForKnown(account, candidate, timeout);
        }
        // 对方沉默:仅当"对方已读我方最新消息"时索要,不做其他动作(不拉消息,零额外平台请求)
        if (isOppositeRead(session)) {
            return requestResumeOnRead(account, candidate);
        }
        return false;
    }

    /**
     * 附件探测/获取(防抖:同一会话最新消息 ID 只探测一次,标记写入 greeting_record.attach_probe_msg_id)。
     * 成功入库返回 true;无附件(记标记)/已探测/失败(不记标记,下轮重试)返回 false。
     * 附件入库不受门槛/评分限制;运行时开关 OFF 也照常收集(只停主动外发)。
     */
    private boolean fetchAttachmentIfNew(LiepinAccount account, Candidate candidate, String imId,
                                         JsonNode session, Duration timeout) {
        if (imId.isEmpty()) {
            // UI 通道适配:无 im_id 时附件探测(attach-fetch UI 化)尚未就绪,跳过并留痕
            log.info("UI 通道无 im_id,附件探测暂不可用,跳过(候选人 {})", candidate.getId());
            return false;
        }
        GreetingRecord record = greetingMapper.selectOne(new LambdaQueryWrapper<GreetingRecord>()
                .eq(GreetingRecord::getCandidateId, candidate.getId())
                .last("LIMIT 1"));
        String latestMsgId = session.path("raw_metadata").path("latestMsgId").asText("").trim();
        if (record == null || latestMsgId.isEmpty() || latestMsgId.equals(record.getAttachProbeMsgId())) {
            return false;
        }
        Optional<JsonNode> result = commandService.attachFetch(account, imId, attachWorkDir(), timeout);
        JsonNode node = result.orElse(null);
        if (node == null) {
            log.warn("附件获取无输出,下轮重试(候选人 {})", candidate.getId());
            return false;
        }
        if (node.path("success").asBoolean(false)) {
            return storeFetchedAttachment(record, candidate, node, latestMsgId);
        }
        if ("no-attachment".equals(node.path("reason").asText(""))) {
            markAttachProbe(record, latestMsgId);
            log.debug("候选人 {} 无附件卡片(已探测 {}),不再重复", candidate.getId(), latestMsgId);
            return false;
        }
        log.warn("附件获取失败,下轮重试(候选人 {}): {} {}", candidate.getId(),
                node.path("reason").asText(""), node.path("detail").asText(""));
        return false;
    }

    /** 读取 attach-fetch 落盘文件 → 校验 → 入库(文件名来自接口);成功后写探测标记并清理临时文件 */
    private boolean storeFetchedAttachment(GreetingRecord record, Candidate candidate,
                                           JsonNode node, String latestMsgId) {
        String filePath = node.path("file").asText("").trim();
        String fileName = node.path("fileName").asText("").trim();
        if (fileName.isEmpty()) {
            fileName = "resume.pdf";
        }
        byte[] content;
        try {
            content = Files.readAllBytes(Paths.get(filePath));
        } catch (IOException | RuntimeException e) {
            log.warn("附件读取失败,下轮重试(候选人 {}): {}", candidate.getId(), e.getMessage());
            return false;
        }
        if (content.length == 0) {
            log.warn("附件内容为空,拒绝入库(候选人 {}),下轮重试", candidate.getId());
            return false;
        }
        try {
            resumeCollectService.saveResumeFile(candidate.getId(), fileName, content, "application/pdf");
        } catch (Exception e) {
            log.warn("附件入库失败,下轮重试(候选人 {}): {}", candidate.getId(), e.getMessage());
            return false;
        }
        deleteQuietly(filePath);
        markAttachProbe(record, latestMsgId);
        log.info("候选人 {} 附件已获取入库({} 字节, 文件名={}, sha256={})",
                candidate.getId(), content.length, fileName, node.path("sha256").asText(""));
        return true;
    }

    /** 写附件探测标记(同一消息 ID 不再重复探测;新消息到来会自然触发重探) */
    private void markAttachProbe(GreetingRecord record, String latestMsgId) {
        record.setAttachProbeMsgId(latestMsgId);
        greetingMapper.updateById(record);
    }

    /** 已读即索要:记录/评分/门槛前置检查 → 账号节流 → 直接索要(不检测回复,复用既有守卫) */
    private boolean requestResumeOnRead(LiepinAccount account, Candidate candidate) {
        if (!settingService.isEnabled()) {
            log.info("自动外发已暂停(开关关闭),跳过已读索要(攒着后补),候选人 {}", candidate.getId());
            return false;
        }
        if (!tryConsumeAskBudget(candidate)) {
            return false;
        }
        GreetingRecord record = greetingMapper.selectOne(new LambdaQueryWrapper<GreetingRecord>()
                .eq(GreetingRecord::getCandidateId, candidate.getId())
                .last("LIMIT 1"));
        if (record == null || !"SENT".equals(record.getStatus())) {
            // 无记录/已索要(REQUESTED/AGREED)/待确认/发送失败:均不触发
            return false;
        }
        if (!"PASS".equals(candidate.getPassStatus())) {
            log.debug("候选人 {} 非 PASS({}),已读也不索要", candidate.getId(), candidate.getPassStatus());
            return false;
        }
        if (!thresholdConfirmed(candidate)) {
            log.warn("岗位未确认门槛,跳过已读索要(候选人 {})", candidate.getId());
            return false;
        }
        paceGuard.await(account);
        boolean requested = resumeCollectService.requestResumeDirect(account, candidate);
        if (requested) {
            paceGuard.mark(account);
            log.info("候选人 {} 已读我方消息,已触发索要简历", candidate.getId());
        }
        return requested;
    }

    /**
     * 会话级已读标记:oppositeRead=1 表示"对方已读我方最新消息"(2026-09-26 以真实会话样本对照界面验证)。
     * 字段缺失/null/其他值一律视为未知,不触发(不猜)。
     */
    private static boolean isOppositeRead(JsonNode session) {
        JsonNode value = session.path("raw_metadata").path("oppositeRead");
        if (value.isMissingNode() || value.isNull()) {
            return false;
        }
        String text = value.asText("");
        return "1".equals(text) || "true".equalsIgnoreCase(text);
    }

    /** 附件下载 → 校验 → 入库;任一步失败都只记日志、不写半状态(下轮重试) */
    private boolean downloadAndStore(LiepinAccount account, Candidate candidate, String imId,
                                     JsonNode attachment, Duration timeout) {
        if (hasResumeFile(candidate.getId())) {
            return false;
        }
        String fileName = attachment.path("filename").asText("").trim();
        if (fileName.isEmpty()) {
            fileName = "resume.pdf";
        }
        paceGuard.await(account);
        Optional<JsonNode> result = commandService.attachDownload(account, imId, attachWorkDir(), timeout);
        JsonNode node = result.orElse(null);
        if (node == null || !node.path("success").asBoolean(false)) {
            log.warn("附件下载未成功,留待下轮重试(候选人 {});不写半状态", candidate.getId());
            return false;
        }
        String filePath = node.path("file").asText("").trim();
        byte[] content;
        try {
            content = Files.readAllBytes(Paths.get(filePath));
        } catch (IOException | RuntimeException e) {
            log.warn("附件读取失败,留待下轮重试(候选人 {}): {}", candidate.getId(), e.getMessage());
            return false;
        }
        if (content.length == 0) {
            log.warn("附件内容为空,拒绝入库(候选人 {}),留待下轮重试", candidate.getId());
            return false;
        }
        try {
            resumeCollectService.saveResumeFile(candidate.getId(), fileName, content, "application/pdf");
        } catch (Exception e) {
            log.warn("附件入库失败,留待下轮重试(候选人 {}): {}", candidate.getId(), e.getMessage());
            return false;
        }
        deleteQuietly(filePath);
        paceGuard.mark(account);
        log.info("候选人 {} 附件已校验入库({} 字节, sha256={})",
                candidate.getId(), content.length, node.path("sha256").asText(""));
        return true;
    }

    /** 已知候选人仅文本回复:门槛已确认 + 评分 PASS + 未 REQUESTED → 复用既有索要路径 */
    private boolean requestResumeForKnown(LiepinAccount account, Candidate candidate, Duration timeout) {
        if (!settingService.isEnabled()) {
            log.info("自动外发已暂停(开关关闭),跳过回复索要(攒着后补),候选人 {}", candidate.getId());
            return false;
        }
        if (!tryConsumeAskBudget(candidate)) {
            return false;
        }
        if (!"PASS".equals(candidate.getPassStatus())) {
            log.debug("候选人 {} 非 PASS({}),不索要", candidate.getId(), candidate.getPassStatus());
            return false;
        }
        GreetingRecord record = greetingMapper.selectOne(new LambdaQueryWrapper<GreetingRecord>()
                .eq(GreetingRecord::getCandidateId, candidate.getId())
                .last("LIMIT 1"));
        if (record == null) {
            log.warn("候选人 {} 无打招呼记录,跳过索要", candidate.getId());
            return false;
        }
        if ("REQUESTED".equals(record.getStatus()) || "AGREED".equals(record.getStatus())) {
            return false;
        }
        // 门槛门禁(fail-closed):来源岗位未确认门槛 → 绝不外发(与既有索要路径一致)
        if (!thresholdConfirmed(candidate)) {
            log.warn("岗位未确认门槛,跳过索要简历(候选人 {})", candidate.getId());
            return false;
        }
        paceGuard.await(account);
        // 复用既有索要路径:内含门槛门禁 + resume_id 校验 + 回复复核 + 状态回写
        resumeCollectService.collectOne(record, candidate);
        boolean requested = "REQUESTED".equals(record.getStatus());
        if (requested) {
            paceGuard.mark(account);
        }
        return requested;
    }

    /**
     * 陌生来话:提取在线简历标识;成功建候选人(可关联岗位则走评分门禁);
     * 提取失败但检测到对方附件卡片 → 以占位载体入库并标记待分配(评审 I-3);两者皆无 → 只记日志。
     */
    private boolean handleStranger(LiepinAccount account, JsonNode session, String imId,
                                   String direction, Duration timeout) {
        if (!"1".equals(direction)) {
            return false;
        }
        if (imId.isEmpty()) {
            // UI 通道适配:陌生人链路依赖 chatmsg 结构化消息(附件卡片/身份标识),UI 消息解析未就绪时跳过
            log.warn("UI 通道无 im_id,陌生人会话消息解析未就绪,跳过(会话 {})",
                    session.path("name").asText(""));
            return false;
        }
        List<JsonNode> messages = commandService.chatmsg(account, imId, timeout);
        JsonNode card = findLatestResumeCard(messages);
        String resumeId = card == null ? null : findText(card, RESUME_ID_FIELD);
        if (resumeId == null || resumeId.isBlank()) {
            // 无身份标识:若对方发来附件卡片则以占位载体入库待分配,否则不建/不猜
            return storeStrangerAttachment(account, session, imId, messages, timeout);
        }
        String sessionName = session.path("name").asText("").trim();
        Long jdId = resolveJdId(card);
        Candidate candidate = new Candidate();
        candidate.setResumeId(resumeId);
        candidate.setName(sessionName.isEmpty() ? resumeId : sessionName);
        candidate.setSnapshot(buildStrangerSnapshot(imId, sessionName, card));
        candidate.setJdId(jdId);
        candidate.setPassStatus("PENDING");
        candidateMapper.insert(candidate);
        log.info("陌生来话 {} 已建候选人(id={}, resume_id={}, jd_id={})",
                imId, candidate.getId(), resumeId, jdId);
        if (jdId == null) {
            log.info("陌生来话 {} 无关联岗位,标记待分配(待人工分配)", imId);
            return true;
        }
        // 有关联岗位 → 走评分门禁(期望职能三态 + 门槛);无快照期望证据时恒 UNKNOWN→PENDING,绝不外发
        scoringEngine.scoreAndSave(candidate.getId());
        maybeRequestAfterStrangerScore(account, candidate.getId(), timeout);
        return true;
    }

    /**
     * 陌生来话无法提取身份标识时的兜底(评审 I-3):若对方发来附件卡片,则以占位载体入库并标记待分配。
     * 占位 {@code resume_id} 为 {@code im:<imId>}(明确占位前缀,不冒充真实简历 ID);仅入库附件,
     * 不评分、不索要;同一 im 已有候选人(预查 resume_id)则复用其 id,不重复建(规避 uk_resume 冲突)。
     */
    private boolean storeStrangerAttachment(LiepinAccount account, JsonNode session, String imId,
                                            List<JsonNode> messages, Duration timeout) {
        JsonNode attachment = findLatestAttachment(messages);
        if (attachment == null) {
            log.warn("陌生来话({})未能从消息提取简历标识且无对方附件卡片,不建/不猜,留待人工分配", imId);
            return false;
        }
        String placeholderResumeId = PLACEHOLDER_RESUME_ID_PREFIX + imId;
        Candidate candidate = findCandidateByResumeId(placeholderResumeId);
        if (candidate == null) {
            candidate = createPlaceholderCandidate(session, imId, placeholderResumeId);
        }
        if (hasResumeFile(candidate.getId())) {
            return false;
        }
        return downloadAndStore(account, candidate, imId, attachment, timeout);
    }

    /** 建陌生来话占位候选人:名称取 chatlist 显示名,取不到则「待分配-<imId前8位>」;jd_id=null、PENDING */
    private Candidate createPlaceholderCandidate(JsonNode session, String imId, String placeholderResumeId) {
        String sessionName = session.path("name").asText("").trim();
        String name = sessionName.isEmpty() ? "待分配-" + imIdPrefix(imId) : sessionName;
        Candidate candidate = new Candidate();
        candidate.setResumeId(placeholderResumeId);
        candidate.setName(name);
        candidate.setSnapshot(buildStrangerSnapshot(imId, sessionName, null));
        candidate.setJdId(null);
        candidate.setPassStatus("PENDING");
        candidateMapper.insert(candidate);
        log.info("陌生来话 {} 无身份标识但有附件,已建占位候选人(id={}, resume_id={}),标记待分配,不评分不索要",
                imId, candidate.getId(), placeholderResumeId);
        return candidate;
    }

    /** 陌生来话评分后:仅 PASS 且门槛已确认才索要(否则保持待处理);运行时开关关闭时跳过攒着 */
    private void maybeRequestAfterStrangerScore(LiepinAccount account, Long candidateId, Duration timeout) {
        if (!settingService.isEnabled()) {
            log.info("自动外发已暂停(开关关闭),跳过陌生来话索要(攒着后补),候选人 {}", candidateId);
            return;
        }
        // 星级≥4 豁免轮内预算,需先取候选人(2026-09-29)
        Candidate fresh = candidateMapper.selectById(candidateId);
        if (!tryConsumeAskBudget(fresh)) {
            return;
        }
        if (fresh == null || !"PASS".equals(fresh.getPassStatus())) {
            return;
        }
        if (!thresholdConfirmed(fresh)) {
            log.warn("陌生来话候选人 {} 岗位未确认门槛,不索要", candidateId);
            return;
        }
        String resumeId = fresh.getResumeId();
        if (resumeId == null || resumeId.isBlank()) {
            return;
        }
        // 对方 im_id 从候选人快照取(resume-view 响应不含 im 字段,askfor 接口必需)
        JsonNode snapshot = JsonExtractor.parse(fresh.getSnapshot()).orElse(null);
        String oppositeImId = snapshot == null ? "" : snapshot.path("im_id").asText("");
        paceGuard.await(account);
        Optional<JsonNode> result = commandService.requestResume(account, resumeId, oppositeImId, timeout);
        boolean confirmed = result.filter(node -> node.path("success").asBoolean(false)
                && node.path("confirmed").asBoolean(false)).isPresent();
        if (confirmed) {
            paceGuard.mark(account);
            log.info("陌生来话候选人 {} 评分通过,已索要简历", candidateId);
        } else {
            log.warn("陌生来话候选人 {} 索要未获确认", candidateId);
        }
    }

    /** 以 snapshot 中的 im_id 匹配已知候选人(先 LIKE 命中再精确比对,避免前缀误匹配) */
    private Candidate findCandidateByImId(String imId) {
        String needle = "\"im_id\":\"" + imId + "\"";
        List<Candidate> matches = candidateMapper.selectList(new LambdaQueryWrapper<Candidate>()
                .like(Candidate::getSnapshot, needle));
        for (Candidate candidate : matches) {
            JsonNode snapshot = JsonExtractor.parse(candidate.getSnapshot()).orElse(null);
            if (snapshot != null && imId.equals(snapshot.path("im_id").asText(""))) {
                return candidate;
            }
        }
        return null;
    }

    /**
     * 以 snapshot 中的 user_id(推荐输出 enusercId)匹配已知候选人(终审 I2 回退路径)。
     * im_id 缺失/不一致时兜底,降低已招呼候选人回复落入陌生来话造成断链的风险;
     * 仍匹配不到则交回陌生来话路径(fail-safe 不变)。
     */
    private Candidate findCandidateByUserId(String userId) {
        String needle = "\"user_id\":\"" + userId + "\"";
        List<Candidate> matches = candidateMapper.selectList(new LambdaQueryWrapper<Candidate>()
                .like(Candidate::getSnapshot, needle));
        for (Candidate candidate : matches) {
            JsonNode snapshot = JsonExtractor.parse(candidate.getSnapshot()).orElse(null);
            if (snapshot != null && userId.equals(snapshot.path("user_id").asText(""))) {
                return candidate;
            }
        }
        return null;
    }

    /** 以 resume_id 精确匹配候选人(陌生来话占位载体预查,规避 uk_resume 冲突) */
    private Candidate findCandidateByResumeId(String resumeId) {
        return candidateMapper.selectOne(new LambdaQueryWrapper<Candidate>()
                .eq(Candidate::getResumeId, resumeId)
                .last("LIMIT 1"));
    }

    private boolean hasResumeFile(Long candidateId) {
        Long count = resumeFileMapper.selectCount(new LambdaQueryWrapper<ResumeFile>()
                .eq(ResumeFile::getCandidateId, candidateId));
        return count != null && count > 0;
    }

    private boolean thresholdConfirmed(Candidate candidate) {
        if (candidate.getJdId() == null) {
            return false;
        }
        Jd jd = jdMapper.selectById(candidate.getJdId());
        // 2026-09-29 起外发门禁=评分偏好确认(替代旧门槛确认)
        return jd != null && jd.getScoringPrefConfirmedAt() != null;
    }

    /** 由消息中的 job 字段映射到系统岗位;无匹配返回 null(待分配) */
    private Long resolveJdId(JsonNode card) {
        if (card == null) {
            return null;
        }
        for (String field : JOB_ID_FIELDS) {
            String jobId = findText(card, field);
            if (jobId == null || jobId.isBlank()) {
                continue;
            }
            List<Jd> matched = jdMapper.selectList(new LambdaQueryWrapper<Jd>()
                    .eq(Jd::getLiepinJobId, jobId)
                    .orderByAsc(Jd::getId));
            if (!matched.isEmpty()) {
                return matched.get(0).getId();
            }
        }
        return null;
    }

    /**
     * 最新一条「对方」发出且含附件卡片的消息 body(type=file 或含 fileId)。
     * 仅扫描 sender=对方 的消息(评审 I-1):我方发出的附件不算候选人简历;
     * sender 为空/「未知」同样不得作为附件来源(不猜)。
     *
     * <p>注(2026-09-26):真实附件卡片在消息 {@code ext.bizData}(bizType=7)上,
     * 已知候选人路径已改由 CLI attach-fetch 检出;本方法仅保留给陌生来话兜底路径。</p>
     */
    private static JsonNode findLatestAttachment(List<JsonNode> messages) {
        for (int i = messages.size() - 1; i >= 0; i--) {
            JsonNode message = messages.get(i);
            if (!SENDER_OTHER.equals(message.path("sender").asText(""))) {
                continue;
            }
            JsonNode bodies = message.path("payload").path("bodies");
            if (!bodies.isArray()) {
                continue;
            }
            for (JsonNode body : bodies) {
                if (isAttachmentBody(body)) {
                    return body;
                }
            }
        }
        return null;
    }

    private static boolean isAttachmentBody(JsonNode body) {
        if (body == null || !body.isObject()) {
            return false;
        }
        if ("file".equalsIgnoreCase(body.path("type").asText(""))) {
            return true;
        }
        return body.hasNonNull("fileId") || body.hasNonNull("fileid") || body.hasNonNull("file_id");
    }

    /** 最新一条含「在线简历」标识(enresId)的消息载荷 */
    private static JsonNode findLatestResumeCard(List<JsonNode> messages) {
        for (int i = messages.size() - 1; i >= 0; i--) {
            JsonNode payload = messages.get(i).path("payload");
            if (payload.isObject() && findText(payload, RESUME_ID_FIELD) != null) {
                return payload;
            }
        }
        return null;
    }

    /** 深度优先查找首个非空字段值(兼容字符串/数字),找不到返回 null */
    private static String findText(JsonNode node, String field) {
        if (node == null || node.isNull()) {
            return null;
        }
        if (node.isObject()) {
            JsonNode value = node.get(field);
            if (value != null) {
                if (value.isTextual() && !value.asText().isBlank()) {
                    return value.asText().trim();
                }
                if (value.isNumber()) {
                    return value.asText();
                }
            }
            Iterator<Map.Entry<String, JsonNode>> fields = node.fields();
            while (fields.hasNext()) {
                String found = findText(fields.next().getValue(), field);
                if (found != null) {
                    return found;
                }
            }
        } else if (node.isArray()) {
            for (JsonNode item : node) {
                String found = findText(item, field);
                if (found != null) {
                    return found;
                }
            }
        }
        return null;
    }

    /** 陌生来话快照:必须带 im_id,下轮才能作为「已知候选人」被匹配 */
    private static String buildStrangerSnapshot(String imId, String name, JsonNode card) {
        ObjectNode snapshot = MAPPER.createObjectNode();
        snapshot.put("im_id", imId);
        if (!name.isEmpty()) {
            snapshot.put("name", name);
        }
        snapshot.put("source", "chat_poll");
        if (card != null) {
            snapshot.set("resume_card", card);
        }
        return snapshot.toString();
    }

    private static String attachWorkDir() {
        return Paths.get(ATTACH_WORK_DIR).toAbsolutePath().normalize().toString();
    }

    /** imId 前 8 位(占位候选人名称兜底用) */
    private static String imIdPrefix(String imId) {
        return imId.length() <= 8 ? imId : imId.substring(0, 8);
    }

    private static void deleteQuietly(String filePath) {
        if (filePath == null || filePath.isBlank()) {
            return;
        }
        try {
            Path path = Paths.get(filePath);
            Files.deleteIfExists(path);
        } catch (Exception e) {
            log.debug("附件临时文件清理失败: {}", e.getMessage());
        }
    }
}
