# cua-liepin-driver

HR Agent 的猎聘 **UI 驱动适配器**:通过 [trycua/cua](https://github.com/trycua/cua) 的 Cua Driver,以**真实 UI 操作**(元素级点击/输入 + 快照验证)替代 liepin-cli 的"注入 fetch 直调内部接口",恢复真实请求链路以降低风控面。

> 状态:W2 外发类命令已实现(UI 通道,38 单测);三要素与流程**真机联调待登录后补**;
> 机制验证见 `docs/superpowers/specs/2026-09-29-cua-driver-w0-spike.md`。
> 其余命令(读类/附件/管理)在 W3+ 逐波落地。

## 工作原理(W0 实测结论)

1. **附加**:`browser_prepare`(existing_profile)→ 对已登录 Chrome 启用受控 DevTools 端点并授权;
2. **绑定**:`get_browser_state`(pid+window_id)→ 签发 `target_id`/`tab_id`;
3. **快照**:`get_browser_state`(semantic_v2)→ 无障碍语义树(含文本/角色/动作),约 1s/页;
4. **动作**:`browser_click` 按 ref 点击(trusted 真实输入、**后台投递不抢焦点**);
5. **验证**:每次动作后重新快照核对状态变化(旧 ref 随新快照失效)。

关键约束:
- 守护进程必须以 `cua-driver serve --grant existing-profile` 启动,否则直接得到结构化拒绝 `browser_consent_required`;
- 所有 `cua-driver call` 必须携带**同一 session 标签**(env `CUA_SESSION`);
- session 标签有生命周期(空闲结束/重启后失效):普通动作会被拒绝,适配器会自动 `start_session` 复活并重试一次;
- 窗口挑选:优先可见窗口,最小化窗口作为兜底(CDP 驱动不要求窗口可见,2026-09-29 实测);
- JSON 参数经 stdin 传递(UTF-8);结构化拒绝是 exit 0,解析 JSON `status` 字段。

## 命令

```bash
npm install
npm run build     # tsc → dist/
npm test          # build + node --test(含 mock 单测;真实环境冒烟见下)
npm run dev       # build + 运行 CLI

# 真实环境自检(本机已装 cua-driver 时)
node dist/cli/index.js doctor --json
node dist/cli/index.js doctor --attach --json   # 额外做附加+快照冒烟

# W2 外发类命令(UI 通道;--dry-run 只定位不执行,联调期先用)
node dist/cli/index.js greet <resume_id> --ejobId <jobId> [--jobTitle <标题>] [--message <话术>] --json
node dist/cli/index.js request-resume <resume_id> [--imId <对方会话>] --json
node dist/cli/index.js send-message <resume_id> --text <消息> --json
```

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `CUA_DRIVER_BIN` | `cua-driver`(PATH) | cua-driver 可执行文件 |
| `CUA_SESSION` | `hr-agent` | 会话标签(必须全程一致) |
| `LIEPIN_USER_DATA_DIR` | 空 | 账号 Chrome profile 目录(后端注入) |
| `LIEPIN_WINDOW_TITLE_MATCH` | `猎聘\|liepin` | 窗口标题匹配正则 |
| `CUA_CALL_TIMEOUT_MS` | `60000` | 单次 cua-driver call 超时 |
| `CHROME_PATH` | 空 | Chrome 路径(预留,W5 浏览器生命周期) |

## 目录结构

```
src/
  contract.ts            # 退出码(0/1/2/3)与错误契约、风控标记扫描
  config.ts              # env 配置装载
  cua/process.ts         # 子进程抽象(测试可注入 mock)
  cua/driver-client.ts   # cua-driver call 封装(stdin JSON/session/拒绝解析/session 复活)
  cua/window.ts          # list_windows 解析与猎聘窗口挑选(纯函数;最小化兜底)
  cua/session.ts         # prepare→bind→snapshot/query/click
  cua/ui-actions.ts      # 匹配器/等待/点击/键入/证据 步骤原语(可注入时钟)
  flows/common.ts        # 简历页 URL、IM 面板、发消息
  flows/greet.ts         # 打招呼步骤机(职位弹窗保守处理)
  flows/request-resume.ts# 索要简历步骤机(死按钮复测路径)
  cli/args.ts            # 参数解析
  cli/index.ts           # CLI 入口(契约:退出码/--json)
  commands/doctor.ts     # 自检命令
  commands/outbound.ts   # greet/request-resume/send-message 处理器
  commands/registry.ts   # 命令字面量(已实现/待实现)
```

## 后续波次

- W2(已完成):greet / request-resume / send-message(UI 执行 + 页面证据验证;后端命令级路由) — 真机联调待登录
- W3:chatlist / chatmsg / recommend / resume / search / joblist(抽取契约)
- W4:attach-fetch / attach-download(下载通道)
- W5:jobpublish / jobdelete / login / 浏览器生命周期(无 CDP 启动、常驻保活)
