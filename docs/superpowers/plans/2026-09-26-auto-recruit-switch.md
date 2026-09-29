# 自动招聘运行时开关 + 简历查看 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把自动招聘的"启动参数开关"改造成界面上的运行时开关（存库持久化），语义 = 只停主动外发；补上 HR 筛选必需的简历查看/下载；HR 完全看不到自动化面板与手动按钮。

**Architecture:** 新增 `app_setting` KV 表与 `AutoRecruitSettingService`（运行时开关 + 上轮摘要）；Scheduler 去掉 `@ConditionalOnProperty` 常驻注册，轮次始终按整点运行、由开关决定 `full`/`collectOnly` 模式；ChatPollService 的 3 处索要路径加外发门禁（检测/附件/评分不受影响）；CandidateController 新增简历流式下载（按 user_jd 授权）；前端 Layout 顶部常驻开关+状态（ADMIN），CandidateList 新增「立即运行一轮」/「高级操作」折叠区/「查看简历」。

**Tech Stack:** Spring Boot 3.5.3 + MyBatis-Plus + H2(测试)/MySQL；Vue3 + Element Plus；无新增依赖。

**Spec:** 本会话 grill 收敛结论 + `docs/superpowers/specs/2026-09-25-auto-recruit-closed-loop-design.md`

## Global Constraints

- 开关只管"自动轮次的外发"；手动（立即运行一轮 / 高级操作 4 按钮）任何时刻可用，不受开关限制
- OFF = 只收不联：检测回复/已读、附件下载、评分、拉推荐照常；打招呼与索要（含已读触发）跳过并"攒着"，开启后自动补做
- 生效时点：轮次开始时判定；运行中的轮次跑完才按新状态；轮次互斥（运行中：定时跳过、手动拒绝）
- HR（非 ADMIN）：本次仅做**前端不可见**（开关/状态/手动按钮/高级折叠区）；后端接口收口为独立任务（记录于交付说明）
- 开关存库持久化；`AUTO_RECRUIT_ENABLED` 退役（仅作首次种子：库中无值时以该配置值初始化，默认 false）
- 简历下载按 user_jd 授权：非 ADMIN 仅可下载其分配岗位候选人；跨岗位 403；未入库/文件缺失 404
- 保持：30s 节奏、单账号串行、防重复、熔断不自动解除；测试全绿 + 验证通过后提交（AGENTS.md）

---

### Task 1: app_setting 基建 + 设置服务

**Files:**
- Modify: `backend/src/main/resources/sql/schema.sql`（追加 app_setting 表）
- Modify: `backend/src/test/resources/sql/schema-h2.sql`（同；H2 版不带 ON UPDATE，由代码写 updated_at）
- Create: `backend/src/main/java/com/hragent/entity/AppSetting.java`
- Create: `backend/src/main/java/com/hragent/repository/AppSettingMapper.java`
- Create: `backend/src/main/java/com/hragent/service/AutoRecruitSettingService.java`
- Test: `backend/src/test/java/com/hragent/service/AutoRecruitSettingServiceTest.java`

**Interfaces (Produces，Task 2/3/4 依赖):**
- `boolean isEnabled()`：读 `auto_recruit.enabled`；无值则以 `hr-agent.auto-recruit.enabled` 属性为种子写库并返回（非法值按 false + warn）
- `void setEnabled(boolean enabled, Long userId)`：写库 + `opLogService.log("AUTO_RECRUIT_TOGGLE","setting",1,"自动外发开关 → 开启/关闭")`
- `Optional<JsonNode> lastRun()` / `void saveLastRun(String json)`：key=`auto_recruit.last_run`

DDL：
```sql
CREATE TABLE IF NOT EXISTS app_setting (
    setting_key   VARCHAR(100) PRIMARY KEY,
    setting_value TEXT,
    updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COMMENT ='运行时设置(KV)';
```
Entity：`@TableName("app_setting")`，`@TableId(value="settingKey", type=IdType.INPUT)` + `settingValue` + `updatedAt`。

