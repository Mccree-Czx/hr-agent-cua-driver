# HR-agent(猎聘)

基于猎聘的 HR Agent:AI 按岗位 JD 主动搜索猎聘人才库,评分筛选在线简历,通过者自动打招呼,候选人回复后索要简历并入库。

## 架构

单机集中式:

- **backend/**:Spring Boot 3 + Java 17 + MyBatis-Plus + MySQL,通过子进程驱动 liepin-cli(Node.js CLI,浏览器自动化)
- **frontend/**:Vue3 + Element Plus 管理后台(岗位/账号/候选人台账/用户)
- **deploy/**:部署脚本(liepin-cli 安装、MinIO、登录态备份、前端构建)
- AI 层:AgentScope Java 框架,底层接国内模型 API(DeepSeek/Qwen/GLM)
- 简历存储:MinIO 对象存储 + MySQL 元数据(StorageService 抽象,可切本地文件系统)
- 告警:飞书自定义机器人 webhook(任务失败/账号熔断/登录态失效)

## 环境要求

- JDK 17+、Maven 3.9+、Node.js 20+ / npm、MySQL 8+、Chrome
- **Chrome 必须为有头模式**(无头 UA 矛盾会被猎聘风控零误报识别,实测导致账号限制)
- Docker(可选,MinIO 部署)

## 快速开始(开发)

```bash
# 1. 建库(首次)
mysql -uroot -p -e "CREATE DATABASE IF NOT EXISTS hr_agent DEFAULT CHARACTER SET utf8mb4;"
mysql -uroot -p hr_agent < backend/src/main/resources/sql/schema.sql

# 2. 安装 liepin-cli(fork 治理:建议 fork 后固定 commit 安装)
sh deploy/install-liepin-cli.sh <fork仓库地址> <commit>

# 3. 后端(首次启动自动创建 admin / admin123,请尽快修改)
cd backend
DB_PASSWORD=xxx AI_API_KEY=sk-xxx mvn spring-boot:run

# 4. 前端(开发模式,代理 /api 到 8080)
cd frontend && npm install && npm run dev
```

## 生产部署(单机)

```bash
# 1. 基础设施:MySQL + MinIO
cd deploy && docker compose up -d && sh init-minio.sh

# 2. 构建含前端的可部署 jar
sh deploy/build-frontend.sh
cd backend && mvn package -DskipTests

# 3. 运行(环境变量见下表)
java -jar target/hr-agent-backend-0.1.0-SNAPSHOT.jar
```

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| DB_HOST / DB_PORT / DB_NAME | localhost / 3306 / hr_agent | MySQL 连接 |
| DB_USERNAME / DB_PASSWORD | root / (空) | MySQL 凭证 |
| JWT_SECRET | (dev 默认值) | 生产必须修改 |
| JWT_EXPIRE_HOURS | 12 | token 有效期 |
| SERVER_PORT | 8080 | 后端端口 |
| AI_BASE_URL | https://api.deepseek.com | 模型接口(OpenAI 兼容;Qwen/GLM 见 application.yml) |
| AI_API_KEY | (空) | 模型 API Key(必填,否则评分/话术不可用) |
| AI_MODEL | deepseek-chat | 模型名 |
| STORAGE_TYPE | minio | minio / local |
| MINIO_ENDPOINT / MINIO_ACCESS_KEY / MINIO_SECRET_KEY / MINIO_BUCKET | localhost:9000 / hr-agent-minio / ... / resumes | MinIO 连接 |
| FEISHU_WEBHOOK / FEISHU_SECRET | (空) | 飞书机器人告警(留空仅日志) |

## 运维手册

### 资源估算(评审 P2-13)

- **内存**:每个有头 Chrome 实例约 0.5~1GB,再加 Spring Boot 约 0.5GB。
  公式:常开机器内存 ≥ 2GB + 1GB × 同时活跃账号数
- **磁盘**:user-data-dir 每账号数百 MB;简历 PDF 每份几百 KB~几 MB

### 登录态管理(评审 P2-13)

- 每账号独立 `LIEPIN_USER_DATA_DIR`(默认 `~/.liepin-cli/profiles/account-<id>`)
- 扫码登录:后台「账号管理」页点「扫码登录」,浏览器弹出窗口本机扫码
- 备份/恢复:`sh deploy/backup-userdata.sh backup` / `restore <目录>`
- 浏览器残留:多个实例锁定同一 user-data 时先 `liepin quit` 再操作

### 风控应对(评审 P0-3)

- 有头 Chrome 硬约束;单账号串行;403/captcha 自动熔断(停该账号任务+飞书告警)
- 账号级操作节奏(默认 30s)+ 每日打招呼配额(默认 20)
- 熔断恢复:管理员在后台编辑账号,重置「熔断」标记与登录态后重新调度

### 告警(评审 P2-14,飞书机器人)

1. 飞书群 → 群机器人 → 自定义机器人(建议开启签名校验)
2. 配置 `FEISHU_WEBHOOK` 与 `FEISHU_SECRET`(未配置则仅本地日志)
3. 告警事件:搜索任务终态失败、账号风控熔断、账号登录态失效

### 异常演练清单(阶段 5)

| 场景 | 预期行为 |
|------|---------|
| CLI 命令超时 | 任务退避重试(30s×2^n),3 次后终态失败并告警 |
| CLI 非零退出 | 同上 |
| 风控页/验证码 | 账号自动熔断 + 飞书告警,任务终态 |
| 登录态失效 | 账号标记需扫码 + 告警,任务挂起等待扫码 |
| 进程崩溃 | 重启后调度器释放过期租约,任务自动恢复执行 |
| 重复打招呼 | 全局防重复联系(候选人维度唯一),自动跳过 |

## 测试

```bash
cd backend && mvn test   # H2 内存库,56 个用例覆盖 DAO/接口/权限/队列/评分/打招呼/简历收集
```

## 阶段进度

- [x] 阶段 1:项目骨架 + 基础数据
- [x] 阶段 2:能力 spike + liepin-cli 封装与搜索(真实搜索验证)
- [x] 阶段 3:AgentScope 评分 Agent + 打招呼(真实评分验证)
- [x] 阶段 4:简历入库(MinIO)+ 台账 + 权限
- [x] 阶段 5:集成验证与运维加固

## 合规提示

本系统通过浏览器自动化操作猎聘,存在账号被限制/封禁的合规风险,使用者需自行评估并承担相应责任。详见实施计划中的《合规与风险声明》。
