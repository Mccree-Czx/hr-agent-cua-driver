package com.hragent.executor;

import com.hragent.entity.LiepinAccount;

import java.util.List;

/**
 * 子进程输出风控/登录态检测(评审 P0-3;2026-09-28 双档治理;2026-09-29 W1 抽出共享)。
 *
 * <p>两条通道(LiepinCliExecutor 的 CDP 通道、CuaDriverExecutor 的 UI 通道)
 * 共用同一检测语义,避免各写一份漂移:
 * <ul>
 *     <li><b>结构性标记</b>({@code captchaPage}/{@code safe.liepin.com})全路径扫描
 *         —— 不会出现在正常业务数据里(候选人简历等);</li>
 *     <li><b>泛词/中文短语</b>(verify、安全验证 等)仅在失败/超时路径扫描
 *         —— 成功路径的 stdout 是业务数据,误命中会让账号误熔断(2026-09-27/28 两次实测);</li>
 *     <li>退出码契约显式映射:3=风控、2=登录态失效(两条 CLI 均遵循 0/1/2/3);</li>
 *     <li>其余非零退出 → FAILED,超时 → TIMEOUT。</li>
 * </ul>
 */
public final class CliRiskDetector {

    /** 风控拦截的结构性标记(成功/失败全路径扫描) */
    static final List<String> RISK_KEYWORDS = List.of(
            "captchaPage", "safe.liepin.com");

    /** 风控短语:仅在命令失败/超时路径扫描(成功时 stdout 是业务数据,防误熔断) */
    static final List<String> RISK_KEYWORDS_FAILURE_ONLY = List.of(
            "行为异常", "安全验证", "滑块验证", "captcha", "verify", "security-check", "forbidden");

    /** 登录态失效特征 */
    static final List<String> NOT_LOGGED_KEYWORDS = List.of(
            "未登录", "请先登录", "登录已过期", "need login", "登录页");

    private CliRiskDetector() {
    }

    /** 检测输出中的风控/登录态特征;风控优先(风控页往往同时含登录提示) */
    public static void check(LiepinAccount account, CliResult result) {
        String output = result.combined().toLowerCase();
        for (String kw : RISK_KEYWORDS) {
            if (output.contains(kw.toLowerCase())) {
                throw new CliException(CliException.Type.RISK_CONTROL,
                        "检测到风控拦截特征 [" + kw + "](account=" + account.getId() + ")");
            }
        }
        if (result.timedOut() || result.exitCode() != 0) {
            for (String kw : RISK_KEYWORDS_FAILURE_ONLY) {
                if (output.contains(kw.toLowerCase())) {
                    throw new CliException(CliException.Type.RISK_CONTROL,
                            "检测到风控拦截特征 [" + kw + "](account=" + account.getId() + ")");
                }
            }
        }
        for (String kw : NOT_LOGGED_KEYWORDS) {
            if (output.contains(kw.toLowerCase())) {
                throw new CliException(CliException.Type.NOT_LOGGED_IN,
                        "检测到登录态失效特征 [" + kw + "](account=" + account.getId() + ")");
            }
        }
        if (result.timedOut()) {
            throw new CliException(CliException.Type.TIMEOUT,
                    "liepin-cli 执行超时(account=" + account.getId() + ")");
        }
        // 退出码契约(0/1/2/3):2=登录态失效、3=风控,其余非零=一般失败
        if (result.exitCode() == 3) {
            throw new CliException(CliException.Type.RISK_CONTROL,
                    "子进程以风控退出码结束(account=" + account.getId() + ")");
        }
        if (result.exitCode() == 2) {
            throw new CliException(CliException.Type.NOT_LOGGED_IN,
                    "子进程以登录态失效退出码结束(account=" + account.getId() + ")");
        }
        if (result.exitCode() != 0) {
            throw new CliException(CliException.Type.FAILED,
                    "子进程非零退出 code=" + result.exitCode()
                            + "(account=" + account.getId() + "): " + truncate(result.combined(), 500));
        }
    }

    static String truncate(String s, int max) {
        return s == null || s.length() <= max ? s : s.substring(0, max) + "...";
    }
}