**Steps:**
- [ ] 1. schema.sql / schema-h2.sql 追加表
- [ ] 2. Entity + Mapper
- [ ] 3. 服务实现（种子逻辑：查无 → 写入属性值；容错：非 true/false 记 warn 按 false）
- [ ] 4. 测试：①库空+属性 true → isEnabled()=true 且库中出现 "true"；②`setEnabled(false)` 后属性翻 true 仍返回 false（库优先）；③toggle 后 op_log 出现 AUTO_RECRUIT_TOGGLE 行
- [ ] 5. 本地库建表：`mysql -uroot -p123456 hr_agent -e "CREATE TABLE IF NOT EXISTS app_setting (...)"`
- [ ] 6. `cd backend && mvn -o test` 全绿
- [ ] 7. commit

### Task 2: 调度器改造（运行时开关 / 只收模式 / 互斥 / 摘要）

**Files:**
- Modify: `backend/src/main/java/com/hragent/config/AutoRecruitScheduler.java`
- Modify: `backend/src/main/java/com/hragent/service/ChatPollService.java`（`poll()` 返回 int，供摘要计数）
- Modify: `backend/src/main/java/com/hragent/config/HrAgentProperties.java`（enabled 注释改为"首次种子"）
- Modify: `backend/src/main/resources/application.yml`（enabled 注释同步）
- Test: `backend/src/test/java/com/hragent/config/AutoRecruitSchedulerTest.java`（适配 + 新增）

**关键改动（骨架）：**
```java
// 去掉 @ConditionalOnProperty(常驻注册,轮次始终运行,开关只决定外发)
private final AtomicBoolean running = new AtomicBoolean(false);
private volatile LocalDateTime runningSince;

void runRound(LocalDateTime now) {                 // 定时入口
    if (!isRunWindow(now)) { log.debug(...); return; }
    if (running.get()) { log.warn("上一轮仍在运行,本轮跳过"); return; }
    executeRound();
}
public void runRoundInternal() {                    // 手动入口(不受开关限制)
    if (running.get()) throw BizException.badRequest("已有轮次正在运行,请稍后再试");
    executeRound();
}
private void executeRound() {
    running.set(true); runningSince = LocalDateTime.now(ZONE);
    boolean enabled = settingService.isEnabled();
    RoundStats stats = new RoundStats(enabled ? "full" : "collectOnly");
    try {
        LiepinAccount account = 取第一个 NORMAL; if (null) { stats.noAccount=true; log; return; }
        try { stats.polled = chatPollService.poll(); }
        catch (CliException e) { if (RISK) stats.riskStopped = true; throw e; }
        for (Jd jd : 在招且 lipeinJobId 有效) {
            try {
                stats.scored += scoringEngine.scorePending(jd.getId());
                if (enabled) stats.greeted += greetingService.greetPassed(jd.getId(), greetBatchLimit);
                else log.debug("自动外发已关闭,岗位 {} 跳过打招呼(攒着)", jd.getId());
                if (hasActiveTask(jd)) continue;
                searchTaskService.createRecommendTask(jd.getId(), account.getId());
                stats.recommended++;
            } catch (CliException e) { if (RISK) { stats.riskStopped=true; throw e; } stats.errors++; log.warn; }
              catch (Exception e) { stats.errors++; log.warn; }
        }
    } finally {
        running.set(false); runningSince = null;
        settingService.saveLastRun(stats.toJson());   // {"at","mode","noAccount","polled","scored","greeted","recommended","errors","riskStopped"}
    }
}
/** 下一个整点运行时刻(9..18 严格晚于 now;否则次日 9:00;null→null) */
static LocalDateTime nextRunAt(LocalDateTime now)
public boolean isRunning() / public LocalDateTime getRunningSince()
```

