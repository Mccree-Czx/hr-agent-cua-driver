package com.hragent.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.hragent.config.HrAgentProperties;
import com.hragent.entity.LiepinAccount;
import com.hragent.executor.CliException;
import com.hragent.executor.CliResult;
import com.hragent.executor.CuaCommandResolver;
import com.hragent.executor.CuaDriverExecutor;
import com.hragent.executor.LiepinCliExecutor;
import com.hragent.notify.NotifyService;
import com.hragent.repository.LiepinAccountMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.time.Duration;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.argThat;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 命令级路由测试(2026-09-29 W2):hr-agent.cua.commands.<命令>=ui 时该命令走 UI 通道,
 * 其余(默认)走 legacy CDP 通道;两条通道的风控检测与冻结-复测接线一致。
 */
class LiepinCommandServiceRoutingTest {

    private HrAgentProperties properties;
    private LiepinCliExecutor legacy;
    private CuaDriverExecutor cua;
    private LiepinAccountMapper accounts;
    private LiepinCommandService service;
    private LiepinAccount account;

    @BeforeEach
    void setUp() {
        properties = new HrAgentProperties();
        legacy = mock(LiepinCliExecutor.class);
        cua = mock(CuaDriverExecutor.class);
        accounts = mock(LiepinAccountMapper.class);
        service = new LiepinCommandService(legacy, accounts, mock(NotifyService.class),
                new RiskSuspectGuard(properties), cua, new CuaCommandResolver(properties));

        account = new LiepinAccount();
        account.setId(1L);
        account.setLoginStatus("NORMAL");
        account.setCircuitBreaker(false);
    }

    /** 让某命令路由到 UI 通道 */
    private void enableUi(String command) {
        properties.getCua().setEnabled(true);
        properties.getCua().getCommands().put(command, "ui");
        service = new LiepinCommandService(legacy, accounts, mock(NotifyService.class),
                new RiskSuspectGuard(properties), cua, new CuaCommandResolver(properties));
    }

    @Test
    void defaultRoutesGreetToLegacy() throws Exception {
        when(legacy.execute(any(), any(), any(String[].class)))
                .thenReturn(new CliResult(0, "{\"success\":true}", "", false));

        service.greet(account, "r1", "42", "", Duration.ofMinutes(1));

        ArgumentCaptor<String[]> captor = ArgumentCaptor.forClass(String[].class);
        verify(legacy, times(1)).execute(eq(account), any(), captor.capture());
        assertEquals("greet", captor.getValue()[0]);
        verify(cua, never()).execute(any(), any(), any(String[].class));
    }

    @Test
    void uiConfiguredRoutesGreetToCua() throws Exception {
        enableUi("greet");
        when(cua.execute(any(), any(), any(String[].class)))
                .thenReturn(new CliResult(0, "{\"success\":true}", "", false));

        service.greet(account, "r1", "42", "你好", Duration.ofMinutes(1));

        ArgumentCaptor<String[]> captor = ArgumentCaptor.forClass(String[].class);
        verify(cua, times(1)).execute(eq(account), any(), captor.capture());
        assertEquals("greet", captor.getValue()[0]);
        verify(cua, times(1)).checkRisk(eq(account), any());
        verify(legacy, never()).execute(any(), any(), any(String[].class));
        verify(legacy, never()).checkRisk(any(), any());
    }

    @Test
    void uiConfiguredRoutesRequestResumeToCua() throws Exception {
        enableUi("request-resume");
        when(cua.execute(any(), any(), any(String[].class)))
                .thenReturn(new CliResult(0, "{\"success\":true,\"confirmed\":true}", "", false));

        service.requestResume(account, "r1", "im-9", Duration.ofMinutes(1));

        ArgumentCaptor<String[]> captor = ArgumentCaptor.forClass(String[].class);
        verify(cua, times(1)).execute(eq(account), any(), captor.capture());
        assertEquals("request-resume", captor.getValue()[0]);
        verify(legacy, never()).execute(any(), any(), any(String[].class));
    }

