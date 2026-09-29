package com.hragent.notify;

import com.hragent.config.HrAgentProperties;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestTemplate;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.HashMap;
import java.util.Map;

/**
 * 告警通知(评审 P2-14):飞书自定义机器人 webhook(支持签名校验)。
 * 未配置 webhook 时静默降级(仅日志)。
 * 接入点:任务终态失败、账号熔断/登录态失效、配额用尽。
 */
@Slf4j
@Service
public class NotifyService {

    private final HrAgentProperties properties;
    private final RestTemplate restTemplate = new RestTemplate();

    public NotifyService(HrAgentProperties properties) {
        this.properties = properties;
    }

    /** 发送告警;webhook 未配置则仅记录日志 */
    public void alert(String title, String content) {
        String webhook = properties.getNotify().getFeishuWebhook();
        log.warn("[ALERT] {}: {}", title, content);
        if (webhook == null || webhook.isBlank()) {
            return;
        }
        try {
            Map<String, Object> message = new HashMap<>();
            message.put("msg_type", "text");
            message.put("content", Map.of("text", "【HR Agent】" + title + "\n" + content));

            String secret = properties.getNotify().getFeishuSecret();
            if (secret != null && !secret.isBlank()) {
                long timestamp = System.currentTimeMillis() / 1000;
                message.put("timestamp", String.valueOf(timestamp));
                message.put("sign", sign(secret, timestamp));
            }

            HttpHeaders headers = new HttpHeaders();
            headers.setContentType(MediaType.APPLICATION_JSON);
            restTemplate.postForEntity(webhook, new HttpEntity<>(message, headers), String.class);
        } catch (Exception e) {
            log.error("飞书告警发送失败: {}", e.getMessage());
        }
    }

    /** 飞书加签:Base64(HmacSHA256(timestamp + "\\n" + secret, secret)) */
    private String sign(String secret, long timestamp) throws Exception {
        String stringToSign = timestamp + "\n" + secret;
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(stringToSign.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        return Base64.getEncoder().encodeToString(mac.doFinal());
    }
}
