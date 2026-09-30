package com.hragent.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.hragent.common.BizException;
import com.hragent.entity.LiepinAccount;
import com.hragent.executor.CliException;
import com.hragent.executor.CliResult;
import com.hragent.executor.CuaDriverExecutor;
import com.hragent.executor.JsonExtractor;
import com.hragent.notify.NotifyService;
import com.hragent.repository.LiepinAccountMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

/**
 * 猎聘平台命令语义封装:由 cua-liepin-driver(UI 通道)执行全部平台操作,
 * 把驱动细节(参数顺序、--json、输出解析)收敛在此,上层业务只与 JsonNode 打交道。
 *
 * <p>2026-09-30 全量替换定稿:liepin-cli(legacy CDP 通道)已彻底移除,
 * 本服务直走 CUA UI 通道(风控链路不变)。
 *
 * 风控/登录态异常会同步标记账号状态(熔断/需扫码),评审 P0-3。
 */
@Slf4j
@Service
public class LiepinCommandService {

    private final CuaDriverExecutor cuaDriverExecutor;
    private final LiepinAccountMapper accountMapper;
    private final NotifyService notifyService;
    private final RiskSuspectGuard riskSuspectGuard;

    public LiepinCommandService(CuaDriverExecutor cuaDriverExecutor, LiepinAccountMapper accountMapper,
                                NotifyService notifyService, RiskSuspectGuard riskSuspectGuard) {
        this.cuaDriverExecutor = cuaDriverExecutor;
        this.accountMapper = accountMapper;
        this.notifyService = notifyService;
        this.riskSuspectGuard = riskSuspectGuard;
    }

    /** 搜索人才 → 候选人数组(UI 通道:搜索页 records;--with-ids 逐卡穿透取 resume_id) */
    public List<JsonNode> search(LiepinAccount account, String keywords, int limit, Duration timeout) {
        CliResult result = run(account, timeout, "search", keywords, "--with-ids", "--json");
        JsonNode node = JsonExtractor.parse(result.stdout())
                .orElseThrow(() -> BizException.badRequest("搜索输出无有效 JSON"));
        JsonNode rows = node.path("records");
        if (!rows.isArray()) {
            throw BizException.badRequest("搜索(UI)输出缺少 records 数组");
        }
        List<JsonNode> list = new ArrayList<>();
        rows.forEach(list::add);
        return list;
    }

    /** 简历详情 → 对象 */
    public Optional<JsonNode> resume(LiepinAccount account, String resumeId, Duration timeout) {
        CliResult result = run(account, timeout, "resume", resumeId, "--json");
        return JsonExtractor.parse(result.stdout());
    }

    /**
     * 平台推荐候选人 → 数组(依赖猎聘上已发布的职位)。
     * UI 通道输出 {records:[{name,age,expect_position,...,resume_id?}],...};
     * --with-ids 逐卡穿透保证 resume_id 可得(评分链依赖其落库触发详情补齐)。
     */
    public List<JsonNode> recommend(LiepinAccount account, String jobId, Duration timeout) {
        if (jobId == null || !jobId.matches("[1-9][0-9]*")) {
            throw BizException.badRequest("推荐必须指定有效的猎聘岗位 ID");
        }
        CliResult result = run(account, timeout, "recommend", "--jobId", jobId, "--with-ids", "--json");
        JsonNode node = JsonExtractor.parse(result.stdout())
                .orElseThrow(() -> BizException.badRequest("recommend 输出无有效 JSON"));
        JsonNode rows = node.path("records");
        if (!rows.isArray()) {
            throw BizException.badRequest("recommend(UI)输出缺少 records 数组");
        }
        List<JsonNode> list = new ArrayList<>();
        rows.forEach(list::add);
        return list;
    }

    /** 发布职位到猎聘(fork 版 CLI 的 jobpublish 命令,草稿→正式上线) */
    public Optional<JsonNode> jobPublish(LiepinAccount account, String dataJson, Duration timeout) {
        CliResult result = run(account, timeout, "jobpublish", "--data", dataJson, "--json");
        return JsonExtractor.parse(result.stdout());
    }

