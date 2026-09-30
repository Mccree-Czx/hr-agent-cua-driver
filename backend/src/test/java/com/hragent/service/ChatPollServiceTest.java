package com.hragent.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.hragent.entity.Candidate;
import com.hragent.entity.GreetingRecord;
import com.hragent.entity.Jd;
import com.hragent.entity.LiepinAccount;
import com.hragent.entity.ResumeFile;
import com.hragent.entity.ScoreRecord;
import com.hragent.executor.CliException;
import com.hragent.repository.CandidateMapper;
import com.hragent.repository.GreetingRecordMapper;
import com.hragent.repository.JdMapper;
import com.hragent.repository.LiepinAccountMapper;
import com.hragent.repository.ResumeFileMapper;
import com.hragent.repository.ScoreRecordMapper;
import com.hragent.storage.StorageService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.mockito.InOrder;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoBean;

import com.hragent.ai.AiClient;
import org.springframework.transaction.annotation.Transactional;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDateTime;
import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * ChatPollService 来信轮询(被动通道)测试。
 *
 * <p>外部边界(commandService)全部 mock;候选/招呼/附件/评分记录用真实 mapper(H2)+ 真实
 * ResumeCollectService/StorageService,以验证「附件校验入库、去重、下轮重试」等落库语义。
 */
@SpringBootTest
@ActiveProfiles("test")
@Transactional
class ChatPollServiceTest {

    private static final byte[] PDF = "%PDF-1.4\nmock resume body".getBytes(StandardCharsets.UTF_8);

    @Autowired
    private ChatPollService chatPollService;

    @Autowired
    private CandidateMapper candidateMapper;

    @Autowired
    private LiepinAccountMapper accountMapper;

    @Autowired
    private GreetingRecordMapper greetingMapper;

    @Autowired
    private ResumeFileMapper resumeFileMapper;

    @Autowired
    private ScoreRecordMapper scoreRecordMapper;

    @Autowired
    private JdMapper jdMapper;

    @Autowired
    private StorageService storageService;

    @Autowired
    private AutoRecruitSettingService settingService;

    @MockitoBean
    private LiepinCommandService commandService;

    @MockitoBean
    private AiClient aiClient;

    @MockitoBean
    private AccountPaceGuard paceGuard;

    @TempDir
    Path tempDir;

    private final ObjectMapper objectMapper = new ObjectMapper();

    private LiepinAccount account;

    @BeforeEach
    void setUp() {
        resumeFileMapper.delete(new LambdaQueryWrapper<>());
        greetingMapper.delete(new LambdaQueryWrapper<>());
        scoreRecordMapper.delete(new LambdaQueryWrapper<>());
        candidateMapper.delete(new LambdaQueryWrapper<>());
        accountMapper.delete(new LambdaQueryWrapper<>());
        jdMapper.delete(new LambdaQueryWrapper<>());

        account = new LiepinAccount();
        account.setName("测试账号");
        account.setLoginStatus("NORMAL");
        account.setCircuitBreaker(false);
        account.setGreetMode("AUTO");
        accountMapper.insert(account);
    }

    // ---------- 附件:attach-fetch 获取成功 → 校验入库(不看分数/门槛) ----------

    @Test
    void attachmentFetchedAndStoredEvenWithoutScoreOrThreshold() throws Exception {
        // 来源岗位未确认门槛 + 候选人评分 FAIL:附件仍应入库(设计 3.2「不受分数限制」)
        Jd jd = unconfirmedJd("招聘主管", "88888");
        Candidate candidate = knownCandidate("im1", "张三");
        candidate.setJdId(jd.getId());
        candidate.setPassStatus("FAIL");
        candidateMapper.updateById(candidate);
        GreetingRecord record = greeting(candidate);

        stubChatlist("{\"im_id\":\"im1\",\"name\":\"张三\",\"direction\":\"1\",\"raw_metadata\":{\"latestMsgId\":\"m-100\"}}");
        Path pdf = writePdf("resume-fetched.pdf");
        when(commandService.attachFetch(any(), eq("im1"), any(), anyString(), any()))
                .thenReturn(Optional.of(attachFetchResult(pdf, "硬件工程师0922.pdf")));

        int processed = chatPollService.pollOnce(account);

        assertEquals(1, processed);
        List<ResumeFile> files = resumeFileMapper.selectList(new LambdaQueryWrapper<ResumeFile>()
                .eq(ResumeFile::getCandidateId, candidate.getId()));
        assertEquals(1, files.size(), "附件应入库");
        assertEquals("pdf", files.get(0).getFormat());
        assertEquals(PDF.length, files.get(0).getSize());
        assertTrue(files.get(0).getObjectKey().contains("硬件工程师0922"), "入库文件名应来自 attach-fetch(fileName)");
        assertTrue(storageService.exists(files.get(0).getObjectKey()), "附件应写入存储");
        verify(commandService).attachFetch(any(), eq("im1"), any(), anyString(), any());
        assertEquals("m-100", greetingMapper.selectById(record.getId()).getAttachProbeMsgId(), "探测成功后应写消息级标记");
        verify(commandService, never()).requestResume(any(), anyString(), any(), any());
        assertFalse(Files.exists(pdf), "下载临时文件应清理");
    }

    // ---------- 附件:获取失败 → 不入库、无半状态、下轮重试(不写探测标记) ----------

