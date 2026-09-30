package com.hragent.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.hragent.common.BizException;
import com.hragent.config.HrAgentProperties;
import com.hragent.entity.LiepinAccount;
import com.hragent.executor.CliException;
import com.hragent.executor.CliResult;
import com.hragent.executor.CuaDriverExecutor;
import com.hragent.notify.NotifyService;
import com.hragent.repository.LiepinAccountMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.time.Duration;
import java.util.Arrays;
import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.reset;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * LiepinCommandService 单通道契约测试(2026-09-30 全量替换定稿):
 * 全部命令直走 CUA UI 通道(liepin-cli/legacy 已彻底移除);
 * 覆盖参数拼装、records 解析、风控接线与 attach 键分支。
 */
class LiepinCommandServiceRoutingTest {

    private CuaDriverExecutor cua;
    private LiepinAccountMapper accounts;
    private LiepinCommandService service;
    private LiepinAccount account;

    @BeforeEach
    void setUp() {
        HrAgentProperties properties = new HrAgentProperties();
        cua = mock(CuaDriverExecutor.class);
        accounts = mock(LiepinAccountMapper.class);
        service = new LiepinCommandService(cua, accounts, mock(NotifyService.class),
                new RiskSuspectGuard(properties));

        account = new LiepinAccount();
        account.setId(1L);
        account.setLoginStatus("NORMAL");
        account.setCircuitBreaker(false);
    }

    private void stubOk(String stdout) {
        try {
            when(cua.execute(any(), any(), any(String[].class)))
                    .thenReturn(new CliResult(0, stdout, "", false));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private String[] captureArgs() throws Exception {
        ArgumentCaptor<String[]> captor = ArgumentCaptor.forClass(String[].class);
        verify(cua, times(1)).execute(eq(account), any(), captor.capture());
        return captor.getValue();
    }

    @Test
    void greetRunsOnUiChannelWithRiskCheck() throws Exception {
        stubOk("{\"success\":true}");
        service.greet(account, "r1", "42", "你好", Duration.ofMinutes(1));
        String[] argv = captureArgs();
        assertEquals("greet", argv[0]);
        verify(cua, times(1)).checkRisk(eq(account), any());
    }

    @Test
    void requestResumeRunsOnUiChannel() throws Exception {
        stubOk("{\"success\":true,\"confirmed\":true}");
        service.requestResume(account, "r1", "im-9", Duration.ofMinutes(1));
        assertEquals("request-resume", captureArgs()[0]);
    }

    @Test
    void chatlistRunsOnUiChannel() throws Exception {
        stubOk("[]");
        service.chatlist(account, Duration.ofMinutes(1));
        assertEquals("chatlist", captureArgs()[0]);
    }

    @Test
    void jobListReadsRecordsAndPassesWithIds() throws Exception {
        stubOk("{\"extraction_status\":\"validated\",\"records\":[{\"title\":\"销售经理\","
                + "\"city\":\"上海-黄浦区\",\"salary\":\"15-30k\",\"status\":\"沟通中\",\"jobId\":\"85915821\"}]}");
        List<JsonNode> jobs = service.jobList(account, Duration.ofMinutes(1));
        assertEquals(1, jobs.size());
        assertEquals("85915821", jobs.get(0).path("jobId").asText());
        String[] argv = captureArgs();
        assertEquals("joblist", argv[0]);
        assertTrue(Arrays.asList(argv).contains("--with-ids"), "必须带 --with-ids 保证 jobId 可得");
    }

    @Test
    void recommendReadsRecordsWithResumeId() throws Exception {
        stubOk("{\"extraction_status\":\"validated\",\"records\":[{\"name\":\"温女士\","
                + "\"expect_position\":\"海外销售\",\"resume_id\":\"eb75dde295fdSc7f903cb4428\"}]}");
        List<JsonNode> cands = service.recommend(account, "42", Duration.ofMinutes(1));
        assertEquals(1, cands.size());
        assertEquals("温女士", cands.get(0).path("name").asText());
        assertEquals("eb75dde295fdSc7f903cb4428", cands.get(0).path("resume_id").asText());
        String[] argv = captureArgs();
        assertTrue(Arrays.asList(argv).contains("--with-ids"), "必须带 --with-ids 保证 resume_id 可得");
    }

    @Test
    void searchReadsRecordsAndPassesWithIds() throws Exception {
        stubOk("{\"extraction_status\":\"validated\",\"records\":[{\"name\":\"温女士\","
                + "\"expect_position\":\"海外销售\",\"resume_id\":\"eb75dde295fdSc7f903cb4428\"}]}");
        List<JsonNode> cands = service.search(account, "海外销售", 20, Duration.ofMinutes(1));
        assertEquals(1, cands.size());
        assertEquals("温女士", cands.get(0).path("name").asText());
        String[] argv = captureArgs();
        assertEquals("search", argv[0]);
        List<String> list = Arrays.asList(argv);
        assertTrue(list.contains("海外销售") && list.contains("--with-ids"),
                "关键词位置参数 + --with-ids 保证 resume_id 可得");
    }

    @Test
    void nonArrayRecordsRejectedForJobList() throws Exception {
        stubOk("[]");
        assertThrows(BizException.class, () -> service.jobList(account, Duration.ofMinutes(1)));
    }

    @Test
    void riskControlSurfacesAndFreezesWithoutMarking() throws Exception {
        stubOk("{\"success\":true}");
        doThrow(new CliException(CliException.Type.RISK_CONTROL, "通道风控"))
                .when(cua).checkRisk(any(), any());

        CliException e = assertThrows(CliException.class,
                () -> service.greet(account, "r1", "42", "", Duration.ofMinutes(1)));
        assertEquals(CliException.Type.RISK_CONTROL, e.getType());
        // 首次命中仅冻结(不标记账号、不告警)
        verify(accounts, never()).updateById(any(LiepinAccount.class));
    }

    @Test
    void attachFetchPrefersImIdThenName() throws Exception {
        stubOk("{\"found\":false,\"success\":false,\"reason\":\"no-attachment\"}");
        service.attachFetch(account, "im-1", "温女士", "C:/tmp/out", Duration.ofMinutes(1));
        List<String> list1 = Arrays.asList(captureArgs());
        assertTrue(list1.contains("--imId") && list1.contains("im-1"), "有 im_id 时优先 --imId");

        reset(cua);
        stubOk("{\"found\":false,\"success\":false,\"reason\":\"no-attachment\"}");
        service.attachFetch(account, "", "温女士", "C:/tmp/out", Duration.ofMinutes(1));
        List<String> list2 = Arrays.asList(captureArgs());
        assertTrue(list2.contains("--name") && list2.contains("温女士"), "无 im_id 时按会话名定位(--name)");
    }

    @Test
    void attachFetchWithoutAnyKeyReturnsEmptyWithoutCall() throws Exception {
        Optional<JsonNode> r = service.attachFetch(account, "", "", "C:/tmp/out", Duration.ofMinutes(1));
        assertTrue(r.isEmpty(), "无键应空返回(不猜测)");
        verify(cua, never()).execute(any(), any(), any(String[].class));
    }
}
