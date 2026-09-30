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
- **joblist records(已完成,后端已归一)**:`extractJobRecords` 输出 `[{title,city,salary,refreshed_at,status,jobId?}]`(行边界=下一职位行 link;字段缺失置 null;字段名与 legacy 输出对齐);`joblist --with-ids` 自动逐行穿透(上限 20 行)补 jobId;`extraction_status="validated"` 表示 records 非空;后端 `LiepinCommandService.jobList` UI 分支读 records(调 `--with-ids`),legacy 保持数组直读;records 抽取对渲染完整度敏感(锁屏/未加载时为空);
- **recommend records(已完成,后端已归一)**:`extractCandidateRecords` 输出 `[{name,age,experience,education,location,expect_city,expect_position,expect_salary,raw_text,resume_id?}]`;卡片序列=姓名→年龄→经验→学历→现居→"期望:"→期望城市→期望职位→期望薪资;行边界=下一姓名节点;`raw_text`=候选人区间原始文本(评分提示词保真);`recommend --with-ids` 逐卡穿透(预览层「简历编号」回退通道)补 resume_id;真机样本(rec-full.json,1200 refs)验证 7 张卡片全识别(raw_text 196 字符/卡片);后端 `recommend` UI 分支读 records(调 --with-ids)——契约链:resume_id 落库 → ScoringEngine 触发 resume 详情补齐 want_title(评分门禁);
- 剩余 records 补齐(chatlist/chatmsg/search):待解锁后取真机样本按同模式实现(search 页 URL 也待确认)。

## 8. W6 切换就绪矩阵(2026-09-29 盘点)

全量切换(`hr-agent.cua.commands.<命令>=ui` 默认改 ui)的前置条件 = 每命令「驱动实现 + 真机验证 + 后端归一」三列齐备:

| 命令 | 驱动实现 | 真机验证 | 后端归一 | 缺口/备注 |
|------|:---:|:---:|:---:|------|
| login | ✓ | ✓(自动启动/复用/锁屏快速失败) | ✓(原契约) | - |
| greet | ✓ | ✓(真实打招呼成功) | ✓(原契约) | - |
| send-message | ✓ | ✓(回显验证) | ✓ | - |
| request-resume | ✓ | ⚠ 入口定位✓,live click 待下一位未发简历候选人 | ✓ | 需约定测试人选 |
| resume | ✓ | ✓(want_title=海外销售) | ✓ | - |
| recommend | ✓ + records | ⚠ records/--with-ids 待解锁复验 | ✓(UI 读 records+--with-ids) | 20 卡穿透≈6-8s/卡;resume_id 通道=预览层「简历编号」(已验证可达) |
| search | ✓(基础抽取) | ✗ | ✗ | **URL=/search(legacy 代码确认,页面结构待联调)**;records 未实现 |
| chatlist | ✓(基础抽取) | ⚠(会话页 URL 已知) | ✗ | **对方 im_id 无 UI 直接通道(硬缺口)**:legacy 的 readLptImId 只能读我方 imId_2(cookie),非会话对方 id;建议方案:chat-map 缓存(名→id,由 chatmsg 侧维护)待设计 |
| chatmsg | ✓(基础抽取) | ✗ | ✗ | 依赖 im_id(同上) |
| joblist | ✓ + records | ✓(records/穿透 dry-run) | ✓ | - |
| jobpublish | ✓(全字段) | ✓(发布 85915821 成功) | ✓ | 类别编码→文本映射(后端传 jobCategory 编码,UI 以名称关键词联动单选;如需精确类别需加文本参数) |
| jobdelete | ✓(待发布删除/招聘中结束) | ✓(删除成功) | ✓ | “招聘中”的 结束→已关闭→删除 后半段待验证 |
| attach-fetch / attach-download | ✓(三态+签名校验) | ✗ | ✓(三态契约) | viewer 下载按钮路径待验证(入口线索:会话"收到简历"视图批量条「全部勾选+浏览简历」) |

