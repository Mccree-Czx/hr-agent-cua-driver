# AGENTS.md

This file provides guidance to Qoder (qoder.com) when working with code in this repository.

本文件定义了 AI 代理(AI Agent)在本项目中工作时必须遵守的规则。

## 项目协作规则

### 1. Git 提交规范

- 每次改动完成后,都必须创建对应的 Git commit,以便于后续的追踪和回滚。
- 提交信息应清晰描述本次改动的目的和内容。
- 每个 commit 应聚焦于一个逻辑完整的改动单元,避免将无关改动混合在一次提交中。

### 2. 测试与验证规范

- 每次改动之后,都必须编写或更新相关测试。
- 在交付给用户前,必须确保测试和验证全部通过。
- 如果改动影响现有行为,必须同步更新受影响的测试用例。
- 测试通过后,方可视为本次改动完成并交付。

### 3. 工具目录规范(tools/liepin-cli)

- `tools/liepin-cli` 为 liepin-cli 的 fork(上游 Viy1204/liepin-cli),已新增 `jobpublish`(发布职位)与 `jobdelete`(删除职位)命令,代码纳入本仓库统一管理。
- 修改该目录后必须执行 `npm run build` 验证 TypeScript 编译通过,并在根目录 `backend/` 执行 `mvn test` 确保全部测试通过。
- 涉及猎聘页面的真机验证仅使用临时测试职位,不得对真实在招职位做破坏性验证。
- 猎聘页面逆向分析产物(bundle-downloads、probe 输出等)不得入库(已在 .gitignore 排除)。

## 交付流程

1. 完成代码改动。
2. 编写或更新相关测试。
3. 运行测试并确保全部通过。
4. 创建对应的 Git commit。
5. 推送到远程仓库(`git push origin main`)。
6. 向用户交付。

## 项目概览

基于猎聘的 HR Agent(单机集中式):AI 按岗位 JD 主动搜索猎聘人才库,评分筛选在线简历,通过者自动打招呼,候选人回复后索要简历并入库。

- `backend/`:Spring Boot 3.5.3 + Java 17 + MyBatis-Plus + MySQL,通过子进程驱动 liepin-cli(Node.js CLI)
- `frontend/`:Vue3 + Element Plus 管理后台(ADMIN / HR 双角色)
- `tools/liepin-cli/`:猎聘浏览器自动化 CLI(fork,纳入本仓库统一管理;Node ≥ 20,Puppeteer/CDP 驱动有头 Chrome)
- AI 层:AgentScope Java 框架,底层接 OpenAI 兼容模型接口(DeepSeek 默认,可切 Qwen/GLM)
- 简历存储:MinIO 对象存储 + MySQL 元数据(StorageService 抽象,可切本地文件系统)
- 告警:飞书机器人 webhook(未配置则仅本地日志)

环境要求:JDK 17+、Maven 3.9+、Node.js 20+、MySQL 8+、Chrome(必须为有头模式,原因见「风控守卫链」)。

## 常用命令

### 后端(backend/)

```bash
mvn test                                        # 全量测试(H2 内存库,无需 MySQL)
mvn test -Dtest=AutoRecruitSchedulerTest        # 运行单个测试类
mvn test -Dtest=AutoRecruitSchedulerTest#方法名  # 运行单个测试方法
DB_PASSWORD=xxx AI_API_KEY=sk-xxx mvn spring-boot:run   # 本地启动(8080)
mvn package -DskipTests                         # 打 fat jar(target/hr-agent-backend-0.1.0-SNAPSHOT.jar)
```

- 首次运行:先建库并执行 `backend/src/main/resources/sql/schema.sql`;首次启动自动创建默认管理员 admin / admin123(请尽快修改)
- 生产单进程托管前端:先 `sh deploy/build-frontend.sh`(前端产物复制进 `backend/src/main/resources/static/`,该目录已 gitignore),再 `mvn package`
- Windows PowerShell 下环境变量用 `$env:DB_PASSWORD='xxx'` 形式,不能直接用 `DB_PASSWORD=xxx` 前缀写法

### 前端(frontend/)