    @Test
    void attachmentFailureLeavesNoHalfStateAndRetriesNextRound() throws Exception {
        Candidate candidate = knownCandidate("im1", "张三");
        GreetingRecord record = greeting(candidate);

        stubChatlist("{\"im_id\":\"im1\",\"direction\":\"1\",\"raw_metadata\":{\"latestMsgId\":\"m-9\"}}");
        when(commandService.attachFetch(any(), eq("im1"), any(), anyString(), any()))
                .thenReturn(Optional.of(objectMapper.readTree(
                        "{\"found\":true,\"success\":false,\"reason\":\"download-failed\",\"detail\":\"取消\"}")));

        int first = chatPollService.pollOnce(account);
        int second = chatPollService.pollOnce(account);

        assertEquals(0, first);
        assertEquals(0, second);
        assertEquals(0, resumeFileMapper.selectCount(new LambdaQueryWrapper<>()), "失败不得入库(无半状态)");
        verify(commandService, times(2)).attachFetch(any(), eq("im1"), any(), anyString(), any());
        assertNull(greetingMapper.selectById(record.getId()).getAttachProbeMsgId(), "失败不得写探测标记(下轮重试)");
    }

    // ---------- 附件探测防抖(消息级) ----------

    @Test
    void attachProbeDebouncedBySameMessageId() throws Exception {
        Jd jd = confirmedJd("招聘主管", "88888");
        Candidate candidate = knownCandidate("im1", "张三");
        candidate.setJdId(jd.getId());
        candidateMapper.updateById(candidate);
        GreetingRecord record = greeting(candidate);
        record.setAttachProbeMsgId("m-100");
        greetingMapper.updateById(record);

        stubChatlist("{\"im_id\":\"im1\",\"direction\":\"1\",\"raw_metadata\":{\"latestMsgId\":\"m-100\"}}");
        stubChatmsg("im1", "{\"payload\":{\"bodies\":[{\"type\":\"txt\",\"msg\":\"您好\"}]}}");
        when(commandService.requestResume(any(), eq("r-im1"), any(), any()))
                .thenReturn(Optional.of(objectMapper.readTree("{\"success\":true,\"confirmed\":true}")));

        chatPollService.pollOnce(account);

        verify(commandService, never()).attachFetch(any(), anyString(), any(), anyString(), any());
        verify(commandService).requestResume(any(), eq("r-im1"), any(), any()); // 防抖不阻塞"回复索要"
    }

    @Test
    void attachProbeRetriggersWhenMessageIdChanges() throws Exception {
        Candidate candidate = knownCandidate("im1", "张三");
        GreetingRecord record = greeting(candidate);
        record.setAttachProbeMsgId("m-100");
        greetingMapper.updateById(record);

        stubChatlist("{\"im_id\":\"im1\",\"direction\":\"1\",\"raw_metadata\":{\"latestMsgId\":\"m-200\"}}");
        when(commandService.attachFetch(any(), eq("im1"), any(), anyString(), any()))
                .thenReturn(Optional.of(objectMapper.readTree("{\"found\":false,\"success\":false,\"reason\":\"no-attachment\"}")));

        chatPollService.pollOnce(account);

        verify(commandService).attachFetch(any(), eq("im1"), any(), anyString(), any());
        assertEquals("m-200", greetingMapper.selectById(record.getId()).getAttachProbeMsgId(), "新消息应重探并更新标记");
    }

    // ---------- 文本回复:门槛未确认 → 不索要 ----------

    @Test
    void textReplyWithUnconfirmedThresholdDoesNotRequest() throws Exception {
        Jd jd = unconfirmedJd("未确认门槛岗位", "77777");
        Candidate candidate = knownCandidate("im1", "张三");
        candidate.setJdId(jd.getId());
        candidateMapper.updateById(candidate);
        GreetingRecord record = greeting(candidate);

        stubChatlist("{\"im_id\":\"im1\",\"user_id\":\"u1\",\"direction\":\"1\"}");
        stubChatmsg("im1", "{\"payload\":{\"bodies\":[{\"type\":\"txt\",\"msg\":\"您好\"}]}}");

        chatPollService.pollOnce(account);

        verify(commandService, never()).requestResume(any(), anyString(), any(), any());
        assertEquals("SENT", greetingMapper.selectById(record.getId()).getStatus(), "未确认门槛不得改状态");
    }

    // ---------- 文本回复:门槛确认 + PASS → 索要 ----------

    @Test
    void textReplyPassConfirmedThresholdRequestsResume() throws Exception {
        Jd jd = confirmedJd("招聘主管", "88888");
        Candidate candidate = knownCandidate("im1", "张三");
        candidate.setJdId(jd.getId());
        candidateMapper.updateById(candidate);
        GreetingRecord record = greeting(candidate);

        stubChatlist("{\"im_id\":\"im1\",\"user_id\":\"u1\",\"direction\":\"1\"}");
        stubChatmsg("im1", "{\"payload\":{\"bodies\":[{\"type\":\"txt\",\"msg\":\"您好\"}]}}");
        when(commandService.requestResume(any(), eq("r-im1"), any(), any()))
                .thenReturn(Optional.of(objectMapper.readTree("{\"success\":true,\"confirmed\":true}")));

        chatPollService.pollOnce(account);

        verify(commandService).requestResume(any(), eq("r-im1"), any(), any());
        assertEquals("REQUESTED", greetingMapper.selectById(record.getId()).getStatus());
    }

    // ---------- 陌生来话:提取成功 + 可关联岗位 → 建候选人并走三态门禁 ----------