    /**
     * 猎聘职位列表(招聘者端,用于同步到系统岗位管理)。
     * UI 通道输出 {records:[{title,city,salary,status,refreshed_at,jobId?}],...},
     * 本方法读 records;--with-ids 逐行穿透保证 jobId 可得(下游同步/复核依赖)。
     */
    public List<JsonNode> jobList(LiepinAccount account, Duration timeout) {
        CliResult result = run(account, timeout, "joblist", "--with-ids", "--json");
        JsonNode node = JsonExtractor.parse(result.stdout())
                .orElseThrow(() -> BizException.badRequest("joblist 输出无有效 JSON"));
        JsonNode rows = node.path("records");
        if (!rows.isArray()) {
            throw BizException.badRequest("joblist(UI)输出缺少 records 数组");
        }
        List<JsonNode> list = new ArrayList<>();
        rows.forEach(list::add);
        return list;
    }

    /** 删除猎聘职位(fork 版 CLI 的 jobdelete 命令:自动先结束发布再删除) */
    public Optional<JsonNode> jobDelete(LiepinAccount account, String jobId, Duration timeout) {
        CliResult result = run(account, timeout, "jobdelete", "--job", jobId, "--json");
        return JsonExtractor.parse(result.stdout());
    }

    /**
     * 聊天列表 → 数组(同意/已读状态检测依据)。
     * UI 通道固定拉取当前渲染的会话列表条目(无分页参数)。
     */
    public List<JsonNode> chatlist(LiepinAccount account, Duration timeout) {
        CliResult result = run(account, timeout, "chatlist", "--json");
        JsonNode node = JsonExtractor.parse(result.stdout())
                .orElseThrow(() -> BizException.badRequest("chatlist 输出无有效 JSON"));
        if (!node.isArray()) {
            throw BizException.badRequest("chatlist 输出不是数组");
        }
        List<JsonNode> list = new ArrayList<>();
        node.forEach(list::add);
        return list;
    }

    /**
     * 单人会话消息 → 数组(来信轮询用)。
     * 入参是<b>对方 im_id</b>(chatlist 返回的 im_id),不是 resume_id;消息字段含 type/payload.bodies。
     */
    public List<JsonNode> chatmsg(LiepinAccount account, String imId, Duration timeout) {
        if (imId == null || imId.isBlank()) {
            throw BizException.badRequest("chatmsg 必须提供对方 im_id");
        }
        CliResult result = run(account, timeout, "chatmsg", imId, "--json");
        JsonNode node = JsonExtractor.parse(result.stdout())
                .orElseThrow(() -> BizException.badRequest("chatmsg 输出无有效 JSON"));
        if (!node.isArray()) {
            throw BizException.badRequest("chatmsg 输出不是数组: " + truncate(result.stdout()));
        }
        List<JsonNode> list = new ArrayList<>();
        node.forEach(list::add);
        return list;
    }

    /**
     * 下载指定会话的简历附件(走浏览器下载通道 + PDF 校验)。
     * 输出 {@code {success,file,bytes,sha256,sourceOrigin}};失败时 CLI 非零退出并由 {@link #run} 抛出
     * {@link CliException}(由上层留待下轮重试,不为其写半状态)。
     */
    public Optional<JsonNode> attachDownload(LiepinAccount account, String imId, String outDir, Duration timeout) {
        if (imId == null || imId.isBlank()) {
            throw BizException.badRequest("attach-download 必须提供会话 im_id");
        }
        if (outDir == null || outDir.isBlank()) {
            throw BizException.badRequest("attach-download 必须提供下载目录");
        }
        CliResult result = run(account, timeout, "attach-download",
                "--imId", imId, "--out", outDir, "--json");
        return JsonExtractor.parse(result.stdout());
    }

    /**
     * 获取简历附件(UI 会话名键)。
     * 优先 --imId;无 im_id 时用 --name <会话名>(会话名键,自动导航 /chat/im 点开会话);
     * 输出三态 JSON:{found:false,reason:no-attachment} / {found:true,success:false,reason} / 成功含 file/bytes/sha256/fileName。
     */
    public Optional<JsonNode> attachFetch(LiepinAccount account, String imId, String sessionName,
                                          String outDir, Duration timeout) {
        if (outDir == null || outDir.isBlank()) {
            throw BizException.badRequest("attach-fetch 必须提供下载目录");
        }
        CliResult result;
        if (imId != null && !imId.isBlank()) {
            result = run(account, timeout, "attach-fetch",
                    "--imId", imId, "--out", outDir, "--json");
        } else if (sessionName != null && !sessionName.isBlank()) {
            result = run(account, timeout, "attach-fetch",
                    "--name", sessionName, "--out", outDir, "--json");
        } else {
            return Optional.empty(); // 无键不猜测
        }
        return JsonExtractor.parse(result.stdout());
    }