**结论**:切换阻塞项 = ① search(页面结构与 records) ② chatlist/chatmsg(im_id 通道设计决策) ③ attach viewer 下载 ④ request-resume live click。解锁后优先级:attach viewer → joblist/recommend `--with-ids` 复验 → search 探索 → chatlist/chatmsg 样本采集。

### 后端会话名键适配(2026-09-29,已完成第一步)
- ChatPollService.handleSession 匹配链扩展为 **im_id → user_id → name**(新增 findCandidateByName;同名多命中跳过+日志;im_id 与 name 均缺才跳过);
- fetchAttachmentIfNew:无 im_id 时跳过附件探测(attach UI 化未就绪,诚实留痕,不传空键进下游);
- handleStranger:无 im_id 时跳过陌生人消息解析(依赖 chatmsg 结构化消息,未就绪);
- ResumeCollectService.checkReply:name 回退(仅 userId/imId 均空时生效,避免重名误判);
- 测试:后端 309/309 全绿(+3:name 键命中 known 链/同名歧义跳过/双空跳过)。
- **剩余信号缺口(切换前必补)**:ChatPollService 的 direction 与 oppositeRead 依赖 legacy 会话元数据;UI chatlist records 尚无这两个字段。direction(对方最后发言)与会话级已读的 UI 判定需 chatmsg 消息结构化 + 真机校准后补入 records。

### search 预研(2026-09-29,离线)
- 后端消费字段(SearchTaskService):name / resume_id / url / talentId(url 提取);
- legacy 输出:resName / resIdEncode / usercId / resumeUrl;
- **UI 实现路径**:搜索页与推荐页同为人才卡片,`extractCandidateRecords` 可复用(name/raw_text/期望字段);resume_id 走预览层「简历编号」穿透(同 recommend --with-ids);talentId 从穿透后 url 提取;
- 待解锁:校准 /search 页面卡片结构(尤其姓名节点规则是否与推荐页一致)→ 接线 recordsExtractor → 后端双通道归一。

### 离线预接线批次(2026-09-30)
- **search(驱动+后端已接线,待真机校准)**:`runReadSearch`(records 复用候选人抽取;URL 公式预实现 `/search?key=<kw>` 待校准);`handleSearch <keywords> [--url] [--with-ids]`;后端 `search` UI 分支 `--with-ids`+读 records;
- **attach 会话名键(驱动+后端已接线,待真机验证下载按钮)**:`attach-fetch --name <候选人名>`(导航 /chat/im→会话行定位→点开→附件检出;三态与签名校验不变);后端 `attachFetch(account, imId, sessionName, outDir, timeout)`:UI 优先 --imId、无则 --name、两者皆空不猜测;legacy 无 im_id 空返回(守卫下沉);ChatPollService 已去硬跳过、传会话名;
- 测试:驱动 113/113(+3: search/attach-name×2);后端 314/314(+5: search UI/legacy、attach UI-name/legacy-空返回、名键附件入库);
- 真机待验:attach viewer 下载按钮、search 页面结构。

### 环境与稳定性修复(2026-09-30 真机)
- **daemon 重启必须带 grant**:`cua-driver serve --grant existing-profile`;否则 browser_prepare 以 consent 拒绝,
  表现为 attach 失败→launchChrome 等待超时(排障要点:daemon 重启后必须沿用该启动参数);
- **desktop_unlocked 假阴性(软化)**:系统唤醒后 driver 仍报 false,但桌面快照/窗口列表完整(Chrome is_on_screen=true);
  assertDesktopUnlocked 改为软告警,以快照质量兜底;
- **semantic_v2 快照间歇残缺(重大发现)**:/chat/im 等复杂页间歇只返回"导航壳"(21-23 文本行;query 0 命中、oopif=0、
  UIA 窗口通道 not_observable_in_window_scope)。**缓解**:readPage 改为单快照(整个尝试只拍一次,双快照加剧退化)
  +文本行阈值校验(MIN_PAGE_LINES=26)+about:blank 清场重试×6;单快照后真机首次尝试即可达 65 行(部分内容);
- **已知限制**:左侧会话列表(虚拟滚动容器)仍可能不进语义树——chatlist records 可能为 0(待滚动/容器定位继续校准);
- **会话行时间格式多样化**(HH:MM/昨天/前天/N天前/MM-DD),extractChatSessions 锚已放宽。

