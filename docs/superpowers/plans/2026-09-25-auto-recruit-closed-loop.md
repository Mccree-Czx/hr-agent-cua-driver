# 自动招聘闭环实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现工作日自动闭环：每小时拉取推荐 → 职能校验 → 评分 → 通过打招呼；轮询来信 → 评分/索要；附件自动下载校验入库。

**Architecture:** CLI（fork）新增 `attach-download` 命令复用浏览器下载通道；后端新增门槛确认门禁、AutoRecruitScheduler 定时编排、ChatPollService 来信轮询与附件收集；前端拆分为「岗位沟通视图 / 已收简历 / 待分配」三视图。

**Tech Stack:** TypeScript（CLI, node:test）、Spring Boot 3.5.3 + MyBatis-Plus（后端, JUnit5+Mockito+H2）、Vue3 + Element Plus（前端）。

**Spec:** `docs/superpowers/specs/2026-09-25-auto-recruit-closed-loop-design.md`（实施前必读，所有口径以它为准）

## Global Constraints

- 推送策略：全部提交仅本地 commit，不 push（用户明确要求）。
- 密钥：任何提交不得包含 API key/密码；AI key 由启动参数传入。
- 平台交互：单账号串行；不新增任何反检测逻辑；真机验证只用临时职位/已授权样本。
- 打招呼发送间隔 30 秒、防重复（全局单人）、风控熔断不自动解除（既有逻辑保留）。
- 测试基线：后端 `cd backend && mvn test`（当前 80 通过）；CLI `cd tools/liepin-cli && npm run build && npm test`（当前 137 通过）。
- 设计口径：门槛未确认绝不外发；期望职能不匹配绝不打招呼；附件仅下载校验通过才入库；自动打开会话会标记已读（已接受）。

---

### Task 1: CLI `attach-download` 命令

**Files:**
- Create: `tools/liepin-cli/src/toolset/attach-download.ts`
- Create: `tools/liepin-cli/src/toolset/attach-download.test.ts`
- Modify: `tools/liepin-cli/src/toolset/index.ts`（export）
- Modify: `tools/liepin-cli/src/cli/index.ts`（注册命令）

**Interfaces:**
- Produces: `attachDownload(page, { imId, outDir, maxBytes? })` → `{ success, file, bytes, sha256, sourceOrigin }`；命令名 `attach-download`，参数 `--imId`（必填）、`--out`（必填目录）、`--maxBytes`（默认 20MiB）
- Consumes: `navigateToLpt`、`requirePage`（既有）

**实现要点（来自第一阶段真机验证）：**
1. 会话定位：`evaluate` 查找 `.im-ui-contact-list-item`，`data-tlg-ext`（URI 解码 JSON）的 `to_imid` 等于输入 imId；未找到 → 报错"会话不存在"（不猜、不点第一个）。
2. 点击会话 → 等待 `.im-ui-send-attachment-card`（超时 15s）→ 取**最后一个**附件卡片点击其 `附件简历`（`.im-ui-send-attachment-card-info-item-content` 文本匹配）。
3. 等待预览弹窗 `.im-ui-preview-modal-title-box`（超时 15s）→ 校验**唯一**可见下载按钮：`a` 元素且内含 `svg path[d^="M8.98 11.687"]`；0 个或 >1 个 → 报错（不任选）。
4. 下载捕获（CDP）：
   - `const session = await page.target().createCDPSession()`
   - `await session.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: outDir, eventsEnabled: true })`
   - 监听 `Browser.downloadWillBegin`（记录 guid/origin；origin 必须属于 `tdoss.liepin.com|lpt.liepin.com|wow.liepin.com`，否则 `Browser.cancelDownload`）与 `Browser.downloadProgress`（completed → 完成；超过 maxBytes → cancel）
   - 触发点击（`userGesture: true`）
   - 总超时 60s；finally 中恢复 `Browser.setDownloadBehavior → { behavior: 'default', eventsEnabled: false }`
