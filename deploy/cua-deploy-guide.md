# 猎聘 CUA 驱动替换 - 上线部署与观察期手册

> 适用版本:提交 `2311bd6` 及以后(全量替换定稿:liepin-cli 已彻底移除,CUA UI 通道为唯一执行路径)。
> 定稿日期:2026-09-30。

## 0. 总览

- **架构变化**:全部平台操作(登录/职位/沟通/搜索/推荐/简历/附件/消息)经 `tools/cua-liepin-driver` → cua-driver 以真实 UI 操作执行。
- **关键注意**:全量替换后**无配置开关**(无 `CUA_ENABLED`、无命令路由)——**部署即全量生效**。
- 上线流程:前置检查 → 部署 → 冒烟自检 → 观察期(≥7 天)→(异常时)回滚。

## 1. 上线前检查清单

### 1.1 cua-driver 安装与 daemon

```powershell
# 安装(含 doctor 自检)
powershell -ExecutionPolicy Bypass -File deploy/install-cua-driver.ps1

# 启动 daemon(推荐:unrestricted 无 manifest——务必常驻)
"C:\Users\<用户>\AppData\Local\Programs\Cua\cua-driver\bin\cua-driver.exe" serve --dangerously-bypass-approvals

# 验证
cua-driver status   # 期望: permission mode: unrestricted; capability manifest: configured=false
```

> **为何不用 capability manifest**:附件 UI 原生下载需要 `get_window_state`/`click` 等 UIA 工具,而 driver 硬性限制
> "声明 browser.origins 的清单不得同时允许 generic 输入工具"(启动即拒:`origin-scoped capability manifests cannot allow 'click'`)。
> `deploy/cua-capabilities.yaml` 仅保留为参考样例,当前部署不使用。
> 如需更小权限(仅附加/读操作,无附件事务):`serve --grant existing-profile`。

### 1.2 驱动模块构建

```bash
cd tools/cua-liepin-driver
npm install
npm run build      # 产物 dist/cli/index.js(后端经 CUA_SCRIPT_PATH 调用)
```

### 1.3 Chrome 与登录态

- **Chrome 必须为有头模式**(无头 UA 会被猎聘风控零误报识别)。
- 账号 profile 登录:后台「账号管理」→「扫码登录」(本机扫码)。
- 冒烟:`node dist/cli/index.js login --json` → 期望 `{"success":true,"state":"ok"}` 且 exit 0。

### 1.4 后端环境变量(必配)

| 变量 | 值 | 说明 |
|------|----|------|
| `CUA_NODE_PATH` | `node`(或绝对路径) | Node 可执行文件 |
| `CUA_SCRIPT_PATH` | `<仓库>/tools/cua-liepin-driver/dist/cli/index.js` | **必配**——留空时驱动启动即报错 |
| `CUA_DRIVER_BIN` | `<安装目录>/cua-driver.exe` | 留空则从 PATH 查找 |
| `LIEPIN_USER_DATA_DIR` | 账号 Chrome profile 目录 | 单账号手工配置;多账号由账号档案注入 |

## 2. 部署步骤

```bash
# 1. 构建含前端的可部署 jar
sh deploy/build-frontend.sh
cd backend && mvn package -DskipTests

# 2. 启动(环境变量见 1.4;数据库/存储/告警变量同 README)
java -jar target/hr-agent-backend-0.1.0-SNAPSHOT.jar

# 3. 账号:数据库 liepin_account 一条记录 + 完成扫码登录
```

**部署即全量生效**——启动后自动招聘轮次(06:00–23:00 整点)产生的全部平台操作均经 UI 通道执行。

## 3. 冒烟自检(逐命令,均需桌面解锁)

