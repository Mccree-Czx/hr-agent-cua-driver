package com.hragent.common;

import org.junit.jupiter.api.Test;
import org.springframework.http.HttpMethod;
import org.springframework.http.ResponseEntity;
import org.springframework.web.servlet.resource.NoResourceFoundException;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * 全局异常处理器(2026-09-28):静态资源缺失(前端构建哈希变更后旧缓存引用)应 404 而非 500+ERROR 刷屏。
 */
class GlobalExceptionHandlerTest {

    private final GlobalExceptionHandler handler = new GlobalExceptionHandler();

    @Test
    void missingStaticResourceReturns404() {
        ResponseEntity<ApiResponse<Void>> resp = handler.handleNotFound(
                new NoResourceFoundException(HttpMethod.GET, "assets/AccountList-x.js"));

        assertEquals(404, resp.getStatusCode().value());
        assertEquals(404, resp.getBody().getCode());
    }

    @Test
    void genericExceptionStillReturns500() {
        ResponseEntity<ApiResponse<Void>> resp = handler.handleOther(new RuntimeException("boom"));

        assertEquals(500, resp.getStatusCode().value());
        assertEquals(500, resp.getBody().getCode());
    }
}
