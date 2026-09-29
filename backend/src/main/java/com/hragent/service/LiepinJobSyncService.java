package com.hragent.service;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.fasterxml.jackson.databind.JsonNode;
import com.hragent.common.BizException;
import com.hragent.entity.Jd;
import com.hragent.entity.LiepinAccount;
import com.hragent.repository.JdMapper;
import com.hragent.repository.LiepinAccountMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Duration;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 猎聘职位同步(在招职位 → 系统岗位管理):
 * 调 joblist 拉取猎聘在招职位,按 liepin_job_id 幂等入库(source=SYNCED)。
 * 同步的 JD 可在系统内直接建搜索任务/评分/打招呼(如需补齐寻源关键词与描述可再编辑)。
 */
@Slf4j
@Service
public class LiepinJobSyncService {

    private static final Pattern SALARY_RANGE = Pattern.compile("(\\d+)\\s*-\\s*(\\d+)");
    private static final Pattern SALARY_SINGLE = Pattern.compile("^(\\d+)\\s*[Kk]");
    private static final Pattern SALARY_MONTHS = Pattern.compile("(\\d+)\\s*薪");

    private final JdMapper jdMapper;
    private final LiepinAccountMapper accountMapper;
    private final LiepinCommandService commandService;

    public LiepinJobSyncService(JdMapper jdMapper, LiepinAccountMapper accountMapper,
                                LiepinCommandService commandService) {
        this.jdMapper = jdMapper;
        this.accountMapper = accountMapper;
        this.commandService = commandService;
    }

    /** 同步:返回 {created, updated, total} */
    @Transactional
    public Map<String, Integer> sync(Long accountId) {
        LiepinAccount account = accountId == null
                ? accountMapper.selectOne(new LambdaQueryWrapper<LiepinAccount>()
                        .eq(LiepinAccount::getLoginStatus, "NORMAL")
                        .orderByAsc(LiepinAccount::getId)
                        .last("LIMIT 1"))
                : accountMapper.selectById(accountId);
        if (account == null) {
            throw BizException.badRequest("无可用猎聘账号");
        }

        List<JsonNode> jobs = commandService.jobList(account, Duration.ofMinutes(2));
        int created = 0;
        int updated = 0;
        for (JsonNode job : jobs) {
            String jobId = job.path("jobId").asText("");
            String title = job.path("title").asText("");
            if (jobId.isBlank() || title.isBlank()) {
                continue;
            }
            Jd existing = jdMapper.selectOne(new LambdaQueryWrapper<Jd>()
                    .eq(Jd::getLiepinJobId, jobId)
                    .last("LIMIT 1"));
            if (existing == null) {
                jdMapper.insert(applyJobFields(new Jd(), job, jobId, title));
                created++;
            } else {
                String status = "招聘中".equals(job.path("status").asText("")) ? "ACTIVE" : existing.getStatus();
                existing.setStatus(status);
                existing.setCity(parseCity(job.path("city").asText(""))[0]);
                existing.setDistrict(parseCity(job.path("city").asText(""))[1]);
                int[] salary = parseSalary(job.path("salary").asText(""));
                if (salary[0] > 0) existing.setSalaryMin(salary[0]);
                if (salary[1] > 0) existing.setSalaryMax(salary[1]);
                if (salary[2] > 0) existing.setSalaryMonths(salary[2]);
                jdMapper.updateById(existing);
                updated++;
            }
        }
        log.info("猎聘职位同步完成:新增 {} 个,更新 {} 个(共 {} 个)", created, updated, jobs.size());
        Map<String, Integer> result = new HashMap<>();
        result.put("created", created);
        result.put("updated", updated);
        result.put("total", jobs.size());
        return result;
    }

    private Jd applyJobFields(Jd jd, JsonNode job, String jobId, String title) {
        jd.setTitle(title);
        jd.setLiepinJobId(jobId);
        jd.setSource("SYNCED");
        jd.setPublishStatus("PUBLISHED");
        jd.setStatus("招聘中".equals(job.path("status").asText("")) ? "ACTIVE" : "CLOSED");
        String[] city = parseCity(job.path("city").asText(""));
        jd.setCity(city[0]);
        jd.setDistrict(city[1]);
        int[] salary = parseSalary(job.path("salary").asText(""));
        if (salary[0] > 0) jd.setSalaryMin(salary[0]);
        if (salary[1] > 0) jd.setSalaryMax(salary[1]);
        if (salary[2] > 0) jd.setSalaryMonths(salary[2]);
        // 同步职位无描述:用标题占位,便于后续搜索任务/编辑补齐
        jd.setExternalJd("");
        jd.setInternalNotes(title);
        return jd;
    }

    /** "上海-虹口区" → [上海, 虹口区] */
    String[] parseCity(String cityText) {
        if (cityText == null || cityText.isBlank()) {
            return new String[]{"", ""};
        }
        int idx = cityText.indexOf('-');
        if (idx < 0) {
            return new String[]{cityText.trim(), ""};
        }
        return new String[]{cityText.substring(0, idx).trim(), cityText.substring(idx + 1).trim()};
    }

    /** "15-24k·13薪" → [15000, 24000, 13];解析失败的部分返回 0 */
    int[] parseSalary(String salaryText) {
        int min = 0;
        int max = 0;
        int months = 0;
        if (salaryText != null && !salaryText.isBlank()) {
            Matcher range = SALARY_RANGE.matcher(salaryText);
            if (range.find()) {
                min = Integer.parseInt(range.group(1)) * 1000;
                max = Integer.parseInt(range.group(2)) * 1000;
            } else {
                Matcher single = SALARY_SINGLE.matcher(salaryText.trim());
                if (single.find()) {
                    min = max = Integer.parseInt(single.group(1)) * 1000;
                }
            }
            Matcher m = SALARY_MONTHS.matcher(salaryText);
            if (m.find()) {
                months = Integer.parseInt(m.group(1));
            }
        }
        return new int[]{min, max, months};
    }
}
