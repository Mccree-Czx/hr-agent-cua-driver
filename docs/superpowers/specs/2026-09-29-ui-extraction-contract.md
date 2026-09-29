# UI 抽取契约(读类命令,全量替换 W3)

日期:2026-09-29
状态:字段与 ID 获取策略已定义;**具体页面锚点/证据列表待登录联调校准**。
范围:chatlist / chatmsg / recommend / search / resume / joblist(后端实际消费的读类命令)。

## 1. 核心难题:内部 ID 在 UI 中不可见

后端是 ID 中心化架构(候选人按 `resume_id` 去重、会话按 `im_id` 路由、岗位按 `jobId` 同步)。
但 `resIdEncode` / `im_id` / `jobId` **不显示在页面上**,只能通过以下途径获得:

| ID | UI 获取策略 | 成本 | 状态 |
|----|------------|------|------|
| `resume_id`(resIdEncode) | 点击候选卡片 → 详情页 URL 的 `resIdEncode` 参数(已由 resume 详情页公式验证) | 每张卡 ≈1 次点击+1 次快照+1 次返回 ≈6-10s | 公式已验证;卡片可点击 ref 待联调 |
| `im_id`(opposite) | 打开会话 → 会话页 URL 参数(待联调确认是否含) | 每会话同上 | 待确认 |
| `jobId` | 职位编辑/详情页 URL(待联调确认) | 每职位同上 | 待确认 |

工程约束:
- 点击穿透受预算控制(`--capture-ids` + `--ref` 联调原语 + 上限),不默认开启;
- 联调期先用 `--dry-run`/原始抽取看到页面结构,再把"卡片/会话行"的 ref 识别规则固化为匹配器。

## 2. 命令级字段契约(UI 抽取 vs 旧 API 输出)

### 2.1 resume(优先级最高;评分链路依赖)

后端硬依赖(ScoringEngine/JobMatchEvaluator):
- `want_title`(文本,非空即可通过期望门禁;经 `、,，/` 拆分)
- `expectation_evidence`:**UI 通道不伪造**——该字段要求 `source="resumeDetailVo.jobWant.jobTitleNames"`(API 响应路径),UI 提取无法诚实声明该来源;走 `want_title` 回退路径(JobMatchEvaluator `titles.isEmpty()` 分支),语义等价。
- 其余字段:评分提示词直接消费快照全文,UI 输出 `raw_text`(页面全部文本行)即覆盖 AI 输入需求;`mergeResumeDetail` 仅补快照缺失字段,不覆盖既有。

UI 输出形状:
```json
{
  "resume_id": "<入参回显>",
  "source": "ui",
  "want_title": "Java开发、后端开发",
  "name": "<可选:标题区首行启发式>",
  "text_lines": 128,
  "raw_text": "姓名\n张三\n期望职位\nJava开发\n...",
  "extraction": { "url": "...", "want_title_source": "期望职位", "unvalidated": ["name"] }
}
```

### 2.2 recommend / search

- 后端关键消费:`saveCandidates` 需要 **`resume_id` + `name`**(缺任一即丢弃)。
- UI 分两步:① 列表页文本抽取(原始);② `--capture-ids` 点击穿透取 `resume_id`。
- 联调后固化:卡片截图/快照 → 姓名+职位文案的匹配器 → 自动逐卡穿透。
- 输出:原始 `lines` + `captures[]` + `extraction_status:"unvalidated"`;`resume_id` 缺失时后端**不得放行落库**(联调完成前 recommend/search 不切 UI)。

### 2.3 chatlist

- 后端消费:`im_id`(路由键)、`direction`(1=候选人最后发言)、`name`、`unread_count`、`latest_msg`。
- UI 抽取:`name`/`latest_msg`/`unread` 可见;`direction` **无可视等价物**(预览文本不标注发送方)→ 启发式:未读徽标存在 ⇒ direction=1;已读场景待联调验证(候选:预览前缀"我:"模式)。
- `im_id`:会话行点击穿透 → URL 参数(待确认)+ **会话映射缓存**(chatlist 写入 `CUA_CHAT_MAP_FILE`,chatmsg 读取)供后续按 im_id 定位会话行。