5. 校验：文件存在、`%PDF-` 签名、长度 ≤ maxBytes → 输出 JSON；失败抛错（退出码 1）。

**测试（node:test，mock page 与 CDP session）：**
- 会话未找到 → 报错且不点击任何元素
- 多个会话项匹配同一 imId → 报错（歧义不猜）
- 无附件卡片 / 无下载按钮 / 下载按钮不唯一 → 报错
- 下载事件 origin 非受信 → cancel 并报错
- 下载完成但文件无 `%PDF-` 签名 → 失败
- 超限（进度事件超 maxBytes）→ cancel 并报错
- 成功路径 → 输出含 file/bytes/sha256/sourceOrigin；恢复默认下载行为被调用

- [ ] Step 1: 写 attach-download.test.ts（上述用例，全部失败）
- [ ] Step 2: `npm run build && npm test` 确认新用例失败
- [ ] Step 3: 实现 attach-download.ts + 注册（index.ts ×2）
- [ ] Step 4: `npm run build && npm test` 全绿
- [ ] Step 5: 真机验证（低频只读）：`node dist/cli/index.js attach-download --imId <刘先生会话im_id> --out ./runtime/attach-check --json` → 校验输出文件与 SHA-256；随后**删除本次下载的重复样本**（保留第一阶段的已验证样本）。注意：会标记会话已读（已接受）
- [ ] Step 6: Commit：`git add tools/liepin-cli/src && git commit -m "feat(cli): attach-download 命令(浏览器下载通道+PDF校验)"`

---

### Task 2: jd 门槛字段、AI 建议与确认门禁

**Files:**
- Modify: `backend/src/main/resources/sql/schema.sql`、`backend/src/test/resources/sql/schema-h2.sql`
- Modify: `backend/src/main/java/com/hragent/entity/Jd.java`
- Create: `backend/src/main/java/com/hragent/service/JdThresholdService.java`
- Modify: `backend/src/main/java/com/hragent/controller/JdController.java`
- Modify: `backend/src/main/java/com/hragent/service/GreetingService.java`（门禁）
- Modify: `backend/src/main/java/com/hragent/service/ResumeCollectService.java`（门禁）
- Create: `backend/src/test/java/com/hragent/service/JdThresholdServiceTest.java`
- Modify: 本地库一次 `ALTER TABLE jd ADD COLUMN ...`（4 列）

**Interfaces:**
- Produces:
  - `Jd` 新增字段：`scoreThreshold:Integer`、`thresholdSuggestion:String`、`thresholdConfirmedBy:Long`、`thresholdConfirmedAt:LocalDateTime`
  - `JdThresholdService.suggest(Long jdId)` → 调 AI 生成 `{threshold, reason}`，写入 thresholdSuggestion（格式 `建议{N}分:{理由}`），返回 suggestion 文本
  - `JdThresholdService.confirm(Long jdId, int threshold, Long userId)` → 校验 1..100，写 scoreThreshold + confirmedBy/At
  - HTTP：`POST /api/jd/{id}/threshold/suggest`、`PUT /api/jd/{id}/threshold/confirm` body `{threshold}`
- Consumes: `AiClient`（既有）、`UserContext`（既有）

**门禁实现（两处外发入口）：**
- `GreetingService.tryGreet`：在"防重复"检查后加 —— jd = jdMapper.selectById(candidate.getJdId())；`jd.getThresholdConfirmedAt() == null` → log.warn("岗位未确认门槛,跳过外发") + return false（不生成任何记录）
- `ResumeCollectService.requestResume`：调用前同样校验来源岗位门槛已确认，未确认 → log.warn + return（不改状态）
- **同时移除配额拦截**：`GreetingService.tryGreet` 中 `isQuotaExhausted` 调用与判断删除（方法可删；`daily_greet_quota` 列保留）

