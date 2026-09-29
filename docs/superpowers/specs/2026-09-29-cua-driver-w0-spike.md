# CUA 驱动 W0 可行性 Spike 报告(猎聘)

日期:2026-09-29
状态:机制层验证通过;HR 控制台(登录态)三要素定位待补验
环境:Windows 22H2 + Chrome 154.0.8037.58 + cua-driver-rs 0.30.4(x86_64-windows,telemetry 已关闭)
本机约束:无 GPU/Docker/WSL;决策模型需走云端(本轮未用到视觉模型,语义树已含文本)

## 1. 验证结果总览

| 项目 | 结果 | 指标 |
|------|------|------|
| 安装 + doctor | 通过 | 二进制 v0.30.4;UIA 可用;交互会话正常;12 可见窗口 |
| 守护进程 | 通过 | autostart 已注册;`serve --grant existing-profile` 手动启动;stop/status 正常 |
| 附加已有 Chrome(existing_profile) | 通过 | 对**无调试端口启动**的正常 Chrome 运行时启用远程调试(设置页→切换→验证→关闭),副作用全部透明上报 |
| 绑定(bind) | 通过 | `binding_quality: exact`;target_id/tab_id 句柄签发;`mutation_allowed: true` |
| 语义快照(semantic_v2) | 通过 | 约 1.0s / 57-59KB / 220-230 节点;中文 UTF-8 正确;含 role/name/actions/visibility |
| 元素语义查询 | 通过 | 约 1.0s;返回 ref + actions(可定位"密码登录/忘记密码"等任意文案元素) |
| 按 ref 点击 | 通过 | 约 4.0s(含 CLI 启动);`route: trusted_input`、`delivery: background`(**不抢焦点**);点击后快照验证状态变化(双向往返均通过) |
| 结构化拒绝 | 通过 | `browser_consent_required`(无授权)/`browser_ref_stale`(失效 ref):JSON + **exit 0** |
| UIA 路径(不依赖 CDP) | 通过 | `get_window_state` 675ms / 1.6MB(含截图)/ 110 元素;element_index + px/ax 双档动作 |
| HR 控制台三要素定位 | 待补验 | 需登录态(见 §5) |

## 2. 对适配器设计决定性的事实(已验证)

1. **session 标签跨 CLI 调用持久**:`cua-driver call` 每次是独立进程,必须全程携带同一 `session` 标签(如 `hr-agent`),target_id/tab_id/ref 才在调用间有效。prepare 与 bind 必须同一会话(无标签隐式会话每次都是新的,会被拒绝)。
2. **授权链**:existing-profile 附加要求守护进程启动时带 `--grant existing-profile`;安装器注册的 autostart 任务**不带**该参数——生产环境需自管守护进程启动(W1/W5 落实部署方案)。
3. **附加流程**:`browser_prepare{pid, window_id, strategy.kind=existing_profile}` 一次性完成"启用远程调试 + 校验端点归属";绑定 `get_browser_state{pid, window_id}` 返回 exact 绑定。
4. **两条交互路径并存**:
   - `browser_*`(CDP,受控 DevTools 端点):可信输入、元素 ref、后台投递不抢焦点——**主路径**;
   - `click/type_text/get_window_state`(UIA/OS):完全绕开 CDP,但 Chromium DOM 后台点击为 known-dropped,需 `delivery_mode: "foreground"` 升级(动作级短暂切前台)——备用路径。
   - 备注:计划中"终态 Chrome 无调试端口启动"成立(正常启动,运行时经授权开关附加);但交互主路径仍走 CDP。若要求零 CDP 交互,需全量切 UIA+前台升级路径,成本/稳定性待专项验证(开放决策项)。
5. **ref 生命周期**:任何新快照使旧 ref 失效;流程须"快照→动作→新快照验证"。
6. **参数传递**:JSON 建议走 **stdin**(PowerShell 5.1 会剥引号且 `$OutputEncoding` 默认 ASCII 破坏中文;Node 无此问题,stdin 同为最稳)。
7. **错误契约**:`status: ok/refused` + `refusal.code`;exit code 0=调用成功(含拒绝),1=用法/未知工具——适配器解析 JSON 而非退出码。
8. **视觉模型非必需(重要)**:semantic_v2 语义树已含全部文本与动作,常规定位/抽取无需 VLM;VLM 仅留给语义树不可判定的场景——成本预期显著低于计划估算。

## 3. 实测耗时(单次 CLI 调用,含进程启动)

| 操作 | 耗时 |
|------|------|
| 语义快照(全页) | ~1.0s |
| 语义查询(定位元素) | ~1.0s |
| 点击(trusted,后台) | ~4.0s |
| UIA 窗口快照(含截图) | ~0.7s |
| 附加 prepare | 一次性,含设置页操作约数秒 |

一个动作闭环(快照→点击→验证)约 6s;轮内 30 次外发动作的 UI 化增量约 3 分钟,可容纳于 50 分钟平摊窗口。

## 4. 对既有架构的确认

- 90% 动作直调内部接口(无 UI 链路)的替换方向不变;`browser_click` 产生真实 UI 事件链。
- 频次类风控不受通道影响,节拍/预算/冻结复测保留设计不变。

## 5. 待补验清单(登录门槛,下次补验)

1. 候选人页"打招呼/立即沟通"入口定位(含职位选择弹窗结构);
2. 会话内"索要简历"快捷入口定位(重点:真实输入事件下此前 CDP 合成点击的"死按钮"能否激活);
3. IM 输入框(browser_type)与发送按钮定位;
4. 抽取质量:候选人卡片列表、在线简历、会话列表/消息的语义树字段可得性(评分输入对齐)。

补验纪律:只定位与打开/取消,不发消息、不打招呼;打开会话存在"标记已读"已知副作用(项目已接受)。

## 6. 结论与下一步

- 机制层 **go**:无否决项;主路径选定 `browser_* + semantic_v2`(可靠 + 真实 UI 链 + 后台不抢焦点)。
- 进入 W1:驱动骨架 + 后端执行器 + 命令级开关(默认 legacy)。
- 开放决策项(待 W2 数据):是否对特定动作走 UIA+前台升级的零 CDP 路径。
- 部署设计项:守护进程须带 `--grant existing-profile` 启动(替代安装器默认 autostart 参数)。