    @Test
    void strangerWithResumeCardAndJobCreatesCandidateWithJd() throws Exception {
        Jd jd = confirmedJd("招聘主管", "88888");
        stubChatlist("{\"im_id\":\"stranger1\",\"name\":\"李四\",\"direction\":\"1\"}");
        stubChatmsg("stranger1",
                "{\"message_id\":\"m1\",\"sender\":\"对方\",\"opposite_im_id\":\"stranger1\","
                        + "\"payload\":{\"bodies\":[{\"type\":\"resume\",\"enresId\":\"enres-1\",\"ejobId\":\"88888\"}]}}");
        // v2:职能软判,无快照期望证据不再冻结 PENDING,交模型出星级
        when(aiClient.chat(anyString(), anyString()))
                .thenReturn("{\"star\":2,\"summary\":\"信息不足\",\"reasons\":[\"无期望证据\"]}");

        int processed = chatPollService.pollOnce(account);

        assertEquals(1, processed);
        List<Candidate> created = candidateMapper.selectList(new LambdaQueryWrapper<>());
        assertEquals(1, created.size(), "陌生来话应建候选人(不猜身份:仅用卡片提取的标识)");
        Candidate c = created.get(0);
        assertEquals("enres-1", c.getResumeId());
        assertEquals("李四", c.getName());
        assertEquals(jd.getId(), c.getJdId(), "能确定岗位则关联");
        assertEquals("KEPT", c.getPassStatus(), "v2:无期望证据不再冻结 PENDING,按星级结论(2星留库)");
        assertEquals(1, scoreRecordMapper.selectCount(new LambdaQueryWrapper<ScoreRecord>()
                .eq(ScoreRecord::getCandidateId, c.getId())), "有关联岗位才走评分门禁");
    }

    // ---------- 陌生来话:提取成功但无法关联岗位 → 待分配,不评分 ----------

    @Test
    void strangerWithResumeCardWithoutJobCreatesUnassignedCandidate() throws Exception {
        stubChatlist("{\"im_id\":\"stranger2\",\"name\":\"王五\",\"direction\":\"1\"}");
        stubChatmsg("stranger2",
                "{\"payload\":{\"bodies\":[{\"type\":\"resume\",\"enresId\":\"enres-2\"}]}}");

        chatPollService.pollOnce(account);

        List<Candidate> created = candidateMapper.selectList(new LambdaQueryWrapper<>());
        assertEquals(1, created.size());
        assertEquals("enres-2", created.get(0).getResumeId());
        assertNull(created.get(0).getJdId(), "无关联岗位 → 待分配(jdId 为空)");
        assertEquals(0, scoreRecordMapper.selectCount(new LambdaQueryWrapper<>()), "无岗位不评分");
        verify(commandService, never()).requestResume(any(), anyString(), any(), any());
    }

    // ---------- 陌生来话:提取失败 → 不建/不猜/不评分 ----------

    @Test
    void strangerWithoutResumeCardDoesNotCreateOrScore() throws Exception {
        stubChatlist("{\"im_id\":\"stranger3\",\"name\":\"赵六\",\"direction\":\"1\"}");
        stubChatmsg("stranger3", "{\"payload\":{\"bodies\":[{\"type\":\"txt\",\"msg\":\"你好\"}]}}");

        int processed = chatPollService.pollOnce(account);

        assertEquals(0, processed);
        assertEquals(0, candidateMapper.selectCount(new LambdaQueryWrapper<>()), "提取失败不猜测,不建候选人");
        assertEquals(0, scoreRecordMapper.selectCount(new LambdaQueryWrapper<>()), "不调用评分");
        verify(commandService, never()).requestResume(any(), anyString(), any(), any());
    }

    // ---------- 风控异常 → 上抛中断本轮 ----------

    @Test
    void riskControlPropagatesToStopRound() throws Exception {
        Candidate candidate = knownCandidate("im1", "张三");
        greeting(candidate);

        stubChatlist("{\"im_id\":\"im1\",\"direction\":\"1\",\"raw_metadata\":{\"latestMsgId\":\"m-risk\"}}");
        when(commandService.attachFetch(any(), eq("im1"), any(), anyString(), any()))
                .thenThrow(new CliException(CliException.Type.RISK_CONTROL, "安全验证"));

        assertThrows(CliException.class, () -> chatPollService.pollOnce(account));
    }

    // ---------- 会话列表拉取瞬断 → 跳过来信但不中断本轮(非风控) ----------

    @Test
    void chatlistTransientFailureSkipsInboundWithoutBreakingRound() throws Exception {
        when(commandService.chatlist(any(), any()))
                .thenThrow(new CliException(CliException.Type.FAILED, "驱动执行超时"));

        int processed = chatPollService.pollOnce(account);

        assertEquals(0, processed);
        verify(commandService, never()).chatmsg(any(), anyString(), any());
    }

    // ---------- 单会话失败不中断其余会话 ----------

    @Test
    void singleSessionFailureDoesNotBlockOthers() throws Exception {
        Candidate a = knownCandidate("imA", "甲");
        greeting(a);
        Candidate b = knownCandidate("imB", "乙");
        greeting(b);

        when(commandService.chatlist(any(), any())).thenReturn(List.of(
                objectMapper.readTree("{\"im_id\":\"imA\",\"direction\":\"1\",\"raw_metadata\":{\"latestMsgId\":\"mA\"}}"),
                objectMapper.readTree("{\"im_id\":\"imB\",\"direction\":\"1\",\"raw_metadata\":{\"latestMsgId\":\"mB\"}}")));
        when(commandService.attachFetch(any(), eq("imA"), any(), anyString(), any()))
                .thenThrow(new RuntimeException("会话 A 附件获取失败"));
        Path pdf = writePdf("b.pdf");
        when(commandService.attachFetch(any(), eq("imB"), any(), anyString(), any()))
                .thenReturn(Optional.of(attachFetchResult(pdf, "乙.pdf")));

        int processed = chatPollService.pollOnce(account);

        assertEquals(1, processed, "A 失败不阻断 B");
        assertEquals(1, resumeFileMapper.selectCount(new LambdaQueryWrapper<ResumeFile>()
                .eq(ResumeFile::getCandidateId, b.getId())), "B 的附件仍应入库");
        assertEquals(0, resumeFileMapper.selectCount(new LambdaQueryWrapper<ResumeFile>()
                .eq(ResumeFile::getCandidateId, a.getId())), "A 失败不得入库");
    }