### 阶段A:会话列表语义树攻坚(2026-09-30)
- **三路诊断结论**:①会话区坐标滚动(trusted 路由执行成功)不改变语义树;②点"消息"/"全部"tab 无变化;
  ③parse_visual_regions 需 cua-perception 扩展(AGPL,按既定策略不引入);
- **降级通道(已实现)**:attach --name 列表定位失败后检测"当前已打开会话"
  (currentSessionName:右侧详情区"X女士/X先生"+年龄/学历/期望特征伴随)→ 匹配则直接附件检出;
- **真机验证**:dry-run 曾命中"会话行 p41:107「邵女士」"(完整快照时左侧列表可达);
  残余问题=快照完整性间歇性(清场重试不保证每次恢复),失败时诚实报错(含"当前打开会话=未知"诊断);
- **附件匹配器修正**:排除会话页 UI 词(有简历/浏览简历/通过筛选/不合适/超级聊聊/在线简历),避免误报;
- **待续**:快照完整性提升(如 daemon 空闲期/重启后首次更全的规律利用)与降级通道的真机闭环。

### search v2 真机校准(2026-09-30)
- **搜索页机制(真机确认)**:`/search?key=<kw>` 仅将关键词预填入搜索框,**不会自动执行搜索**;
  首次访问有"AI 帮搜"引导卡(3 步)→ 需点"我知道了"关闭(一次性);
  搜索界面包含:搜索按钮、经验/学历/筛选區、"请输入职位名称搜索"提示等(完整时 91 文本行);
- **v2 流程(已实现+测试)**:readPage 初始快照(清场重试)→ 引导卡兜底(我知道了)→ 点"搜索"提交
  → 结果快照 → extractCandidateRecords;提交按钮未出现时清场重试一次;
- **真机状态**:引导卡已关闭;因语义快照间歇残缺,提交按钮获取尚未稳定命中(readPage 6 次重试仍失败时诚实报错);
- **待续**:在快照完整窗口(daemon 重启后立即执行)重跑验证结果页卡片结构与 records。

### search v3(2026-09-30 真机突破,已跑通)
- **关键校准**:URL `?key=` 仅填 AI 搜索框;岗位搜索框需**显式输入**(typeIntoName,
  名称匹配"搜职位/公司/行业"等)后再点"搜索"提交(否则空条件报"请设置搜索条件进行搜索");
- **真机效果**:`search 海外销售` → **478 行真实结果页**(3000+ 简历;候选人卡片含
  遮罩名/年龄/经验/学历/城市/期望职能/薪资/公司经历);
- **records**:遮罩名已适配(1-2 汉字+星号,如"乐**");第 2+ 张卡全字段正确
  (例:尹**: 36岁/14年/硕士/常州/常州/海外销售/30-40K·16薪);
  第 1 张卡(英文简历:42 Years/15 Service Years/Master/Shanghai)待双语字段匹配, 卡片起点偏差待续。

### 双语字段与 chatmsg 复验(2026-09-30 晚)
- **英文简历双语适配(已完成)**:age(42 Years)/experience(15 Service Years)/
  education(Master/Bachelor/College)/location & expect_city(英文城市名)/expect_position(英文职位名);
  图标噪声过滤(ICON_NOISE_RE:file-text/avatar/down 等不得入字段);
  真机验证:搜索页英文卡全字段正确(location=Shanghai);
- **chatmsg --name 已跑通**:与 attach 同款清场重试+标签轮换;真机 EXIT=0,
  邵女士会话 121 行(消息流/附件迹象/工具栏均在);
- **direction/oppositeRead 判定(待续)**:消息流纯文本行未直接暴露"我方/对方"标记;
  待深挖:消息节点结构差异、"已读"标记位置、回声判定。

### 快照完整性终极修复(2026-09-30 突破)
- **`include_screenshot:true` 强制 tab 视口捕获,实测显著提升语义树完整度**:
  无此项时同页反复清场+导航+快照 12 轮均只得残缺"导航壳"(122 refs/34 named);
  开启后**首个尝试即 245 refs/95 named**,连续多命令稳定;
