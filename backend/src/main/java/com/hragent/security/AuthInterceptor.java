package com.hragent.security;

import com.hragent.common.BizException;
import com.hragent.config.HrAgentProperties;
import io.jsonwebtoken.Claims;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.stereotype.Component;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.servlet.HandlerInterceptor;

@Component
public class AuthInterceptor implements HandlerInterceptor {

    private final JwtUtil jwtUtil;
    private final HrAgentProperties properties;

    public AuthInterceptor(JwtUtil jwtUtil, HrAgentProperties properties) {
        this.jwtUtil = jwtUtil;
        this.properties = properties;
    }

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) {
        String uri = request.getRequestURI();

        if (properties.getAuth().getWhitelist().contains(uri)
                || "OPTIONS".equalsIgnoreCase(request.getMethod())) {
            return true;
        }

        String header = request.getHeader("Authorization");
        if (header == null || !header.startsWith("Bearer ")) {
            throw BizException.unauthorized("未登录或登录已过期");
        }

        Claims claims;
        try {
            claims = jwtUtil.parse(header.substring(7));
        } catch (Exception e) {
            throw BizException.unauthorized("未登录或登录已过期");
        }

        LoginUser user = new LoginUser(
                Long.valueOf(claims.getSubject()),
                claims.get("username", String.class),
                claims.get("role", String.class));
        UserContext.set(user);

        if (handler instanceof HandlerMethod hm) {
            RequireRole requireRole = hm.getMethodAnnotation(RequireRole.class);
            if (requireRole == null) {
                requireRole = hm.getBeanType().getAnnotation(RequireRole.class);
            }
            if (requireRole != null && !requireRole.value().equals(user.getRole())) {
                throw BizException.forbidden("无权限执行该操作");
            }
        }
        return true;
    }

    @Override
    public void afterCompletion(HttpServletRequest request, HttpServletResponse response, Object handler, Exception ex) {
        UserContext.clear();
    }
}