    // ---------- 附件获取异常隔离(旧“消息体扫描”用例已随 2026-09-26 检测重构移除;----------
    // ---------- 发送方过滤原则改由 CLI 层覆盖,见 attach-fetch.test.ts“只认对方消息”) ----------

    // ---------- I-3:陌生来话带附件、无身份标识 → 占位入库待分配 ----------

    @Test
    void strangerAttachmentWithoutResumeIdCreatesPlaceholderAndStoresFile() throws Exception {
        stubChatlist("{\"im_id\":\"strangerAtt\",\"name\":\"钱七\",\"direction\":\"1\"}");
        stubChatmsg("strangerAtt",
                "{\"sender\":\"对方\",\"payload\":{\"bodies\":[{\"type\":\"file\",\"fileId\":\"fax1\",\"filename\":\"简历.pdf\"}]}}");
        Path pdf = writePdf("resume.pdf");
        when(commandService.attachDownload(any(), eq("strangerAtt"), anyString(), any()))
                .thenReturn(Optional.of(downloadResult(pdf)));

        int processed = chatPollService.pollOnce(account);

        assertEquals(1, processed);
        List<Candidate> created = candidateMapper.selectList(new LambdaQueryWrapper<>());
        assertEquals(1, created.size(), "陌生来话带附件应建占位候选人");
        Candidate c = created.get(0);
        assertEquals("im:strangerAtt", c.getResumeId(), "占位 resume_id 必须带 im: 前缀,不冒充真实简历 ID");
        assertEquals("钱七", c.getName());
        assertNull(c.getJdId(), "待分配(jd_id 为空)");
        assertEquals("PENDING", c.getPassStatus());
        assertEquals(1, resumeFileMapper.selectCount(new LambdaQueryWrapper<ResumeFile>()
                .eq(ResumeFile::getCandidateId, c.getId())), "附件应入库");
        assertEquals(0, scoreRecordMapper.selectCount(new LambdaQueryWrapper<>()), "占位候选不评分");
        verify(commandService, never()).requestResume(any(), anyString(), any(), any());
    }

    @Test
    void strangerAttachmentWithoutNameUsesPlaceholderName() throws Exception {
        stubChatlist("{\"im_id\":\"1234567890\",\"direction\":\"1\"}");
        stubChatmsg("1234567890",
                "{\"sender\":\"对方\",\"payload\":{\"bodies\":[{\"type\":\"file\",\"fileId\":\"fax2\",\"filename\":\"简历.pdf\"}]}}");
        Path pdf = writePdf("resume.pdf");
        when(commandService.attachDownload(any(), eq("1234567890"), anyString(), any()))
                .thenReturn(Optional.of(downloadResult(pdf)));

        chatPollService.pollOnce(account);

        Candidate c = candidateMapper.selectOne(new LambdaQueryWrapper<>());
        assertEquals("待分配-12345678", c.getName(), "取不到显示名 → 待分配-<imId前8位>");
    }

    @Test
    void strangerAttachmentRepeatedRoundDoesNotDuplicateCandidate() throws Exception {
        stubChatlist("{\"im_id\":\"strangerAtt\",\"name\":\"钱七\",\"direction\":\"1\"}");
        stubChatmsg("strangerAtt",
                "{\"sender\":\"对方\",\"payload\":{\"bodies\":[{\"type\":\"file\",\"fileId\":\"fax1\",\"filename\":\"简历.pdf\"}]}}");
        Path pdf = writePdf("resume.pdf");
        when(commandService.attachDownload(any(), eq("strangerAtt"), anyString(), any()))
                .thenReturn(Optional.of(downloadResult(pdf)));

        chatPollService.pollOnce(account);
        chatPollService.pollOnce(account);

        assertEquals(1, candidateMapper.selectCount(new LambdaQueryWrapper<>()), "重复轮不得重复建占位候选人");
        verify(commandService, times(1)).attachDownload(any(), eq("strangerAtt"), anyString(), any());
    }

    // ---------- I-2:同轮多次外发共享 AccountPaceGuard,await→mark 成对有序 ----------

    @Test
    void outboundRequestActionsAwaitAndMarkPaceGuardInOrder() throws Exception {
        // 会话 A:附件获取(纯接口读,不占发送节奏);会话 B:门槛确认+PASS 文本回复索要 → 仅索要占用节奏
        Candidate a = knownCandidate("imA", "甲");
        greeting(a);
        Jd jd = confirmedJd("招聘主管", "88888");
        Candidate b = knownCandidate("imB", "乙");
        b.setJdId(jd.getId());
        candidateMapper.updateById(b);
        greeting(b);

        when(commandService.chatlist(any(), any())).thenReturn(List.of(
                objectMapper.readTree("{\"im_id\":\"imA\",\"direction\":\"1\",\"raw_metadata\":{\"latestMsgId\":\"mA\"}}"),
                objectMapper.readTree("{\"im_id\":\"imB\",\"direction\":\"1\",\"raw_metadata\":{\"latestMsgId\":\"mB\"}}")));
        Path pdf = writePdf("a.pdf");
        when(commandService.attachFetch(any(), eq("imA"), any(), anyString(), any()))
                .thenReturn(Optional.of(attachFetchResult(pdf, "甲.pdf")));
        when(commandService.attachFetch(any(), eq("imB"), any(), anyString(), any()))
                .thenReturn(Optional.of(objectMapper.readTree("{\"found\":false,\"success\":false,\"reason\":\"no-attachment\"}")));
        stubChatmsg("imB", "{\"sender\":\"对方\",\"payload\":{\"bodies\":[{\"type\":\"txt\",\"msg\":\"您好\"}]}}");
        when(commandService.requestResume(any(), eq("r-imB"), any(), any()))
                .thenReturn(Optional.of(objectMapper.readTree("{\"success\":true,\"confirmed\":true}")));

        chatPollService.pollOnce(account);

        // 索要(外发)必须 await→mark 成对且仅一次;附件获取为读操作,不占发送节奏
        InOrder order = inOrder(paceGuard);
        order.verify(paceGuard).await(account);
        order.verify(paceGuard).mark(account);
        verify(paceGuard, times(1)).await(account);
        verify(paceGuard, times(1)).mark(account);
    }