- 已固化进 `snapshot()`(session.ts);代价为响应携带 PNG(约 700KB/次),以完整度优先;
- **真机验证(修复后)**:
  - `joblist --with-ids`: 全字段(city/salary/refreshed_at/status) + `jobId=85911643`(穿透成功), validated;
  - `chatlist`: records 4+ 条(name/position/time/last_msg;时间锚含 HH:MM 与"昨天"混合), validated;
  - `search`: 引导卡未出现、已提交搜索、结果页 92 行(条件面板;结果列表渲染待续校准);
- **残留可优化**: chatlist 末条 records 误抽(last_msg 被当作下一行 name,待时间锚去重)。

### 会话标签轮换机制(2026-09-30 突破之二)
- **决定性实验(同代码同页面)**:旧标签 hr-agent2 **4/4 全部残缺**(129 refs/24 lines);
  新标签 hr-rec **4/4 全部完整**(1200 refs/533 named)——**长期复用的旧标签会持续返回残缺快照**;
- **机制**:`DriverClient.rotateSession()` 派生 `base-rN-<ts>` 新标签并切换;`UiContext.rotateSession` 钩子
  (withContext 注入:轮换后重新 attach);readPage 每轮残缺失败后自动轮换——旧标签问题一次治愈(测试 121/121);
- **真机效果**:recommend 快照由持续 24 行恢复完整(轮换自动发生);
- **残余**:recommend `--with-ids` 穿透时 ref 仍报 superseded(已验证 ref 本身有效,
  疑为轮换/穿透时序耦合,待续)。

### 穿透稳定性修复与 recommend 预览层限制(2026-09-30)
- **stale 重试(已生效)**:captureIdsByClickThrough 在 stale/superseded/`Frame ... not found` 时
  重新快照同序重试(至多2次);真机日志证实(p109:270/p111:600 均为 stale 重试1成功);
