package com.hragent.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.hragent.common.BizException;
import com.hragent.entity.Jd;
import com.hragent.entity.LiepinAccount;
import com.hragent.repository.JdMapper;
import com.hragent.repository.LiepinAccountMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * JD 发布到猎聘:
 * - 系统 JD → jobpublish 命令数据 → fork 版 CLI(草稿→正式上线)→ 回写 liepin_job_id
 * - 发布是公开不可逆动作:前端二次确认 + 同一 JD 仅允许发布一次(已发布拒绝)
 * - 删除岗位时同步删除猎聘职位(先删猎聘成功后再删系统记录,保证状态一致)
 */
@Slf4j
@Service
public class JdPublishService {

    /** 学历文本 → 猎聘编码(已知 040=本科;其他 3 位数字编码可直接透传) */
    private static final Map<String, String> DEGREE_CODE = Map.of(
            "本科", "040",
            "学士", "040");

    private static final Pattern EXPERIENCE_PATTERN =
            Pattern.compile("(\\d+)\\s*[-~至]\\s*(\\d+)");

    private final JdMapper jdMapper;
    private final LiepinAccountMapper accountMapper;
    private final LiepinCommandService commandService;
    private final ObjectMapper objectMapper = new ObjectMapper();
    /** 正在删除中的岗位(轻量互斥,防连点/并发重复删除) */
    private final Set<Long> deletingJds = ConcurrentHashMap.newKeySet();

    public JdPublishService(JdMapper jdMapper, LiepinAccountMapper accountMapper,
                            LiepinCommandService commandService) {
        this.jdMapper = jdMapper;
        this.accountMapper = accountMapper;
        this.commandService = commandService;
    }

    public Jd publish(Long jdId) {
        Jd jd = jdMapper.selectById(jdId);
        if (jd == null) {
            throw BizException.notFound("岗位不存在");
        }
        if ("PUBLISHED".equals(jd.getPublishStatus())) {
            throw BizException.badRequest("该岗位已发布到猎聘(职位ID: " + jd.getLiepinJobId() + "),不可重复发布");
        }
        if ("PUBLISHING".equals(jd.getPublishStatus())) {
            throw BizException.badRequest("该岗位正在发布中,请稍后");
        }
        validate(jd);

        LiepinAccount account = accountMapper.selectOne(new LambdaQueryWrapper<LiepinAccount>()
                .eq(LiepinAccount::getLoginStatus, "NORMAL")
                .orderByAsc(LiepinAccount::getId)
                .last("LIMIT 1"));
        if (account == null) {
            throw BizException.badRequest("无可用猎聘账号(NORMAL)");
        }

        // 置为发布中(防重入)
        jd.setPublishStatus("PUBLISHING");
        jd.setPublishError(null);
        jdMapper.updateById(jd);

        try {
            String dataJson = buildDataJson(jd);
            Optional<JsonNode> result = commandService.jobPublish(account, dataJson,
                    Duration.ofMinutes(5));
            JsonNode node = result.orElseThrow(
                    () -> new IllegalStateException("jobpublish 无有效 JSON 输出"));

            if (!node.path("success").asBoolean(false)) {
                throw new IllegalStateException("发布失败: " + node.path("message").asText("未知原因"));
            }
            jd.setPublishStatus("PUBLISHED");
            jd.setLiepinJobId(node.path("job_id").asText(""));
            jd.setPublishError(null);
            jdMapper.updateById(jd);
            log.info("岗位「{}」已发布到猎聘,职位ID: {}", jd.getTitle(), jd.getLiepinJobId());
            return jd;
        } catch (Exception e) {
            jd.setPublishStatus("FAILED");
            String msg = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
            jd.setPublishError(msg.length() > 480 ? msg.substring(0, 480) : msg);
            jdMapper.updateById(jd);
            log.error("岗位「{}」发布失败: {}", jd.getTitle(), msg);
            throw BizException.badRequest("发布失败: " + msg);
        }
    }

    /** 删除岗位:有关联猎聘职位时先删猎聘,成功后删系统记录;失败保留系统记录 */
    public void deleteWithSync(Long jdId) {
        if (!deletingJds.add(jdId)) {
            throw BizException.badRequest("该岗位正在删除中,请稍后");
        }
        try {
            doDeleteWithSync(jdId);
        } finally {
            deletingJds.remove(jdId);
        }
    }

