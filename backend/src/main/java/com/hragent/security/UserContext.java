package com.hragent.security;

public final class UserContext {

    private static final ThreadLocal<LoginUser> HOLDER = new ThreadLocal<>();

    private UserContext() {
    }

    public static void set(LoginUser user) {
        HOLDER.set(user);
    }

    public static LoginUser get() {
        return HOLDER.get();
    }

    public static void clear() {
        HOLDER.remove();
    }

    public static String currentUsername() {
        LoginUser u = HOLDER.get();
        return u == null ? "anonymous" : u.getUsername();
    }

    public static boolean isAdmin() {
        LoginUser u = HOLDER.get();
        return u != null && "ADMIN".equals(u.getRole());
    }
}