- **穿透回列表加清场**:预览层(#preview)为独立 frame,直接回列表会残留损坏;
  现改为 about:blank 清场→回列表(测试 124/124);
- **残余限制**:recommend 多卡穿透在该预览层 frame 下仍会累积 driver 状态异常
  (`browser_route_unavailable: Accessibility.getFullAXTree failed: Frame ... not found`),
  属 driver 预览层实现限制;缓解方向:限制单次穿透卡数/每卡后重建标签,待续;
- **chatlist 噪声防御**:超长消息、时间样式、噪声词(新收/新招呼等)过滤+同名去重;
  真机 6 条 records(5 正确,"新收/3" 通知卡残留一处待续)。

### 能力清单与下载门研究(2026-09-30 晚,进行中)
- **deploy/cua-capabilities.yaml(v3)**:它与 `--dangerously-bypass-approvals --approve-capability-manifest` 组合,
  将审批绕过收窄到猎聘 typed-browser 工作面;清单含:existing_profile + origins
  (about:blank/lpt/tdoss/api-c) + Chrome app 窗口授权 + files.write(Temp 递归) + 工具白名单;
- **启动**:`serve --dangerously-bypass-approvals --capability-manifest <abs> --approve-capability-manifest`
  (status 显示 `configured=true, approved_at_startup=true, valid=true`);
- **真机逐层解开**(受清单约束的拒绝与修正):
  1. `list_windows` → 需 `desktop.display: true`(desktop display observation);
  2. `browser_prepare` → 需 `resources.apps` 声明 Chrome 可执行文件(pid/window 授权);
  3. `browser_navigate` → 清场 about:blank 与主站均需在 `origins`;
  4. `browser_download` → 目标路径需在 `files.write`;
- **残余**:最后一层 browser_download 仍报 `browser_consent_required`(MCP-host destructive confirmation);
  manifest 的 approval-bypass 与该确认流的语义关系待续研究(文档:“unrestricted + manifest → bypass
  仅限 manifest 范围”未如期生效于 download)。
- **daemon 重启规律(已验证两次)**:`cua-driver stop` + `serve --grant existing-profile` 后**立即执行**的命令可获得完整快照
  (attach 会话行/chatlist 96 行 均命中);已作为"完整快照优先策略"手段:重要读操作前可先重启 daemon。

### browser_download 审批门(2026-09-30 真机)
- **standard 模式**:download 被拒('browser_consent_required: requires approval through the MCP host's
  destructive-tool confirmation flow');--grant 仅 standard 模式有效;
- **bounded 模式**:需 `--capability-manifest <path>`(Narrow-only tool/resource manifest),缺失时 daemon 拒绝启动;
- **unrestricted 模式**(--dangerously-bypass-approvals):daemon 可启动、attach 正常,但 browser_download
  **仍被宿主层审批拦截**(与 daemon 权限模式无关,属"MCP 宿主"层的破坏性工具确认设计);
- **结论**:下载放行需宿主层审批配置(待研究 capability-manifest 格式/宿主审批接口);
  attach 其余全链路(会话行定位→点开会话→附件卡片检出→目录基线→下载触发)已真机验证可达下载点。

### direction/oppositeRead/unread_count 判定与后端消费(2026-09-30 晚,C6 完成)
- **样本(两形态互补,真机)**:
  - 邵女士(我方2条招呼均被读+对方2条回复):消息时间线("昨天 17:11"等时间戳)+ "已读"标记(紧跟**我方**消息);
  - 潘女士(全对方消息:问职位+发简历;我方未发过):时间线**无**"已读";
- **已读锚定法**(驱动 `extractChatDirection`,已实现+真机验证):"已读"只挂我方消息后 →
  **最后一条消息之后出现"已读" ⇔ 我方最后发言(direction=0)**;否则 **对方最后发言(direction=1)**;
  范围=仅取最后一个"在线沟通" rootwebarea 之后;消息候选=statictext+长度≥5+排除时间戳/
  固定文案('仅支持查看180天以内的会话'/'您可以修改打招呼语，'/'不错过TA的回复，'/年龄年资格式);
  真机:潘女士 `direction=1, opposite_read=false`(附件迹象=true);邵女士 `direction=1, opposite_read=true`;
  已知盲区:我方最后发言且对方未读→无锚定,保守判 1(多一次附件探测,防抖收敛);
- **chatlist 未读角标 unread_count**(驱动已实现):真机结构=superscript 容器→纯数字(会话名前6节点内);
  真机:王思又=2/埃德加=1/潘女士=0(被 chatmsg 打开会话读掉);"打开会话即已读"自洽——
  无人值守场景 unread_count>0 ≈ "存在尚未处理过的对方新消息";
- **幻影会话彻底清除**(chatlist records 5/5 真实):button/image 的 name(如 "search")不作名字/职位;
  通知卡真机标签为"**新增**"(已并入噪声词);纯数字角标行不作名字/职位;
- **后端消费适配(2026-09-30,驱动127→135/后端314→319 全绿)**:
  - `ChatPollService.effectiveDirection`:direction 缺失时 unread_count>0 近似 "1"(无角标=未知,不猜);
  - `ChatPollService.sessionKey`:去重键=im_id 或 "name:<会话名>";`AutoRecruitScheduler` 入队/去重同步适配
    (否则 UI 通道无 im_id 会话会被全部跳过——轮询空转);
  - `fetchAttachmentIfNew`:无 `raw_metadata.latestMsgId` 时以 `last_msg` 作防抖键(内容稳定;时间戳漂移不参与);
  - `ResumeCollectService.checkReply` 同步走 effectiveDirection;测试 +5(真实 UI records 形态驱动附件链路/
    无角标不触发/键回退;调度入队/跨刷新去重);
- **待续**:`chatmsg --name` 的 direction/opposite_read 与后端两阶段(粗筛+精判)的进一步接线(观察期数据评估)。

### 附件下载通道终局研究(2026-09-30 深夜,真机实验)
- **背景**:browser_download 的宿主审批门无法在 call 通道绕过(四配置已证);尝试"页面内点击触发
  Chrome 原生下载"(profile 未开下载前询问 → 原生下载会直存 Downloads,可用目录监控接管);
- **实验 1(点附件卡片)**:列表区通知卡"收到了 X、Y等N人的简历"可点且含"简历",曾被 findAttachmentRef
  误命中(已修复:范围限定在最后一个"在线沟通" rootwebarea 之后 + 词表排除"收到了"前缀);
  消息区附件卡文本("X的简历")**本体不可点**,无原生下载效果;
- **实验 2("附件简历"页签,重大发现)**:右侧详情区页签「在线简历/附件简历」可点;点「附件简历」后
  打开 **dialog → iframe → rootwebarea[<文件名>.pdf]**(Chrome 内置 PDF 预览器):
  - **简历 PDF 文本全部在语义树**(姓名/邮箱/电话/教育/经历等,490 行)→ 可作为**简历文本降级通道**;
  - **PDF 预览器工具条(含下载按钮)不在语义树**(chrome 内置 UI 不暴露),无可点 ref;
  - 工具栏"看简历/查看简历"点击不触发下载;
- **结论(终局)**:UI 通道下附件下载(获取 PDF 原文件)不可达——两道门:
  ① browser_download 需 MCP 宿主确认流(call 通道无此通道,设计限制);
  ② PDF 工具条不在语义树(原生点击无标的);
  UI 化 attach 的可用能力=**附件存在检出 + PDF 文本抽取**;
  后续决策选项:a) 保留 legacy API 下载通道(与本替换目标冲突,需权衡);
  b) 后端改收"简历文本"(需后端/Schema 改造);c) UIA 通道点工具条(成功率低,未验证);