**职能校验接入评分（设计 4.2）：**
- 新增纯函数 `JobMatchEvaluator.evaluate(expectations(List<String>), classificationEvidence?, targetJobTitle)` → `MATCH|MISMATCH|UNKNOWN`（三态；与 CLI resume.ts 同口径：明确映射、多期望任一匹配、证据冲突/缺失→UNKNOWN、不得用当前职位代替期望）
- `ScoringEngine` 评分前调用：MISMATCH → 直接置 FAIL（不调 AI、省 token）；UNKNOWN → pass_status=PENDING 并在 reason 标记「职能待确认」，**不进入打招呼**；MATCH → 继续 AI 评分
- 期望数据来源：`candidate.snapshot` 中的期望字段（若缺）→ 由 Task 4 的详情读取补齐；本任务先实现判定与门禁，测试用构造快照
- 测试：MATCH 走 AI；MISMATCH 不调 AI 且 FAIL；UNKNOWN 不 PASS 且不进入 greetPassed

**测试（H2+Mockito）：**
- confirm：合法值写入 4 字段；越界 0/101 → BizException
- 门禁：门槛未确认 → tryGreet 返回 false 且 greeting_record 为 0、commandService.greet 未被调用；确认后（scoreThreshold=60）→ 正常发送
- 门禁同样覆盖 requestResume 路径（未确认不调用 commandService.requestResume）
- suggest：mock aiClient 返回 `{"threshold":60,"reason":"..."}` → suggestion 落库；AI 失败 → BizException（不落半成品）
- 移除配额：原 quotaExhaustedStopsSending 测试改为"配额字段不再拦截"（quota=0 仍发送成功）

- [ ] Step 1: schema ×2 + 本地 ALTER + Jd 实体字段
- [ ] Step 2: 写 JdThresholdServiceTest（失败）
- [ ] Step 3: 实现 JdThresholdService + Controller 接口
- [ ] Step 4: 改造 GreetingService/ResumeCollectService（门禁+移除配额），更新既有测试
- [ ] Step 5: `mvn test` 全绿
- [ ] Step 6: Commit：`git commit -m "feat: 岗位评分门槛(AI建议+人工确认)与外发门禁;移除系统每日配额拦截"`

---

### Task 3: AutoRecruitScheduler 定时编排

**Files:**
- Create: `backend/src/main/java/com/hragent/config/AutoRecruitScheduler.java`
- Create: `backend/src/test/java/com/hragent/config/AutoRecruitSchedulerTest.java`
- Modify: `backend/src/main/resources/application.yml`（开关 `hr-agent.auto-recruit.enabled: false` 默认关，启动参数开启）
- Modify: `backend/src/main/java/com/hragent/config/HrAgentProperties.java`（autoRecruit 配置节：enabled）

**Interfaces:**
- Produces: `AutoRecruitScheduler.runRound()`（可直调测试）；`static boolean isWorkWindow(LocalDateTime now)`（周一~周五 9:00–18:59；整点触发由 cron 保证）
- Consumes: `SearchTaskService.create`（既有）、`SearchTaskMapper`（查 QUEUED/RUNNING 防重叠）、`ScoringEngine`（评分）、`GreetingService.greetPassed`（打招呼）、`ChatPollService.poll()`（Task 4 产出，先以接口占位 `ChatPollService.poll()` 空实现可编译）