**Steps:**
- [ ] 1. 调度器重构（删 `@ConditionalOnProperty` 与 import；注入 AutoRecruitSettingService、ObjectMapper）
- [ ] 2. `ChatPollService.poll()` 返回 `pollOnce` 的 processed（日志不变）
- [ ] 3. 测试适配：`disabledDoesNothing` 改为 `switchOffRunsCollectOnlyMode`（poll/scorePending/createRecommendTask 均调用、greetPassed 从不）；`setUp` 中 `settingService.setEnabled(true, null)`
- [ ] 4. 新增测试：①只收模式（同上）；②互斥：scorePending 回调里嵌套 `runRound(WORK_TIME)` → poll 仅 1 次；嵌套 `runRoundInternal()` → 抛 BizException；③摘要：greetPassed stub 返回 3 → lastRun() JSON greeted=3/mode=full；④`nextRunAt` 边界：8:59→当日9:00、9:00→10:00、17:30→18:00、18:00→次日9:00、null→null
- [ ] 5. `mvn -o test` 全绿
- [ ] 6. commit

### Task 3: ChatPollService 索要门禁（OFF 攒着）

**Files:**
- Modify: `backend/src/main/java/com/hragent/service/ChatPollService.java`
- Modify: `backend/src/test/resources/application-test.yml`（auto-recruit 增加 `enabled: true` 作测试默认种子）
- Test: `backend/src/test/java/com/hragent/service/ChatPollServiceTest.java`（新增 3 用例，setUp 中设置开关 ON）

**门禁（3 处索要路径的方法首行，附件/检测不动）：**
```java
if (!settingService.isEnabled()) {
    log.info("自动外发已关闭,跳过索要(攒着,开关恢复后补做),候选人 {}", candidate.getId());
    return false;   // maybeRequestAfterStrangerScore 为 void → return;
}
```
位置：`requestResumeOnRead` / `requestResumeForKnown` / `maybeRequestAfterStrangerScore`。

**Steps:**
- [ ] 1. 注入 `AutoRecruitSettingService` + 3 处门禁
- [ ] 2. 测试：①OFF+已读(direction=0, oppositeRead=1) → `requestResumeDirect` never；②OFF+回复(direction=1,无附件) → `collectOne` never；③OFF+对方附件 → `attachDownload`+`saveResumeFile` 仍执行（照常收集）
- [ ] 3. `mvn -o test` 全绿
- [ ] 4. commit

### Task 4: AutoRecruitController（状态/开关/手动互斥）

**Files:**
- Modify: `backend/src/main/java/com/hragent/controller/AutoRecruitController.java`
- Test: `backend/src/test/java/com/hragent/service/AutoRecruitStatusTest.java`（或并入 Scheduler 测试）

**接口（均 ADMIN，去掉 @ConditionalOnProperty）：**
```java
@PostMapping("/run-once")      // 手动一轮：不受开关限制；运行中 → 400 "已有轮次正在运行"
@GetMapping("/status")         // {enabled, running, runningSince, lastRun, nextRunAt, accountWarning}
@PutMapping("/enabled")        // body {"enabled":bool} → setEnabled + 返回 status
```
`accountWarning` 取值：主账号（id 最小）NORMAL 且未熔断 → null；熔断 → "账号已熔断,自动任务已暂停(完成安全验证后恢复)"；RESTRICTED → "账号受限,自动任务已暂停"；NEED_SCAN → "账号未登录,请扫码"；无账号 → "未配置猎聘账号"。

**Steps:**
- [ ] 1. 控制器改造（status 组装：enabled=runtime、nextRunAt=`AutoRecruitScheduler.nextRunAt(now)`、lastRun=settingService）
- [ ] 2. 测试：status 各字段；toggle 落库；运行中 run-once 拒绝（嵌套调用法，同 Task 2）
- [ ] 3. `mvn -o test` 全绿
- [ ] 4. commit

### Task 5: 简历下载接口（HR 筛选工作台）

**Files:**
- Modify: `backend/src/main/java/com/hragent/controller/CandidateController.java`（注入 StorageService）
- Test: `backend/src/test/java/com/hragent/controller/CandidateResumeTest.java`（新目录）