```bash
npm install
npm run dev     # 开发模式 5173 端口,/api 代理到 8080
npm run build   # 构建产物 dist/
```

### liepin-cli(tools/liepin-cli/)

```bash
npm install
npm run build   # tsc 编译到 dist/(npm test 跑的是 dist 产物,测试前必须先 build)
npm test        # node --test 运行 dist 下的 *.test.js
```

### 部署(deploy/,均为 POSIX sh 脚本,Windows 环境用 Git Bash 执行)

```bash
sh deploy/build-frontend.sh                            # 前端构建并复制到后端静态资源目录
cd deploy; docker compose up -d; sh init-minio.sh      # 基础设施 MySQL + MinIO
sh deploy/backup-userdata.sh backup                    # 猎聘登录态(user-data)备份/恢复
```

## 架构大图

### 自动招聘闭环调度(核心)

`AutoRecruitScheduler` 是整条链路的总编排(业务规则权威来源:`docs/superpowers/specs/2026-09-25-auto-recruit-closed-loop-design.md` 与 `2026-09-28-round-pacing-design.md`):

- **调度**:北京时间每天 06:00–23:00 每整点一轮(含 23:00,周末与节假日照常);轮次在 50 分钟平摊窗口(`spread-minutes`)内**匀速**执行全部平台动作,过窗即收尾(记 `abandoned`,下轮幂等补做,不自动续跑)
- **节拍**:统一队列一 tick 一动作,优先级 = 会话处理 > 列表刷新 > 打招呼 > 简历读取 > 推荐创建;间隔自适应 = clamp(剩余窗口/剩余单元, 30s, 120s);仅触达平台的动作(`LiepinCliExecutor.spawnSeq()` 增长)吃节拍,纯记账单元轻间隔快速通过
- **4-5 星专道窗口**:每小时 :51–:59(`star-tail-cron`)发送高星队列,不占轮内预算;跨窗口未发出的由下一轮轮内按预算插发
- **运行时开关**:持久化于 `app_setting` KV 表(`AutoRecruitSettingService`,界面开关仅 ADMIN);OFF = collectOnly 只停主动外发(打招呼/索要"攒着"),检测/附件/评分/拉推荐照常;`AUTO_RECRUIT_ENABLED` 配置仅作首种子;手动 run-once 与高级操作不受开关限制
- **互斥**:轮次级 AtomicBoolean(定时重叠跳过、手动触发拒绝);岗位已有 QUEUED/RUNNING 任务则本轮跳过拉新

### 任务队列与 CLI 执行器

- `SearchTaskScheduler` 每 30s tick:释放过期租约(进程崩溃兜底)→ 每账号认领一个任务;认领前两道门禁——`RiskSuspectGuard` 冻结期不认领、距该账号上次任务执行 ≥ `recommend-gap-minutes`(防"任务接力"暴发)
- `TaskQueueService`:单账号串行(同账号仅一个 RUNNING)、600s 租约 + 心跳续约、失败 30s×2^n 指数退避、3 次后终态失败 + 告警
- `LiepinCliExecutor`:liepin 子进程封装。每账号独立 `LIEPIN_USER_DATA_DIR`(登录态隔离)+ 独立 CDP 端口(53471 起,id>1 偏移);同账号经 ReentrantLock **串行**执行;子进程输出落临时文件(防大输出 64KB 管道死锁,2026-09-26 根因);`checkRisk` 双档扫描——结构性标记(captchaPage / safe.liepin.com)全路径扫描,泛词(verify、安全验证等)仅失败/超时路径扫描(防候选人简历文本误熔断)

### 风控守卫链(改风控相关逻辑前必读)

- 命中风控 → `RiskSuspectGuard` 冻结-复测:首次命中冻结退避 15 分钟(期间全平台操作暂停,含任务调度不认领)→ 到期复测一次 → 成功恢复节奏 / 再命中才真实熔断(账号 RESTRICTED + 飞书告警 + 轮次中止);`risk-probe-backoff-minutes=0` 回退"立即熔断"旧语义;状态为内存态,进程重启后第一个平台操作天然充当复测
- `AccountPaceGuard`:账号级外发节流(默认 60s,`greet-interval-seconds`),打招呼 / 附件下载 / 索要简历统一走它
- **有头 Chrome 硬约束**:无头 UA(`HeadlessChrome`)与真实平台矛盾、被猎聘风控零误报识别(实测导致账号限制);不得给 CLI 传任何无头开关

