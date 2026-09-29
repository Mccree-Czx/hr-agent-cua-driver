# 自动轮节拍改造:50 分钟平摊 + 疑似拦截冻结复测(2026-09-28)

日期:2026-09-28
状态:已实施;`mvn test` 271 用例全绿;已部署观察

## 1. 背景与问题

- 原轮次在整点后 3–10 分钟内**暴发**执行(单轮最多 100 次简历详情读取,随后任务队列"接力"拉推荐),
  2026-09-28 当天多次触发平台"安全验证"页与会话失效;
- 当天事实表明平台对"暴发速率"敏感:将单轮负载**平摊到整点窗口内匀速执行**。

## 2. 已确认决策(与用户逐项确认)

| 议题 | 决策 |
|---|---|
| 平摊范围 | 全部平台操作(会话轮询、评分读取、打招呼/索要、推荐拉取) |
| 轮次形态 | 长轮次内匀速:整点启动、约 :50 硬停;睡眠/重启越过窗口即弃剩余单元(下轮幂等补做,不自动续跑) |
| 节拍方式 | 统一队列一 tick 一动作;间隔自适应 = clamp(剩余窗口/剩余单元, paceMillis, maxPaceMillis) |
| 命中验证页 | 冻结退避 15 分钟 → 复测一次;成功恢复原节奏、再命中才熔断中止整轮(`risk-probe-backoff-minutes=0` 回退"立即熔断") |
| 手动补跑 | 运行中直接拒绝;空闲触发窗口 = min(平摊窗口, 距下一整点-10 分钟),不足 10 分钟拒绝 |

## 3. 设计要点

### 3.1 节拍循环(`AutoRecruitScheduler`)

- 单元优先级:①会话处理 ②会话列表刷新(≥`poll-list-interval-minutes`) ③打招呼(≤`greet-batch-limit`/岗,发送节奏由 AccountPaceGuard 60s 保证) ④简历读取(轮 60/岗 20 预算,`ScoringEngine.scoreNext(jd,1)` 分片) ⑤推荐创建(≥`recommend-gap-minutes`,防创建扎堆)
- 全部墙钟判定;睡眠分段 ≤60s(睡醒/重启后越过 :50 立即收尾并记录 `abandoned` 单元数);工作全部消费且窗口内无后续刷新点时可提前收尾
- 统计/摘要/轮次历史沿用(时长自然反映约 50 分钟)

### 3.2 疑似拦截"冻结-复测"(`RiskSuspectGuard`,内存态按账号)

- 状态机:命中 → HOLD(15 分钟,全平台操作暂停:轮次等待、任务调度不认领)→ 冻结到期后**第一个平台操作作为复测** → 成功清零 / 再命中走既有真实熔断链路(RESTRICTED + 告警)
- 冻结跨越平摊窗口 → 本轮就地收尾(下轮重新按窗口执行)
- 进程重启后状态清零:重启后的第一个平台操作天然充当复测(fail-safe 不放松)

### 3.3 任务执行节流(`SearchTaskScheduler`)

- 认领前两道门禁:①守卫未冻结;②距该账号上次"执行相关"活动(`search_task` 中 RUNNING/DONE/FAILED 的 `updated_at`)≥ `recommend-gap-minutes`
- 堵 2026-09-28 15:03 事故形态:轮次结束后任务队列"接力"连续拉取

### 3.4 配置(`HrAgentProperties.AutoRecruit` / `application.yml`,env 可覆盖)

`spread-minutes=50`、`pace-millis=30000`、`max-pace-millis=120000`、
`poll-list-interval-minutes=15`、`recommend-gap-minutes=8`、`risk-probe-backoff-minutes=15`

## 4. 兼容与回退

- 各预算上限不变(读取 30/轮、索要 5/轮、招呼 15/岗);旧 `scorePending`/`pollOnce` 入口保留
- 逃生阀:`risk-probe-backoff-minutes=0`(立即熔断旧语义)、`recommend-gap-minutes=0`(关闭任务间隔门禁)
- 长轮次期间 ADMIN `run-once` 被互斥拒绝;整点前 10 分钟缓冲窗口内手动补跑按剩余窗口平摊

## 5. 验证

- 新增/重构 6 个测试类(`AutoRecruitSchedulerTest` 节拍/硬停/冻结复测、`RiskSuspectGuardTest`、
  `LiepinCommandServiceRiskTest`、`SearchTaskSchedulerGateTest`、`ScoringEngineSliceTest`、`ChatPollServiceSliceTest`);
  `mvn test` 271 用例全绿
- 部署后观察下一整点轮:相邻平台动作间隔 ≥30s、任务执行间隔 ≥8min、整轮时长约 50 分钟、零熔断