```java
@GetMapping("/{id}/resume")   // 流式返回;ADMIN 或 jd∈allowedJdIds 才放行
// 候选人不存在 404;越权 403("无权查看该候选人简历");未入库 404("简历未入库");文件缺失 404("简历文件缺失")
// Content-Type: pdf→application/pdf,否则 octet-stream;Content-Disposition: inline; filename 取 objectKey 文件名部分
```
**Steps:**
- [ ] 1. 实现端点（校验顺序：候选人 → 授权 → resume_file → load）
- [ ] 2. 测试（@SpringBootTest+@Transactional，真库+local 存储 target/test-resumes，@AfterEach UserContext.clear）：①ADMIN 200 且字节一致/头正确；②已分配 HR 200；③未分配 HR 403；④无 resume_file 404；⑤候选人 jd=null 且非 ADMIN 403
- [ ] 3. `mvn -o test` 全绿
- [ ] 4. commit

### Task 6: 前端（开关面板 / 按钮收口 / 查看简历）

**Files:**
- Modify: `frontend/src/api/modules.js`（autoRecruitApi + candidateApi.resumeBlob）
- Modify: `frontend/src/views/Layout.vue`（header ADMIN 专属：el-switch + 状态文本 + 60s 轮询 + 悬浮说明）
- Modify: `frontend/src/views/CandidateList.vue`（工具栏/折叠区/查看简历）

```js
export const autoRecruitApi = {
  status: () => http.get('/auto-recruit/status'),
  setEnabled: (data) => http.put('/auto-recruit/enabled', data),
  runOnce: () => http.post('/auto-recruit/run-once')
}
// candidateApi 追加:
resumeBlob: (id) => http.get(`/candidate/${id}/resume`, { responseType: 'blob' })
```
Layout 状态文案：`外发:开/关(只收) · 上次 MM-DD HH:mm 发声N 来信M · 下次 MM-DD HH:mm`；running → `运行中(自 HH:mm)`；accountWarning → 红色 danger 文案。开关 tooltip：`关闭后仍检测来信/下载附件/评分/拉推荐,但不主动发消息;手动操作不受影响`。
CandidateList：工具栏 `v-if=isAdmin`（立即运行一轮[loading] + 高级操作 toggle），折叠区含原 4 按钮；操作列 `查看简历`（有 resumeFile 即显示）+ `重新打分`（仅 ADMIN）；`viewResume` 用 blob→`URL.createObjectURL`→`window.open`，5 分钟后 revoke。

**Steps:**
- [ ] 1. modules.js；2. Layout；3. CandidateList；4. `npm run build` 通过
- [ ] 5. commit

### Task 7: 部署与真机验证

- [ ] 1. `sh deploy/build-frontend.sh` + `mvn -q package -DskipTests`；重启（保留 env `AUTO_RECRUIT_ENABLED=true` 作首次种子一次）
- [ ] 2. curl 验证：`GET /status`（enabled=true、nextRunAt、accountWarning=熔断文案）；`PUT /enabled false/true` 落库（查 app_setting）；`POST /run-once`（账号 RESTRICTED → 日志"无可用账号"，摘要 noAccount=true）
- [ ] 3. 简历链路（临时数据，验证后清理）：建临时 HR 用户 + 分配岗位 + 为分配岗位下某候选人写入 temp resume_file（含磁盘 PDF）→ 无头 Chrome：ADMIN 截图（按钮/开关/状态/折叠区）→ HR 登录截图（无开关、无按钮）→ HR 会话内 fetch 简历（200/PDF/字节）；跨岗位候选人 fetch → 403；清理 temp 数据
- [ ] 4. 待账号恢复后补验（阻塞项，明确写入交付说明）：OFF 真实轮次=只收不联；ON 真实打招呼
- [ ] 5. 设计文档 §2 追加"运行时开关"条目；README 中 AUTO_RECRUIT_ENABLED 说明同步（如引用）；`mvn -o test` 最终全绿
- [ ] 6. commit（本地，推送另行确认）

## 风险与说明

- 账号当前 RESTRICTED：真实外发链路（OFF 只收 / ON 打招呼）本轮无法真机验证，由单测覆盖 + 账号恢复后补验
- 后端接口角色收口（recruit/*、JD 写、账号写 → ADMIN）为**独立任务**；本次仅前端隐藏，HR 上线前必须完成（已记录）
- `waitFor`/管道死锁、chatlist 100 条、已读触发等历史修复不在本次范围内，回归由全量测试保障