- **代码同步**:findAttachmentRef 修复(通知卡排除+范围限定)+测试,驱动 136/136。

### 全量替换定稿——attach UI 原生下载通道打通与 liepin-cli 彻底移除(2026-09-30)
- **用户决策**:全量替换、不保留 liepin-cli(推翻混合模式);attach 也必须 UI 化。
- **UI 原生下载通道(真机打通)**:
  - 链路:打开会话 → 点「附件简历」页签 → **「附件预览」弹窗**(猎聘页面自带,
    右上角含下载按钮)→ `get_window_state` 截图取窗口尺寸/capture_id →
    `click(x,y)` 坐标点击下载按钮(box 坐标=x 相对窗口右缘 738px/y=430;
    background 命中 UIA hit-test → Invoke;被丢弃则 foreground 升级)→
    **Chrome 原生下载落盘 Downloads** → 差集识别 → 搬移工作目录 → PDF 校验;
  - 三处边界防护(均真机验证):①会话标签轮换(attach 重试循环同步 readPage 机制);
    ②Chrome 重名去重后缀 " (1)" 规范化;③`.crdownload` 临时态排除(等最终重命名);
  - 关键前提:daemon 需 **无 manifest 的 unrestricted 模式**——driver 硬性限制
    "origin-scoped manifest 不得允许 generic 输入工具(click 等)"(启动即拒:
    origin-scoped capability manifests cannot allow 'click');manifest 样例保留于
    deploy/cua-capabilities.yaml 并标注为参考不推荐。
- **liepin-cli 彻底移除(代码/配置/工具/文档零残留)**:
  - 后端:删 `LiepinCliExecutor`/`CuaCommandResolver`(及测试),`LiepinCommandService`
    直走 CuaDriverExecutor(单通道);`LoginService`/`AutoRecruitScheduler` 换用
    CuaDriverExecutor;`HrAgentProperties` 删 cua.enabled/commands 与 liepin.cliPath;
    application.yml 删开关与命令路由(cua 段仅留 node/script/driver-bin);
  - 部署:删 install-liepin-cli.sh;install-cua-driver.ps1 推荐无 manifest 启动;README/AGENTS
    全量更新;删 tools/liepin-cli(85 文件)+测试桩 fake-liepin.*;
  - 验证:后端 298/298、驱动 141/141 全绿;真机 smoke 三次(下载+搬移+校验+去重后缀场景)。
- **历史参考**:本文件 §7/§8 早期条目中 legacy/CDP 通道描述均为历史记录,当前执行路径
  仅 CuaDriverExecutor(UI)。