    // ---------- I2:im_id 缺失时按 user_id 回退匹配已知候选人 ----------

    @Test
    void knownCandidateMatchedByUserIdWhenSnapshotImIdMissing() throws Exception {
        Jd jd = confirmedJd("招聘主管", "88888");
        // 已招呼候选人:snapshot 无 im_id,但有推荐输出的 user_id
        Candidate candidate = new Candidate();
        candidate.setResumeId("r-u1");
        candidate.setName("张三");
        candidate.setSnapshot("{\"user_id\":\"u1\",\"name\":\"张三\"}");
        candidate.setPassStatus("PASS");
        candidate.setJdId(jd.getId());
        candidateMapper.insert(candidate);
        GreetingRecord record = greeting(candidate);

        stubChatlist("{\"im_id\":\"imX\",\"user_id\":\"u1\",\"direction\":\"1\"}");
        stubChatmsg("imX", "{\"payload\":{\"bodies\":[{\"type\":\"txt\",\"msg\":\"您好\"}]}}");
        when(commandService.requestResume(any(), eq("r-u1"), any(), any()))
                .thenReturn(Optional.of(objectMapper.readTree("{\"success\":true,\"confirmed\":true}")));

        chatPollService.pollOnce(account);

        verify(commandService).requestResume(any(), eq("r-u1"), any(), any());
        assertEquals("REQUESTED", greetingMapper.selectById(record.getId()).getStatus());
        assertEquals(1, candidateMapper.selectCount(new LambdaQueryWrapper<>()),
                "user_id 回退命中已知候选人,不得误建陌生候选人");
    }

    // ---------- 对方已读我方消息:不等回复直接索要(2026-09-26) ----------

    @Test
    void oppositeReadTriggersResumeRequestWithoutReply() throws Exception {
        Jd jd = confirmedJd("招聘主管", "88888");
        Candidate candidate = knownCandidate("im1", "张三");
        candidate.setJdId(jd.getId());
        candidateMapper.updateById(candidate);
        GreetingRecord record = greeting(candidate);

        // 对方沉默(direction=0),但已读我方最新消息
        stubChatlist("{\"im_id\":\"im1\",\"direction\":\"0\",\"raw_metadata\":{\"oppositeRead\":\"1\"}}");
        when(commandService.requestResume(any(), eq("r-im1"), any(), any()))
                .thenReturn(Optional.of(objectMapper.readTree("{\"success\":true,\"confirmed\":true}")));

        int processed = chatPollService.pollOnce(account);

        assertEquals(1, processed, "已读触发索要应计为已处理");
        verify(commandService).requestResume(any(), eq("r-im1"), any(), any());
        assertEquals("REQUESTED", greetingMapper.selectById(record.getId()).getStatus());
        verify(commandService, never()).chatmsg(any(), anyString(), any());
    }

    @Test
    void oppositeReadMissingOrZeroDoesNotRequest() throws Exception {
        Jd jd = confirmedJd("招聘主管", "88888");
        Candidate candidate = knownCandidate("im1", "张三");
        candidate.setJdId(jd.getId());
        candidateMapper.updateById(candidate);
        GreetingRecord record = greeting(candidate);

        // 字段缺失
        stubChatlist("{\"im_id\":\"im1\",\"direction\":\"0\"}");
        chatPollService.pollOnce(account);
        // 字段为 0(未读)
        stubChatlist("{\"im_id\":\"im1\",\"direction\":\"0\",\"raw_metadata\":{\"oppositeRead\":\"0\"}}");
        chatPollService.pollOnce(account);

        verify(commandService, never()).requestResume(any(), anyString(), any(), any());
        assertEquals("SENT", greetingMapper.selectById(record.getId()).getStatus());
    }

    @Test
    void oppositeReadWithUnconfirmedThresholdDoesNotRequest() throws Exception {
        Jd jd = unconfirmedJd("未确认门槛岗位", "77777");
        Candidate candidate = knownCandidate("im1", "张三");
        candidate.setJdId(jd.getId());
        candidateMapper.updateById(candidate);
        GreetingRecord record = greeting(candidate);

        stubChatlist("{\"im_id\":\"im1\",\"direction\":\"0\",\"raw_metadata\":{\"oppositeRead\":\"1\"}}");
        chatPollService.pollOnce(account);

        verify(commandService, never()).requestResume(any(), anyString(), any(), any());
        assertEquals("SENT", greetingMapper.selectById(record.getId()).getStatus(), "未确认门槛不得改状态");
    }

    @Test
    void oppositeReadAlreadyRequestedDoesNotRepeat() throws Exception {
        Jd jd = confirmedJd("招聘主管", "88888");
        Candidate candidate = knownCandidate("im1", "张三");
        candidate.setJdId(jd.getId());
        candidateMapper.updateById(candidate);
        GreetingRecord record = greeting(candidate);
        record.setStatus("REQUESTED");
        greetingMapper.updateById(record);

        stubChatlist("{\"im_id\":\"im1\",\"direction\":\"0\",\"raw_metadata\":{\"oppositeRead\":\"1\"}}");
        chatPollService.pollOnce(account);

        verify(commandService, never()).requestResume(any(), anyString(), any(), any());
    }