    private void doDeleteWithSync(Long jdId) {
        Jd jd = jdMapper.selectById(jdId);
        if (jd == null) {
            throw BizException.notFound("岗位不存在");
        }
        String jobId = jd.getLiepinJobId();
        if (jobId != null && !jobId.isBlank()) {
            LiepinAccount account = accountMapper.selectOne(new LambdaQueryWrapper<LiepinAccount>()
                    .eq(LiepinAccount::getLoginStatus, "NORMAL")
                    .orderByAsc(LiepinAccount::getId)
                    .last("LIMIT 1"));
            if (account == null) {
                throw BizException.badRequest("无可用猎聘账号(NORMAL),无法同步删除猎聘职位");
            }

            boolean deleted = false;
            String error = null;
            try {
                Optional<JsonNode> result = commandService.jobDelete(account, jobId, Duration.ofMinutes(3));
                JsonNode node = result.orElseThrow(
                        () -> new IllegalStateException("jobdelete 无有效 JSON 输出"));
                if (node.path("success").asBoolean(false)) {
                    deleted = true;
                } else {
                    error = node.path("message").asText("未知原因");
                }
            } catch (Exception e) {
                error = e.getMessage();
            }

            if (!deleted) {
                // 复核机制:删除命令报错时(如风控特征误判),查猎聘实际状态;已不存在则视为删除成功
                if (confirmDeletedOnLiepin(account, jobId)) {
                    log.warn("删除命令报错({})但复核确认猎聘职位 {} 已不存在,视为删除成功", error, jobId);
                    deleted = true;
                }
            }
            if (!deleted) {
                throw BizException.badRequest("猎聘职位删除失败: " + error + ",系统记录已保留");
            }
            log.info("猎聘职位 {} 已删除(随岗位「{}」同步删除)", jobId, jd.getTitle());
        }
        jdMapper.deleteById(jdId);
        log.info("岗位「{}」(id={}) 已删除", jd.getTitle(), jdId);
    }

    /** 复核:目标职位是否已不在猎聘列表(不存在 → 删除已完成);复核失败一律返回 false(保守) */
    private boolean confirmDeletedOnLiepin(LiepinAccount account, String jobId) {
        try {
            List<JsonNode> jobs = commandService.jobList(account, Duration.ofMinutes(2));
            return jobs.stream().noneMatch(j -> jobId.equals(j.path("jobId").asText("")));
        } catch (Exception e) {
            log.warn("猎聘职位复核失败(维持保留): {}", e.getMessage());
            return false;
        }
    }

    private void validate(Jd jd) {
        if (jd.getTitle() == null || jd.getTitle().isBlank()) {
            throw BizException.badRequest("岗位名称缺失");
        }
        if (jd.getJobCategory() == null || jd.getJobCategory().isBlank()) {
            throw BizException.badRequest("猎聘职位类别编码缺失(如 N000330),请在岗位编辑中填写");
        }
        if (jd.getExternalJd() == null || jd.getExternalJd().isBlank()) {
            throw BizException.badRequest("对外 JD 描述缺失(发布需要职位描述)");
        }
        if (jd.getSalaryMin() == null || jd.getSalaryMax() == null) {
            throw BizException.badRequest("薪资范围缺失(发布需要薪资)");
        }
    }

    /** 组装 jobpublish --data 的 JSON */
    String buildDataJson(Jd jd) {
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("title", jd.getTitle());
        data.put("jobCategory", jd.getJobCategory());
        data.put("description", jd.getExternalJd());
        data.put("salaryMinK", jd.getSalaryMin() / 1000);
        data.put("salaryMaxK", jd.getSalaryMax() / 1000);
        data.put("salaryMonths", jd.getSalaryMonths() == null ? 13 : jd.getSalaryMonths());
        int[] workyears = parseExperience(jd.getExperienceReq());
        data.put("workyearLow", workyears[0]);
        data.put("workyearHigh", workyears[1]);
        data.put("degree", resolveDegreeCode(jd.getDegreeReq()));
        try {
            return objectMapper.writeValueAsString(data);
        } catch (Exception e) {
            throw new IllegalStateException("发布数据序列化失败", e);
        }
    }

    /** "5-10年" → [5,10];无法解析 → [0,99](不限) */
    int[] parseExperience(String text) {
        if (text == null || text.isBlank()) {
            return new int[]{0, 99};
        }
        Matcher m = EXPERIENCE_PATTERN.matcher(text);
        if (m.find()) {
            return new int[]{Integer.parseInt(m.group(1)), Integer.parseInt(m.group(2))};
        }
        return new int[]{0, 99};
    }

    /** 学历文本 → 编码:本科→040;3 位数字直接透传;缺省 040 */
    String resolveDegreeCode(String text) {
        if (text == null || text.isBlank()) {
            return "040";
        }
        String t = text.trim();
        if (DEGREE_CODE.containsKey(t)) {
            return DEGREE_CODE.get(t);
        }
        if (t.matches("\\d{3}")) {
            return t;
        }
        return "040";
    }
}