```bash
cd tools/cua-liepin-driver
node dist/cli/index.js login --json      # 期望: {"success":true,"state":"ok"} exit 0
node dist/cli/index.js chatlist --json   # 期望: count>0 + records(name/time/last_msg)
node dist/cli/index.js joblist --json    # 期望: records 含 jobId(穿透验证)
# 可选: node dist/cli/index.js recommend --jobId <ejobId> --json
```

失败判读:

| 现象 | 处理 |
|------|------|
| `会话行未找到...已重试 6 次` | 语义快照持续残缺:重启 daemon(1.1 参数)后重试(驱动已内置清场+标签轮换,通常自愈) |
| `browser_consent_required` | daemon 未按 1.1 推荐参数启动,重启修正 |
| `desktop_unlocked=false` 且快照残缺 | 桌面真锁屏:解锁后重试(唤醒后假阴性可忽略,以快照质量为准) |
| `no CDP target correlates` 等窗口错乱 | kill_app 终止 chrome → `login --json`(driver 自动重启浏览器并附加) |

## 4. 观察期(≥7 天)

每日执行 `deploy/observe.sql` 的 5 段查询:

1. **轮次概览**——对比上线前基线:关注 `errors`、`riskStops`、`abandoned`、轮次时长;
2. **风控信号明细**——期望**无新增**(suspects=0, riskStopped=0);
3. **放弃单元(abandoned)**——UI 通道单动作耗时高于旧 CLI,轮次时长自然变长;关注"过窗 abandoned"是否显著上升;
4. **错误轮次(errors)**——抽查 stats_json 原因;偶发驱动超时属预期(下轮幂等补做);
5. **账号状态**——login_status=NORMAL、circuit_breaker=0。

判定标准:

- **维持**:无风控信号 + 熔断 0 新增 + abandoned 不显著上升 + errors 可控(偶发驱动超时可接受);
- **回滚**:出现熔断、持续风控信号、或 abandoned 显著上升导致业务量明显下降。

## 5. 回滚步骤

- **常规回滚**(回到旧架构):`git revert 2311bd6`(恢复到含 liepin-cli 的 `096bb13` 基线)+ 重新构建部署;
  注意旧版依赖 liepin-cli 运行环境:`sh deploy/install-liepin-cli.sh <fork仓库> <commit>`
  (该脚本已随替换移除,回滚时用 `git show 096bb13:deploy/install-liepin-cli.sh` 恢复)。
- **紧急止血**(保留新版,停全部平台动作):后台「自动招聘」开关 OFF——
  立即停外发/轮询等平台操作(业务层开关,存库持久化)。
- 全量替换后**无命令级开关**;单命令级降级需按 git 历史恢复对应版本。

## 6. FAQ / 问题自查

- **Q: 快照突然残缺(会话行找不到)?**
  A: 驱动 readPage/attach 已内置"清场重试 + 标签轮换";连续失败时重启 daemon(1.1)后重试。
- **Q: daemon 重启后 attach 被拒?**
  A: 启动参数必须为 `serve --dangerously-bypass-approvals`(或受限的 `--grant existing-profile`)。
- **Q: 附件下载失败(`download-no-file` / `download-click-failed`)?**
  A: 依次检查:①「附件简历」页签能否手动点开(弹窗出现);②窗口尺寸是否变化(下载按钮坐标=窗口宽-738, y=430,
  窗口尺寸变化需重新校准);③ Downloads 目录权限与空间;④ `.crdownload` 停留(驱动已排除,等待 Chrome 最终重命名)。
- **Q: 窗口尺寸变化如何校准下载按钮坐标?**
  A: 打开附件预览弹窗 → `get_window_state` 截图 → 目测下载按钮坐标 → 更新 `attachments.ts` 的
  `DL_BUTTON_RIGHT_OFFSET` / `DL_BUTTON_Y` 基准并跑 `npm test`。
- **Q: 登录态失效如何恢复?**
  A: 后台「账号管理」→「扫码登录」;驱动对登录失效以退出码 2 上报,账号自动标记 NEED_SCAN。
