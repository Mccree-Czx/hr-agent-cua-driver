package com.hragent.executor;

import lombok.Getter;

/** CLI 调用异常,按类型区分处理策略 */
@Getter
public class CliException extends RuntimeException {

    public enum Type {
        /** 超时 */
        TIMEOUT,
        /** 风控拦截(403/captcha/验证页等)→ 账号熔断 */
        RISK_CONTROL,
        /** 未登录 / 登录态失效 → 账号需扫码 */
        NOT_LOGGED_IN,
        /** 其他错误 */
        FAILED
    }

    private final Type type;

    public CliException(Type type, String message) {
        super(message);
        this.type = type;
    }

    public CliException(Type type, String message, Throwable cause) {
        super(message, cause);
        this.type = type;
    }
}