    // ---------- 运行时开关关闭(只停主动外发):索要攒着,附件照常收集 ----------

    @Test
    void switchOffSkipsReadRequestAndKeepsRecord() throws Exception {
        Jd jd = confirmedJd("招聘主管", "88888");
        Candidate candidate = knownCandidate("im1", "张三");
        candidate.setJdId(jd.getId());
        candidateMapper.updateById(candidate);
        GreetingRecord record = greeting(candidate);
        settingService.setEnabled(false);

        stubChatlist("{\"im_id\":\"im1\",\"direction\":\"0\",\"raw_metadata\":{\"oppositeRead\":\"1\"}}");

        int processed = chatPollService.pollOnce(account);

        verify(commandService, never()).requestResume(any(), anyString(), any(), any());
        assertEquals("SENT", greetingMapper.selectById(record.getId()).getStatus(), "攒着:状态不得回写");
        assertEquals(0, processed);
    }

    @Test
    void switchOffSkipsReplyRequestAndKeepsRecord() throws Exception {
        Jd jd = confirmedJd("招聘主管", "88888");
        Candidate candidate = knownCandidate("im1", "张三");
        candidate.setJdId(jd.getId());
        candidateMapper.updateById(candidate);
        GreetingRecord record = greeting(candidate);
        settingService.setEnabled(false);

        stubChatlist("{\"im_id\":\"im1\",\"user_id\":\"u1\",\"direction\":\"1\"}");
        stubChatmsg("im1", "{\"payload\":{\"bodies\":[{\"type\":\"txt\",\"msg\":\"您好\"}]}}");

        int processed = chatPollService.pollOnce(account);

        verify(commandService, never()).requestResume(any(), anyString(), any(), any());
        assertEquals("SENT", greetingMapper.selectById(record.getId()).getStatus(), "攒着:状态不得回写");
        assertEquals(0, processed);
    }

    @Test
    void switchOffStillCollectsAttachment() throws Exception {
        Candidate candidate = knownCandidate("im1", "张三");
        GreetingRecord record = greeting(candidate);
        settingService.setEnabled(false);

        stubChatlist("{\"im_id\":\"im1\",\"name\":\"张三\",\"direction\":\"1\",\"raw_metadata\":{\"latestMsgId\":\"m-off-2\"}}");
        Path pdf = writePdf("resume-off.pdf");
        when(commandService.attachFetch(any(), eq("im1"), any(), anyString(), any()))
                .thenReturn(Optional.of(attachFetchResult(pdf, "简历.pdf")));

        int processed = chatPollService.pollOnce(account);

        assertEquals(1, processed, "附件收集不受开关影响");
        assertEquals(1, resumeFileMapper.selectCount(new LambdaQueryWrapper<ResumeFile>()
                .eq(ResumeFile::getCandidateId, candidate.getId())), "附件应照常入库");
        assertEquals("m-off-2", greetingMapper.selectById(record.getId()).getAttachProbeMsgId());
    }

    // ---------- 轮内重试:chatlist 首次失败(非风控)后重试成功 ----------

    @Test
    void chatlistTransientFailureRetriesOnceWithinRound() throws Exception {
        Jd jd = confirmedJd("招聘主管", "88888");
        Candidate candidate = knownCandidate("im1", "张三");
        candidate.setJdId(jd.getId());
        candidateMapper.updateById(candidate);
        greeting(candidate);

        when(commandService.chatlist(any(), any()))
                .thenThrow(new CliException(CliException.Type.TIMEOUT, "驱动执行超时(account=1)"))
                .thenReturn(List.of(objectMapper.readTree(
                        "{\"im_id\":\"im1\",\"direction\":\"0\",\"raw_metadata\":{\"oppositeRead\":\"1\"}}")));
        when(commandService.requestResume(any(), eq("r-im1"), any(), any()))
                .thenReturn(Optional.of(objectMapper.readTree("{\"success\":true,\"confirmed\":true}")));

        chatPollService.pollOnce(account);

        verify(commandService, times(2)).chatlist(any(), any());
        verify(commandService).requestResume(any(), eq("r-im1"), any(), any());
    }

    // ---------- 熔断治理:轮内索要预算(2026-09-28) ----------

    @Test
    void askBudgetCapsAutomaticAsksPerPoll() throws Exception {
        Jd jd = confirmedJd("招聘主管", "88888");
        GreetingRecord[] records = new GreetingRecord[11];
        String[] sessions = new String[11];
        for (int i = 1; i <= 11; i++) {
            Candidate candidate = knownCandidate("im" + i, "候选" + i);
            candidate.setJdId(jd.getId());
            candidateMapper.updateById(candidate);
            records[i - 1] = greeting(candidate);
            sessions[i - 1] = "{\"im_id\":\"im" + i + "\",\"direction\":\"0\",\"raw_metadata\":{\"oppositeRead\":\"1\"}}";
        }
        stubChatlist(sessions);
        when(commandService.requestResume(any(), anyString(), any(), any()))
                .thenReturn(Optional.of(objectMapper.readTree("{\"success\":true,\"confirmed\":true}")));

        chatPollService.pollOnce(account);

        // 默认 ask-batch-limit=10:11 个已读会话只发 10 次索要,第 11 个攒着下轮
        verify(commandService, times(10)).requestResume(any(), anyString(), any(), any());
        long requested = java.util.Arrays.stream(records)
                .filter(r -> "REQUESTED".equals(greetingMapper.selectById(r.getId()).getStatus()))
                .count();
        assertEquals(10, requested, "超出预算的候选人应保持 SENT 攒着写入轮");
    }