    /**
     * 打招呼 → 输出对象(含 success 标记)。
     * ejobId 必传:猎聘发起沟通必须挂在具体职位下,缺省时 CLI 会回退到账号第一个职位(导致错配)。
     * message 用 --message 传递(位置参数只能被 CLI 识别首个)。
     */
    public Optional<JsonNode> greet(LiepinAccount account, String resumeId, String ejobId,
                                    String message, Duration timeout) {
        CliResult result = run(account, timeout, "greet", resumeId,
                "--ejobId", ejobId, "--message", message, "--json");
        return JsonExtractor.parse(result.stdout());
    }

    /** 索要简历(需先 greet 建立会话)→ 输出对象。对方 im_id 由候选人快照注入(索要走 askfor 接口必需:
     *  实测 resume-view 响应不含任何 im 字段) */
    public Optional<JsonNode> requestResume(LiepinAccount account, String resumeId, String oppositeImId, Duration timeout) {
        if (resumeId == null || resumeId.isBlank()) {
            throw BizException.badRequest("索要简历必须提供 resume_id，不能使用 im_id");
        }
        CliResult result = (oppositeImId == null || oppositeImId.isBlank())
                ? run(account, timeout, "request-resume", resumeId, "--json")
                : run(account, timeout, "request-resume", resumeId, "--imId", oppositeImId, "--json");
        return JsonExtractor.parse(result.stdout());
    }

    private CliResult run(LiepinAccount account, Duration timeout, String... args) {
        // 2026-09-30 全量替换:UI 通道为唯一执行路径(liepin-cli/legacy 已移除)
        CliResult result;
        try {
            result = cuaDriverExecutor.execute(account, timeout, args);
        } catch (IOException e) {
            throw new CliException(CliException.Type.FAILED,
                    "cua-liepin-driver 启动失败(可执行文件/脚本路径不存在?): " + e.getMessage(), e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new CliException(CliException.Type.FAILED, "执行被中断", e);
        }

        try {
            cuaDriverExecutor.checkRisk(account, result);
        } catch (CliException e) {
            markAccountByException(account, e);
            throw e;
        }
        // 操作成功:若处于"冻结解除待复测"阶段,视为复测通过并清零状态(2026-09-28 节拍改造)
        riskSuspectGuard.onOpSuccess(account.getId());
        return result;
    }

    /** 异常类型 → 账号状态标记(风控类接入 RiskSuspectGuard:首次命中冻结退避、复测再中才熔断) */
    private void markAccountByException(LiepinAccount account, CliException e) {
        boolean changed = false;
        switch (e.getType()) {
            case RISK_CONTROL -> {
                if (riskSuspectGuard.onRiskHit(account.getId())) {
                    // 真实熔断(复测再次命中/退避关闭):沿用既有标记+告警链路
                    if (!Boolean.TRUE.equals(account.getCircuitBreaker())
                            || !"RESTRICTED".equals(account.getLoginStatus())) {
                        account.setCircuitBreaker(true);
                        account.setLoginStatus("RESTRICTED");
                        changed = true;
                    }
                    log.warn("账号 {} 触发熔断: {}", account.getId(), e.getMessage());
                    notifyService.alert("账号触发风控熔断",
                            "账号: " + account.getName() + "(id=" + account.getId() + ")\n"
                                    + "原因: " + e.getMessage() + "\n处理: 停用该账号所有任务,人工确认后重置熔断标记");
                } else {
                    // 首次命中:仅冻结退避(全平台操作暂停),等待到期复测;不标记账号、不告警
                    log.warn("账号 {} 疑似风控拦截,冻结退避至 {}: {}",
                            account.getId(), riskSuspectGuard.holdUntil(account.getId()), e.getMessage());
                }
            }
            case NOT_LOGGED_IN -> {
                if (!"NEED_SCAN".equals(account.getLoginStatus())) {
                    account.setLoginStatus("NEED_SCAN");
                    changed = true;
                }
                log.warn("账号 {} 登录态失效,需扫码: {}", account.getId(), e.getMessage());
                notifyService.alert("账号登录态失效",
                        "账号: " + account.getName() + "(id=" + account.getId() + ")\n请在后台点击扫码登录");
            }
            case TIMEOUT, FAILED -> {
                // 可重试类错误,不标记账号状态
            }
        }
        if (changed) {
            accountMapper.updateById(account);
        }
    }

    private String truncate(String s) {
        return s == null || s.length() <= 200 ? s : s.substring(0, 200) + "...";
    }
}