### 2.4 chatmsg

- 后端消费:发送方("对方"/"我")、消息类型/payload(附件卡片检测)、消息文本。
- UI 抽取:消息行文本;**发送方启发式**:头像/布局对齐(待联调);**附件检测反而比 API 更直观**——消息区出现"简历"/"附件"卡片文案即命中(旧 API 路线要解 bizType=7 载荷)。
- 入口:优先用 chatlist 缓存的 URL 直达会话;否则按 `--url` 联调。

### 2.5 joblist

- 后端消费:`jobId` + 标题/状态(同步到岗位管理)。
- UI:列表页文本抽取;`jobId` 点击穿透(职位详情/编辑 URL,待确认)。

### 2.6 attach-fetch / attach-download(W4)

- 后端消费(ChatPollService):成功 `{success:true, file(绝对路径,后端读字节后删除), fileName, sha256}`;
  无附件 `{success:false, reason:"no-attachment"}`(后端记探测标记不再重复);其余失败 `{success:false, reason, detail}` 下轮重试。
- UI 流程:会话页快照检出附件卡片(文件名样式 `.pdf/.doc/.docx` 优先,
  其次"简历/附件"文案,均需带 click 动作)→ `browser_download(ref, destination_root)`
  触发真实下载;**该工具不返回文件名/路径** → 以目标目录差集识别新落盘文件 →
  非空 + `%PDF-` 签名 + SHA-256 校验后输出 `file/fileName/bytes/sha256/sourceOrigin:"ui-download"`。
- 已知联调项:① 会话页 URL(im_id → URL)待确认;② `browser_download` 声明"需要 destructive-tool 审批",
  CLI 路径下是否需额外授权/是否会返回 `download-refused` 待实测;③ 文件名中的中文/编码兼容性。
- 注入纪律:下载目录必须为绝对路径(对齐后端 `attachWorkDir()`);非 PDF 附件拒绝入库(与 legacy 一致,doc/docx 待样本)。

## 3. 后端解析适配清单(联调验证后实施)

1. `SearchTaskService.saveCandidates`:`resume_id` 就绪前不放行 UI 通道(否则全员丢弃)。
2. `ChatPollService`:direction 启发式的置信度不足时,候选优先级按"未读优先"降级处理(设计待定,避免漏触发)。
3. `LiepinJobSyncService`:jobId 捕获完成前保持 legacy。
4. 评分门禁:`want_title` 路径已验证可过门禁(`hasExpectationFields`),无需改动。

## 4. 性能预算(UI 读类)

| 操作 | 估算 |
|------|------|
| 列表页打开+全文抽取 | ≈4-6s |
| 卡片点击穿透(取 ID) | ≈6-10s/卡 |
| 简历详情读取 | ≈5-8s/人 |
| 附件下载(检出+下载+校验) | ≈8-15s/份 |

影响:轮内 60 次简历读取的预算在 UI 化后需重估(见 W0 报告 §3 预留项);

- recommend 首批 20 人全量穿透 ≈2-3 分钟/岗位,建议联调后仅对新候选穿透(依赖快照中的姓名差集)。
- 节拍/预算参数(`resume-detail-*`, `recommend-gap-minutes`)的 UI 化重调在联调数据出来后进行。

## 5. 联调任务清单(登录后执行)

1. `recommend --jobId <id> --json` → 观察列表页 URL/结构;再 `--dry-run` 取卡片 ref;`--capture-ids --ref pN:M` 验证穿透取 ID。
2. `resume <真实resume_id> --json` → 校准 `want_title` 抽取(期望区块文案)与 raw_text 完整性。
3. `chatlist --json` → 确认会话页 URL、direction 启发式;`chatmsg` 会话定位。
4. `joblist --json` → 职位行结构与 jobId 穿透。
5. `attach-fetch --url <会话页> --out <目录> --json` → 校准附件卡片 ref 匹配与 `browser_download` 审批行为;再跑 `attach-download` 严格路径。
6. 固化匹配器与 URL 后,更新本契约文档"待确认"项为"已验证",并提交。