    @Test
    void resetStateDoesNotBlockAutomaticAsks() throws Exception {
        Jd jd = confirmedJd("招聘主管", "88888");
        Candidate candidate = knownCandidate("im1", "张三");
        candidate.setJdId(jd.getId());
        candidateMapper.updateById(candidate);
        GreetingRecord record = greeting(candidate);
        // 冷却机制已移除(2026-09-28 剔除):历史重置字段不再拦截自动索要
        account.setRiskResetAt(LocalDateTime.now());
        accountMapper.updateById(account);

        stubChatlist("{\"im_id\":\"im1\",\"direction\":\"0\",\"raw_metadata\":{\"oppositeRead\":\"1\"}}");
        when(commandService.requestResume(any(), anyString(), any(), any()))
                .thenReturn(Optional.of(objectMapper.readTree("{\"success\":true,\"confirmed\":true}")));

        chatPollService.pollOnce(account);

        verify(commandService).requestResume(any(), anyString(), any(), any());
        assertEquals("REQUESTED", greetingMapper.selectById(record.getId()).getStatus(),
                "重置时刻不再拦截自动索要");
    }

    // ---------- 辅助 ----------

    private void stubChatlist(String... sessions) throws Exception {
        List<JsonNode> list = new java.util.ArrayList<>();
        for (String session : sessions) {
            list.add(objectMapper.readTree(session));
        }
        when(commandService.chatlist(any(), any())).thenReturn(list);
    }

    private void stubChatmsg(String imId, String... messages) throws Exception {
        List<JsonNode> list = new java.util.ArrayList<>();
        for (String message : messages) {
            list.add(objectMapper.readTree(message));
        }
        when(commandService.chatmsg(any(), eq(imId), any())).thenReturn(list);
    }

    private Candidate knownCandidate(String imId, String name) {
        Candidate c = new Candidate();
        c.setResumeId("r-" + imId);
        c.setName(name);
        c.setSnapshot("{\"im_id\":\"" + imId + "\",\"name\":\"" + name + "\"}");
        c.setPassStatus("PASS");
        candidateMapper.insert(c);
        return c;
    }

    private GreetingRecord greeting(Candidate candidate) {
        GreetingRecord record = new GreetingRecord();
        record.setCandidateId(candidate.getId());
        record.setAccountId(account.getId());
        record.setStatus("SENT");
        record.setMode("AUTO");
        greetingMapper.insert(record);
        return record;
    }

    private Jd confirmedJd(String title, String liepinJobId) {
        Jd jd = baseJd(title, liepinJobId);
        jd.setScoreThreshold(60);
        jd.setThresholdConfirmedAt(LocalDateTime.now());
        jd.setScoringPrefConfirmedAt(LocalDateTime.now());
        jdMapper.insert(jd);
        return jd;
    }

    private Jd unconfirmedJd(String title, String liepinJobId) {
        Jd jd = baseJd(title, liepinJobId);
        jdMapper.insert(jd);
        return jd;
    }

    private Jd baseJd(String title, String liepinJobId) {
        Jd jd = new Jd();
        jd.setTitle(title);
        jd.setLiepinJobId(liepinJobId);
        jd.setStatus("ACTIVE");
        return jd;
    }

    private Path writePdf(String name) throws IOException {
        Path path = tempDir.resolve(name);
        Files.write(path, PDF);
        return path;
    }

    private JsonNode downloadResult(Path pdf) {
        ObjectNode node = objectMapper.createObjectNode();
        node.put("success", true);
        node.put("file", pdf.toAbsolutePath().toString());
        node.put("bytes", PDF.length);
        node.put("sha256", "deadbeef");
        node.put("sourceOrigin", "https://tdoss.liepin.com");
        return node;
    }

    /** attach-fetch 成功输出(与 CLI 契约一致) */
    private JsonNode attachFetchResult(Path pdf, String fileName) {
        ObjectNode node = objectMapper.createObjectNode();
        node.put("found", true);
        node.put("success", true);
        node.put("file", pdf.toAbsolutePath().toString());
        node.put("bytes", PDF.length);
        node.put("sha256", "deadbeef");
        node.put("fileName", fileName);
        node.put("fileExtension", "pdf");
        node.put("sourceOrigin", "https://tdoss.liepin.com");
        node.put("via", "api");
        return node;
    }

    // ---------- UI 通道适配:无 im_id 时按会话名匹配候选人(会话名键) ----------

    @Test
    void uiChannelMatchesCandidateBySessionName() throws Exception {
        Candidate candidate = knownCandidate("", "温女士");
        candidate.setResumeId("r-wen");
        Jd jd = confirmedJd("测试岗位", "99999");
        candidate.setJdId(jd.getId());
        candidateMapper.updateById(candidate);
        greeting(candidate);

        // UI chatlist records 形态:无 im_id,有 name/direction
        stubChatlist("{\"name\":\"温女士\",\"direction\":\"1\"}");
        when(commandService.requestResume(any(), eq("r-wen"), any(), any()))
                .thenReturn(Optional.of(objectMapper.readTree("{\"success\":true,\"confirmed\":true}")));

        int processed = chatPollService.pollOnce(account);

        assertEquals(1, processed, "会话名键命中 known 链,索要应计为已处理");
        verify(commandService).requestResume(any(), eq("r-wen"), any(), any());
        verify(commandService, never()).attachFetch(any(), anyString(), any(), anyString(), any());
        verify(commandService, never()).chatmsg(any(), anyString(), any());
    }

    @Test
    void uiChannelSkipsAmbiguousSessionName() throws Exception {
        knownCandidate("t1", "陈先生");
        knownCandidate("t2", "陈先生");

        stubChatlist("{\"name\":\"陈先生\",\"direction\":\"1\"}");

        int processed = chatPollService.pollOnce(account);

        assertEquals(0, processed, "同名多命中应跳过(不猜测)");
        verify(commandService, never()).requestResume(any(), anyString(), any(), any());
        verify(commandService, never()).attachFetch(any(), anyString(), any(), anyString(), any());
        verify(commandService, never()).chatmsg(any(), anyString(), any());
    }