**cron 与逻辑：**
```
@Scheduled(cron = "0 0 9-18 * * MON-FRI", zone = "Asia/Shanghai")
public void hourly() { runRound(); }

runRound():
  if (!properties.getAutoRecruit().isEnabled()) return;      // 关闭时直退
  if (!isWorkWindow(LocalDateTime.now(ZoneId.of("Asia/Shanghai")))) return;
  account = 第一个 NORMAL 账号；无 → warn + return
  chatPollService.poll();                                     // 步骤 1: 来信与附件
  for jd in jdMapper( status=ACTIVE 且 liepinJobId 匹配 [1-9]\d* ):
      // 步骤 2: 先消费存量——该岗位未评分候选人补评分(职能门禁+AI)，PASS 未联系者打招呼
      scoringEngine.scorePending(jdId);                       // 新增方法:遍历 pass_status=PENDING 且无 score_record 的候选人
      greetingService.greetPassed(jdId, 单轮上限);             // 复用既有(含门槛/职能/节奏/去重门禁)
      // 步骤 3: 再拉新推荐
      if (存在该 jd 的 QUEUED/RUNNING 任务) continue;        // 防重叠
      searchTaskService.create(jdId, accountId, RECOMMEND);   // 复用既有入口(含 jobId 门禁与去重)
```
- 单轮打招呼上限：`properties.autoRecruit.greetBatchLimit`（默认 5，可配置；弥补取消日配额后的工作量边界，具体值后续可调）

- [ ] Step 1: 写 AutoRecruitSchedulerTest：isWorkWindow 边界（周五18:59 true/周六 false/9:00 true）、enabled=false 不建任务、防重叠（已有 QUEUED 的任务 → 不重复创建）、无账号不建任务、存量处理顺序（先 chatPoll → 再 scorePending/greetPassed → 再建推荐任务）（全部 mock mapper/服务）
- [ ] Step 2: `mvn test` 确认失败
- [ ] Step 3: 实现调度器 + 配置项（yaml/properties 类）+ ScoringEngine.scorePending；ChatPollService 本步只建接口+空实现（下一任务填充）
- [ ] Step 4: `mvn test` 全绿
- [ ] Step 5: Commit：`git commit -m "feat: AutoRecruitScheduler 工作日逐小时编排(来信轮询+逐岗位推荐,防重叠,默认关闭)"`

---

### Task 4: ChatPollService 来信轮询与附件收集

**Files:**
- Create: `backend/src/main/java/com/hragent/service/ChatPollService.java`
- Modify: `backend/src/main/java/com/hragent/service/LiepinCommandService.java`（新增 `attachDownload(account, imId, outDir, timeout)` 与 `chatList` 已有）
- Modify: `backend/src/main/java/com/hragent/service/ResumeCollectService.java`（附件入库复用 `saveResumeFile`）
- Create: `backend/src/test/java/com/hragent/service/ChatPollServiceTest.java`

**Interfaces:**
- Produces: `ChatPollService.poll()`（每轮总入口，内部单账号串行）；`int pollOnce(LiepinAccount)` 返回处理条数
- Consumes: `LiepinCommandService.chatlist/chatmsg/attachDownload`、`ScoringEngine`（既有）、`ResumeCollectService.saveResumeFile`、`CandidateMapper/GreetingRecordMapper/ResumeFileMapper`

**处理规则（严格按设计 3.2）：**
1. `chatlist --limit 30 --json` → 遍历会话（字段：im_id、latest_msg、name）
2. 匹配已有候选人：`candidate` 中 `snapshot` 含该 im_id（`LIKE '%"im_id":"<id>"%'`）或 phone/preview 匹配者跳过重复处理
3. **已知候选人**：`chatmsg` 取消息 → 最新一条含附件卡片（payload bodies 含 `file`/`fileId`）→ 若 `resume_file` 无记录 → `attachDownload` 下载到工作目录 → 校验 JSON 成功 → `saveResumeFile` 入库（**不看分数**）；下载失败 → 日志留待下轮重试（不写半状态）
4. **文本回复**：direction=1（候选人）且无附件 → 若来源岗位门槛已确认且评分 PASS 且未 REQUESTED → 走既有 `ResumeCollectService` 索要
5. **陌生来话**（会话 im_id 未匹配任何候选人）：`chatmsg` 提取在线简历卡片 payload 的 `enresId`；成功 → 建 candidate（jdId 从消息 job 字段映射，无 → null 待分配），走 期望职能三态 → PASS 才外发；**提取失败 → 只记日志/待分配标记，不猜身份**
6. 全程 try/catch 单会话失败不中断；风控异常（RiskControlError）→ 立即中断本轮上抛

