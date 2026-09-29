# UI 抽取契约(读类命令,全量替换 W3)

日期:2026-09-29
状态:字段与 ID 获取策略已定义;**具体页面锚点/证据列表待登录联调校准**。
范围:chatlist / chatmsg / recommend / search / resume / joblist(后端实际消费的读类命令)。

## 1. 核心难题:内部 ID 在 UI 中不可见

后端是 ID 中心化架构(候选人按 `resume_id` 去重、会话按 `im_id` 路由、岗位按 `jobId` 同步)。
但 `resIdEncode` / `im_id` / `jobId` **不显示在页面上**,只能通过以下途径获得:

| ID | UI 获取策略 | 成本 | 状态 |
|----|------------|------|------|
| `resume_id`(resIdEncode) | **会话预览层(#preview)「简历编号」字段值**(序列:标签→冒号→字母数字串);命中后导航 `resume/detail?resIdEncode=<值>` 验证 | 每会话 ≈1 次点击+2 次快照 ≈6-8s | **已解决(2026-09-29)**:实测 `eb75dde295fdSc7f903cb4428` 打开目标候选人简历;推荐卡片简版预览无此字段(无需:业务使用时序在 IM 阶段) |
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

## 5. 联调校准记录(2026-09-29,登录后真机)

### 已验证/已修复
- **窗口匹配**:登录后页面标题不含“猎聘”(如“推荐人才”);改为按账号 profile 目录匹配 Chrome 进程命令行(已改代码+真机验证),标题匹配降级为兜底。
- **会话页 URL**:**`https://lpt.liepin.com/chat/im`**(标题“在线沟通”;旧 /im 已不可用;捕获方式:点击顶部导航“沟通”并连拍 URL)。
- **推荐页交互**:每张卡片右侧有 **「立即沟通」按钮**(单页 20 个,ref 可定位);点击头像打开 **`#preview` 预览层**(含完整简历+「立即沟通/意向沟通/获取电话/超级聊聊」);**列表/预览均无单独“打招呼”文案**,统一为“立即沟通”。
- **快照预算**:semantic_v2 单页 300 节点(实测 total 1769),正文可能被挤出;已强化:合并 refs+content_refs + 跟随 continuation 续页(最多 3 页);真机 refs 234→1197。
- **简历抽取**:真机验证 `求职意向` 区块命中 want_title=“海外销售”(城市列表/薪资行/右侧栏文案截断已校准)。
- **resIdEncode 获取路径(已解决)**:会话预览层(`#preview`)存在「简历编号」字段(statictext 序列:标签→冒号→字母数字串);实测值 `eb75dde295fdSc7f903cb4428` 导航 `resume/detail?resIdEncode=<值>` 成功打开目标候选人简历(标题=候选人名)。已回写代码:`extractResumeNo`(extract.ts) + `captureIdsByClickThrough` 预览层回退(`id_source=preview`),单测覆盖。
- **会话面板结构(邵女士会话实测)**:「在线简历」「附件简历」(tab)、「看简历」、「查看简历」(button,点击后打开 `#preview` 预览层)、附件简历真实文件名(如「邵越-中文简历.pdf」)。
- **推荐页简版预览(差异确认)**:推荐卡片预览层**无「简历编号」、无「查看简历」**;可点击入口为 展开/查看全部N个/获取电话/意向沟通/立即沟通/保存/操作记录/收藏/转发/打印/举报。resIdEncode 仅在 IM 会话预览层可得(业务时序:先沟通后有会话,链路自洽)。

### 待解决
- **索要简历 live click**:三要素已定位(索要简历按钮/IM 输入框/发送按钮),打招呼与消息发送已真机验证;索要简历点击留待下一位未发简历的候选人验证。
- **附件下载 viewer 路径**:预览层「浏览简历」为批量操作(需勾选行),单附件下载入口待确认(W4 通道已就绪,`browser_download` 待真机校准)。
- **会话行→im_id 映射**:会话页 URL 未携带 im_id(建议方案:chat-map 缓存,待 W5+ 评估)。
- 首次引导弹窗(“点击这里,查看下一份简历”)出现一次后消失,重登后可能再现,流程需容忍。

## 6. 联调任务清单(登录后执行)

1. `recommend --jobId <id> --json` → 观察列表页 URL/结构;再 `--dry-run` 取卡片 ref;`--capture-ids --ref pN:M` 验证穿透取 ID。
2. `resume <真实resume_id> --json` → 校准 `want_title` 抽取(期望区块文案)与 raw_text 完整性。
3. `chatlist --json` → 确认会话页 URL、direction 启发式;`chatmsg` 会话定位。
4. `joblist --json` → 职位行结构与 jobId 穿透。
5. `attach-fetch --url <会话页> --out <目录> --json` → 校准附件卡片 ref 匹配与 `browser_download` 审批行为;再跑 `attach-download` 严格路径。
6. 固化匹配器与 URL 后,更新本契约文档"待确认"项为"已验证",并提交。

## 7. W5 管理类校准记录(2026-09-29,真机)

### 登录/浏览器生命周期(login 命令,已验证)
- **登录态 UI 判定**:页面同时呈现「人才推荐 + 职位管理」工作台导航 → 已登录;URL 含 /login|/signin|/passport → 未登录;安全验证特征无导航 → 风控页(提示人工过滑块并继续等待)。真机验证:`login --json` → `{"success":true,"reused":true,"state":"ok"}` exit 0。
- **Chrome 调试授权确认框**:新调试目标偶发弹出原生框「要允许远程调试吗?」(多个共存时 `browser_prepare` 以 `browser_wrong_target_refused` 拒绝);处理:list_windows 检测标题 → get_window_state 取「允许」按钮 element_token → UIA click(已入 session.ts `dismissDebugConsentPrompts`,ensure 流程自动调用)。
- **浏览器启动**:`launchChrome`(CHROME_PATH → 常见安装路径探测;--user-data-dir + 无 CDP 参数,detached 不阻塞 CLI);找不到窗口且允许启动时轮询等待 30s。

### joblist(已验证)
- 默认页 `https://lpt.liepin.com/job/manager`;行=可点击职位名 link;点击行 → `job/detail/preview?ejob_id=xxx`(**jobId 获取路径,已验证**);`--capture-ids --ref` 穿透,`--id-param` 默认 ejob_id。真机:`joblist --json` exit 0,71 行。

### jobpublish(完整发布链路已真机跑通 2026-09-29)
- 表单页 URL 直达:`https://lpt.liepin.com/job/publish?ejobActionType=publish`;
- **名称+类别一步填**:职位名称框(首个 combobox+type;空值时不可见)→`browser_type`关键词→下拉“推荐职位名称”出现含“>”的路径选项→点击→名称与类别同时落值(实测:输入“销售”→选“销售/客服 > 销售管理 > 销售经理/主管”→名称=销售经理、类别=销售经理/主管);
- **UIA 定位公式(关键)**:`get_window_state` 的 frame 为屏幕物理像素(DPR=2,内容区原点 y=286),换算 `CSS=(x/2,(y-286)/2)`;对空下拉(经验/学历/薪资/部门) semantic 不可见,必须 UIA 定位→`browser_click` 坐标点击→选项出现;
- 工作经验=detailWorkyear、学历=detailEdulevel(点击+精确匹配选项点击);薪资=rc_select_4/rc_select_6(选项为纯数字节点,需新节点差集定位);部门=ComboBox label=“所属部门”(点击+type 输入);城市/地址:UIA 点击+选择历史地址建议;
- **滚动/漂移教训**:点击 offscreen 元素会触发页面滚动(跨脚本坐标失效);每字段应“UIA 实时定位→立即点击”单脚本内完成;文案类元素可用“点 offscreen 招聘人数”触发滚动到 02 区;
- **提交**:「发布职位」按钮→跳转 `job/publish/result?ejobIds=<id>`(URL 带出 ejob_id)→职位进入“待发布”页签(审核后自动上线);实测发布成功(85915821);
- `--draft-only` 对应「保 存」下拉菜单中的“保存草稿”。

### jobdelete(待发布删除路径已真机验证 2026-09-29)
- 勾选:仅「全选」可定位(semantic 中列表区**最后一个可点击 labeltext**;UIA CheckBox label=全选);**单行 checkbox 无语义节点**;
- **“招聘中”页签**:勾选后批量条出现「刷新/结束」(无删除)→ 结束→确认→删除入口待续;
- **“待发布”页签(已跑通)**:勾选后出现 **「delete 删除」** → 点击 → 确认弹窗(文本“删除职位会将对应职位下的应聘简历也一起删除，您确定要删除？”，确认按钮同为“delete 删除”，取最后一个可点删除按钮) → **行消失=删除成功**;实测测试职位 85915821 已删除;
- v1 安全闸保留:仅当「目标职位=当前页签全部可见行」才全选;`--confirm-destructive` 二次确认闸。

### 环境观察(高频问题)
- **Chrome 调试授权确认框**(要允许远程调试吗)在新窗口/新目标时**高频再现**;`ensureBrowserSession` 先清障再附加;多窗口共存时偶发 `no CDP target correlates` 或 attach 超时——重跑一次通常可恢复(观测到 3 次自愈);
- 用户可能同时使用 Chrome(新窗口/关闭),联调应在每步前用 ensure 重新附加,不缓存窗口状态;
- **会话标签迁移(已实装)**:标签闲置死亡后 start_session 可能返回 `session_unavailable`(不可复活),旧逻辑仅覆盖 `session has ended` 导致命令全挂;driver-client 现自动逐档派生 `base-1..base-3` 新标签并重试一次;真机验证:死亡 base(hr-agent) 下 `joblist --json` exit 0;注意标签在同一 CLI 调用内一致,target/ref 不跨调用复用,故迁移安全;
- **附件下载入口(部分确认)**:会话页"收到简历"视图底部有批量条「全部勾选 + 通过筛选 + 不合适 + 浏览简历」;"浏览简历"疑为简历/附件查看入口(viewer 内下载按钮待用户空闲时验证);
- **桌面锁定(锁屏)快速失败**:锁屏下 Chrome 内容区渲染冻结(快照只剩导航骨架、列表/消息为空,refs 约 99),driver `desktop_unlocked=false`;驱动已在命令入口(withContext)与 ensure 流程快速失败并给出明确错误(真机验证 EXIT=1:"Windows 桌面已锁定...");无人值守部署需保持会话解锁;
- **joblist records(结构化首切片,W6 适配起点)**:`extractJobRecords` 输出 `[{name,location,salary,refreshed_at,status}]`(行边界=下一职位行 link;字段缺失置 null;不含 jobId——列表文本层不可得,id 由点击穿透补充);`extraction_status="validated"` 表示 records 非空;records 抽取对渲染完整度敏感(锁屏/未加载时为空);
- **recommend records(已完成,离线样本验证)**:`extractCandidateRecords` 输出 `[{name,age,experience,education,location,expect_city,expect_position,expect_salary}]`;卡片序列=姓名→年龄→经验→学历→现居→"期望:"→期望城市→期望职位→期望薪资;行边界=下一姓名节点;真机样本(rec-full.json,1200 refs)验证 7 张卡片全识别、字段准确(个别缺字段诚实 null);resume_id 仍需点击穿透补充;
- 剩余 records 补齐(chatlist/chatmsg/search):待解锁后取真机样本按同模式实现。
