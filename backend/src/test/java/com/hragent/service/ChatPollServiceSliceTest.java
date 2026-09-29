package com.hragent.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.hragent.config.HrAgentProperties;
import com.hragent.entity.LiepinAccount;
import com.hragent.executor.CliException;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.when;

/**
 * {@link ChatPollService} 节拍循环入口测试(2026-09-28 平摊改造):
 * fetchSessions 委托 chatlist(重试后失败返回 null);handleSession 对账号级异常上抛、其余失败吞掉。
 */
@SpringBootTest
@ActiveProfiles("test")
@Transactional
class ChatPollServiceSliceTest {

    @Autowired
    private ChatPollService chatPollService;

    @Autowired
    private HrAgentProperties properties;

    @MockitoBean
    private LiepinCommandService commandService;

    @MockitoBean
    private AccountPaceGuard paceGuard;

    private final ObjectMapper mapper = new ObjectMapper();

    private LiepinAccount account;

    @BeforeEach
    void setUp() {
        account = new LiepinAccount();
        account.setId(1L);
        account.setName("测试账号");
        account.setLoginStatus("NORMAL");
    }

    private JsonNode session(String imId) throws Exception {
        return mapper.readTree("{\"im_id\":\"" + imId + "\",\"direction\":\"1\",\"name\":\"张三\"}");
    }

    @Test
    void fetchSessionsDelegatesToChatlist() throws Exception {
        when(commandService.chatlist(any(), any())).thenReturn(List.of(session("im-a"), session("im-b")));

        List<JsonNode> sessions = chatPollService.fetchSessions(account);

        assertEquals(2, sessions.size());
    }

    @Test
    void fetchSessionsReturnsNullAfterRetriesFail() {
        int oldDelay = properties.getAutoRecruit().getPollRetryDelayMillis();
        try {
            properties.getAutoRecruit().setPollRetryDelayMillis(1);
            when(commandService.chatlist(any(), any()))
                    .thenThrow(new CliException(CliException.Type.FAILED, "页面级挂起"));

            assertNull(chatPollService.fetchSessions(account), "非账号级失败重试一次后返回 null(调用方跳过本次刷新)");
        } finally {
            properties.getAutoRecruit().setPollRetryDelayMillis(oldDelay);
        }
    }

    @Test
    void handleSessionRethrowsRiskControl() throws Exception {
        when(commandService.chatmsg(any(), eq("im-risk"), any()))
                .thenThrow(new CliException(CliException.Type.RISK_CONTROL, "安全验证"));

        assertThrows(CliException.class, () -> chatPollService.handleSession(account, session("im-risk")),
                "风控异常应上抛(由轮次冻结-复测策略处理)");
    }

    @Test
    void handleSessionSwallowsNonAccountFailure() throws Exception {
        when(commandService.chatmsg(any(), eq("im-bad"), any()))
                .thenThrow(new CliException(CliException.Type.FAILED, "单会话失败"));

        assertFalse(chatPollService.handleSession(account, session("im-bad")),
                "单会话失败只记日志,不影响其余会话");
    }
}