### 评分与提示词(AI 层)

- `ScoringEngine` 星级模型 v2:单次 AI 调用输出 1-5 星;1 星 → FAIL 淘汰,2 星 → KEPT 留库,3 星 → 轮内打招呼 + 要简历,4-5 星 → 专道窗口;疑似一票否决 → HOLD 人工复核
- 三处系统提示词以 AgentScope 技能包维护:`backend/src/main/resources/agents/skills/<name>/SKILL.md`(resume-scoring / greeting-writing / jd-threshold-suggest),经 `AgentSkillLoader` 加载(支持 classpath 读取与 fat-jar 回退直读);**修改 SKILL.md 需重启才生效**
- 外发前提 fail-closed:岗位评分偏好未确认(`scoring_pref_confirmed_at` 为空)只收集来信与附件,禁止一切自动外发

### 来信与附件(被动通道)

`ChatPollService`:chatlist 拉会话(单页上限 50,CLI 已钳制)→ 仅处理 `direction=1`(候选人最后发言)会话 → 已知候选人经 `attach-fetch` 纯接口路线收附件(不打开会话、零已读副作用;**不受分数/门槛限制**,开关 OFF 也收集;消息级防抖 `attach_probe_msg_id`)→ 对方回复或"已读我方最新消息"触发索要(受开关门禁)→ 陌生来话从消息提取 `enresId` 建立候选人,无法关联岗位则进人工待分配(不猜测身份)

### 数据 / 存储 / 权限

- MySQL 12 张表;schema 双份**必须同步修改**:`backend/src/main/resources/sql/schema.sql`(MySQL)与 `backend/src/test/resources/sql/schema-h2.sql`(H2,不带 ON UPDATE,updated_at 由代码写)
- `StorageService` 抽象:minio(默认)/ local 两种实现
- 权限:JWT(`jwt.secret`,生产必须修改)+ `AuthInterceptor` 白名单 + `@RequireRole("ADMIN")`;HR 按 `user_jd` 分配岗位授权(跨岗位 403);前端按 role 门禁(adminOnly 路由/按钮,如自动外发开关、运行日志、用户管理)

### 前端

- Vue3 + Element Plus + **hash 路由**(由 Spring Boot 静态托管,无需 SPA fallback 配置)
- axios 拦截器统一处理:`code !== 0` 弹错误、401 清 token 跳登录;页面:Dashboard / JdList / CandidateList / Runs / AccountList / UserList

## 测试约定

- 测试跑在 H2 内存库(`backend/src/test/resources/application-test.yml`,MODE=MySQL)+ `schema-h2.sql` 自动建表,不依赖 MySQL/MinIO
- 惯例:`@SpringBootTest` + `@ActiveProfiles("test")` + `@Transactional`;服务层用 `@MockitoBean`,mapper 走真实 H2;接口测试用 `TestAuthHelper.loginAsAdmin` 取 JWT
- 虚拟时钟接缝:`AutoRecruitScheduler.clock` / `.sleeper` 与 `RiskSuspectGuard.clock`(节拍类测试在虚拟 50 分钟窗口内瞬间跑完,并断言相邻动作间隔);测试配置中 `scheduler.enabled: false`、`auto-recruit.enabled: true`(开关关闭语义的用例自行 setEnabled(false))
- 改动 `tools/liepin-cli` 后:`npm run build` + 回 `backend/` 跑 `mvn test`

## 延伸阅读

- `tools/liepin-cli/AGENTS.md`:CLI 内部硬约束(有头浏览器、退出码契约 0/1/2/3、CDP 端口 53471、命令结束只断 CDP 不关浏览器、反检测约定等)
- `docs/superpowers/specs/`:业务规则权威来源(自动招聘闭环设计、50 分钟平摊节拍设计);`docs/superpowers/plans/`:历史实施计划