- [ ] Step 1: 写 ChatPollServiceTest（mock commandService/aiClient/mappers）：
  - 附件卡片 → 下载成功 → saveResumeFile 被调用且入库
  - 附件下载失败 → 不入库、无半状态、下轮重试（再次 poll 会重试）
  - 文本回复+门槛未确认 → 不索要；门槛确认+PASS → 索要
  - 陌生来话提取成功 → 建 candidate（jdId 正确）；提取失败 → 不建/标记待分配、不调用评分
  - RiskControlError → poll 上抛（调度器据此停轮）
- [ ] Step 2: `mvn test` 确认失败
- [ ] Step 3: 实现 ChatPollService + LiepinCommandService.attachDownload
- [ ] Step 4: `mvn test` 全绿
- [ ] Step 5: Commit：`git commit -m "feat: 来信轮询与附件自动收集(下载校验入库,失败重试,陌生来话不猜身份)"`

---

### Task 5: 前端三视图改造

**Files:**
- Modify: `frontend/src/views/JdList.vue`（门槛卡片 + 筛选与沟通入口）
- Modify: `frontend/src/views/CandidateList.vue`（改为已收简历 + 待分配）
- Modify: `frontend/src/views/AccountList.vue`（配额标注）
- Modify: `frontend/src/api/modules.js`（threshold 接口）

**行为：**
- JdList：未确认门槛的岗位行显示橙色标记「门槛待确认」+ 展开卡片显示 suggestion 与输入框/确认按钮；「筛选与沟通」按钮打开抽屉（该岗位候选人：姓名/评分/职能校验结果/招呼状态/附件状态——数据复用 `/api/candidate?jdId=` 分页接口）
- CandidateList：默认视图「已收简历」= 后端过滤 `hasResumeFile=true`（后端小改：CandidateController 分页接口加可选参数，仅 resume_file 存在才返回）；页签「待分配」= jdId 为空或指向已删除岗位
- AccountList：每日配额字段下加注释文案「平台权益参考,系统不再限制」

- [ ] Step 1: 后端 CandidateController 加 `hasResumeFile`/`unassigned` 过滤参数 + 测试
- [ ] Step 2: 前端改造三个视图 + `sh deploy/build-frontend.sh` 构建通过
- [ ] Step 3: 手工验证（本地服务）：门槛确认流程、已收简历过滤、待分配页签
- [ ] Step 4: Commit：`git commit -m "feat(ui): 岗位门槛确认与沟通视图;候选人库拆分已收简历/待分配"`

---

## 验收对照（设计文档第 8 节）

| 验收标准 | 覆盖任务 |
|---|---|
| 1. 门槛未确认绝不外发 | Task 2（含测试） |
| 2. 职能不匹配绝不打招呼 | Task 2 门禁 + 既有 resume 三态（Task 4 接入） |
| 3. 附件校验通过才入库、失败可重试不重复 | Task 1 + Task 4 |
| 4. 工作日逐小时自动运行、熔断即停 | Task 3 + 既有熔断 |
| 5. 候选人库只显示入库成功者 | Task 5 |

## 风险与边界

- attach-download 的 CDP 下载捕获在 puppeteer connect 模式下若 `page.target().createCDPSession()` 无法收 Browser 级事件 → 回退用 `browser` 目标 session（实现时真机先验，属于 Step 5 必测项）。
- 所有真机步骤低频（间隔≥30s），遵守既有风控边界；安全验证出现即停并报告。
- 本计划不实施：多账号轮询分配、法定节假日口径、单轮外发上限（设计文档第 7 节已登记，另行确认）。