    @Test
    void otherCommandsStayLegacyWhenOnlyGreetIsUi() throws Exception {
        enableUi("greet");
        when(legacy.execute(any(), any(), any(String[].class)))
                .thenReturn(new CliResult(0, "[]", "", false));

        service.chatlist(account, Duration.ofMinutes(1));

        ArgumentCaptor<String[]> captor = ArgumentCaptor.forClass(String[].class);
        verify(legacy, times(1)).execute(eq(account), any(), captor.capture());
        assertEquals("chatlist", captor.getValue()[0]);
        verify(cua, never()).execute(any(), any(), any(String[].class));
    }

    @Test
    void uiChannelRiskControlSurfacesAndFreezesWithoutMarking() throws Exception {
        enableUi("greet");
        when(cua.execute(any(), any(), any(String[].class)))
                .thenReturn(new CliResult(0, "{\"success\":true}", "", false));
        doThrow(new CliException(CliException.Type.RISK_CONTROL, "UI 通道风控"))
                .when(cua).checkRisk(any(), any());

        CliException e = assertThrows(CliException.class,
                () -> service.greet(account, "r1", "42", "", Duration.ofMinutes(1)));
        assertEquals(CliException.Type.RISK_CONTROL, e.getType());
        // 首次命中仅冻结(不标记账号、不告警)——与 legacy 通道语义一致
        verify(accounts, never()).updateById(any(LiepinAccount.class));
        verify(legacy, never()).checkRisk(any(), any());
    }

    @Test
    void uiJobListReadsRecordsAndPassesWithIds() throws Exception {
        enableUi("joblist");
        when(cua.execute(any(), any(), any(String[].class)))
                .thenReturn(new CliResult(0,
                        "{\"extraction_status\":\"validated\",\"records\":[{\"title\":\"销售经理\",\"city\":\"上海-黄浦区\",\"salary\":\"15-30k\",\"status\":\"沟通中\",\"jobId\":\"85915821\"}]}",
                        "", false));

        List<JsonNode> jobs = service.jobList(account, Duration.ofMinutes(1));

        assertEquals(1, jobs.size());
        assertEquals("85915821", jobs.get(0).path("jobId").asText());
        assertEquals("销售经理", jobs.get(0).path("title").asText());
        ArgumentCaptor<String[]> captor = ArgumentCaptor.forClass(String[].class);
        verify(cua, times(1)).execute(eq(account), any(), captor.capture());
        assertEquals("joblist", captor.getValue()[0]);
        assertTrue(java.util.Arrays.asList(captor.getValue()).contains("--with-ids"),
                "UI 通道必须带 --with-ids 保证 jobId 可得");
        verify(legacy, never()).execute(any(), any(), any(String[].class));
    }

    @Test
    void legacyJobListStaysArrayOutput() throws Exception {
        when(legacy.execute(any(), any(), any(String[].class)))
                .thenReturn(new CliResult(0, "[{\"jobId\":\"1\",\"title\":\"T\"}]", "", false));

        List<JsonNode> jobs = service.jobList(account, Duration.ofMinutes(1));

        assertEquals(1, jobs.size());
        assertEquals("1", jobs.get(0).path("jobId").asText());
        verify(cua, never()).execute(any(), any(), any(String[].class));
    }

    @Test
    void uiRecommendReadsRecordsWithResumeId() throws Exception {
        enableUi("recommend");
        when(cua.execute(any(), any(), any(String[].class)))
                .thenReturn(new CliResult(0,
                        "{\"extraction_status\":\"validated\",\"records\":[{\"name\":\"温女士\",\"expect_position\":\"海外销售\",\"resume_id\":\"eb75dde295fdSc7f903cb4428\"}]}",
                        "", false));

        List<JsonNode> cands = service.recommend(account, "42", Duration.ofMinutes(1));

        assertEquals(1, cands.size());
        assertEquals("温女士", cands.get(0).path("name").asText());
        assertEquals("eb75dde295fdSc7f903cb4428", cands.get(0).path("resume_id").asText());
        ArgumentCaptor<String[]> captor = ArgumentCaptor.forClass(String[].class);
        verify(cua, times(1)).execute(eq(account), any(), captor.capture());
        assertTrue(java.util.Arrays.asList(captor.getValue()).contains("--with-ids"),
                "UI 通道必须带 --with-ids 保证 resume_id 可得");
        verify(legacy, never()).execute(any(), any(), any(String[].class));
    }
}