    @Test
    void uiChannelSkipsSessionWithoutImIdAndName() throws Exception {
        stubChatlist("{\"direction\":\"1\"}");

        int processed = chatPollService.pollOnce(account);

        assertEquals(0, processed, "im_id 与 name 均缺失应跳过");
        verify(commandService, never()).requestResume(any(), anyString(), any(), any());
        verify(commandService, never()).chatmsg(any(), anyString(), any());
    }

    @Test
    void uiChannelAttachFetchesBySessionNameWhenImIdMissing() throws Exception {
        Jd jd = unconfirmedJd("招聘主管", "88888");
        Candidate candidate = knownCandidate("", "温女士");
        candidate.setJdId(jd.getId());
        candidateMapper.updateById(candidate);
        greeting(candidate);

        stubChatlist("{\"name\":\"温女士\",\"direction\":\"1\",\"raw_metadata\":{\"latestMsgId\":\"m-ui-1\"}}");
        Path pdf = writePdf("resume-by-name.pdf");
        when(commandService.attachFetch(any(), eq(""), eq("温女士"), anyString(), any()))
                .thenReturn(Optional.of(attachFetchResult(pdf, "温女士的简历.pdf")));

        int processed = chatPollService.pollOnce(account);

        assertEquals(1, processed, "会话名键附件探测应成功入库并计为已处理");
        List<ResumeFile> files = resumeFileMapper.selectList(new LambdaQueryWrapper<ResumeFile>()
                .eq(ResumeFile::getCandidateId, candidate.getId()));
        assertEquals(1, files.size(), "附件应入库");
        verify(commandService).attachFetch(any(), eq(""), eq("温女士"), anyString(), any());
    }

    // ---------- C6:真实 UI records 形态(无 direction/latestMsgId,角标+last_msg 近似) ----------

    @Test
    void uiChannelUnreadBadgeDrivesDirectionAndAttachmentByLastMsgKey() throws Exception {
        Jd jd = unconfirmedJd("招聘主管", "88888");
        Candidate candidate = knownCandidate("", "潘女士");
        candidate.setJdId(jd.getId());
        candidateMapper.updateById(candidate);
        GreetingRecord record = greeting(candidate);

        // 驱动真实输出形态:无 im_id/direction/latestMsgId,有 unread_count 角标与 last_msg
        stubChatlist("{\"name\":\"潘女士\",\"unread\":true,\"unread_count\":2,"
                + "\"last_msg\":\"这是我的简历，合适的话可以随时联系我～\"}");
        Path pdf = writePdf("resume-ui-badge.pdf");
        when(commandService.attachFetch(any(), eq(""), eq("潘女士"), anyString(), any()))
                .thenReturn(Optional.of(attachFetchResult(pdf, "潘女士的简历.pdf")));

        int processed = chatPollService.pollOnce(account);

        assertEquals(1, processed, "unread_count>0 应近似 direction=1 并触发附件探测");
        List<ResumeFile> files = resumeFileMapper.selectList(new LambdaQueryWrapper<ResumeFile>()
                .eq(ResumeFile::getCandidateId, candidate.getId()));
        assertEquals(1, files.size(), "附件应入库");
        assertEquals("这是我的简历，合适的话可以随时联系我～",
                greetingMapper.selectById(record.getId()).getAttachProbeMsgId(), "防抖键应为 last_msg");
        verify(commandService).attachFetch(any(), eq(""), eq("潘女士"), anyString(), any());
    }

    @Test
    void uiChannelWithoutUnreadBadgeStaysUnknownAndSkips() throws Exception {
        Candidate candidate = knownCandidate("", "温女士");
        candidate.setResumeId("r-wen");
        Jd jd = confirmedJd("测试岗位", "99999");
        candidate.setJdId(jd.getId());
        candidateMapper.updateById(candidate);
        greeting(candidate);

        // 无 direction、无角标(unread_count=0)→ 方向未知,不得触发任何外发(不猜)
        stubChatlist("{\"name\":\"温女士\",\"unread\":false,\"unread_count\":0,"
                + "\"last_msg\":\"您好，很高兴认识您\"}");

        int processed = chatPollService.pollOnce(account);

        assertEquals(0, processed, "无角标且无 direction 时不得触发(不猜)");
        verify(commandService, never()).attachFetch(any(), anyString(), any(), anyString(), any());
        verify(commandService, never()).requestResume(any(), anyString(), any(), any());
    }

    @Test
    void effectiveDirectionAndSessionKeyFallbacks() throws Exception {
        JsonNode legacy = objectMapper.readTree("{\"im_id\":\"im1\",\"direction\":\"1\"}");
        assertEquals("im1", ChatPollService.sessionKey(legacy));
        assertEquals("1", ChatPollService.effectiveDirection(legacy));

        JsonNode ui = objectMapper.readTree("{\"name\":\"温女士\",\"unread_count\":2}");
        assertEquals("name:温女士", ChatPollService.sessionKey(ui), "UI 通道去重键应带前缀");
        assertEquals("1", ChatPollService.effectiveDirection(ui), "角标>0 近似对方最后发言");

        JsonNode uiIdle = objectMapper.readTree("{\"name\":\"温女士\",\"unread_count\":0}");
        assertEquals("", ChatPollService.effectiveDirection(uiIdle), "无角标=未知,不猜");
        assertEquals("", ChatPollService.sessionKey(objectMapper.readTree("{}")), "无键返回空串");
    }
}
