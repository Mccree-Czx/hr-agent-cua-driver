#!/usr/bin/env node
/**
 * cua-liepin-driver CLI 入口。
 *
 * 契约(与 liepin-cli 一致,后端 LiepinCommandService/CuaDriverExecutor 依赖):
 *   退出码 0 成功 / 1 一般错误 / 2 登录态失效 / 3 风控异常;--json 输出机器可读结果。
 */

import { loadConfigFromEnv } from "../config.js";
import { exitCodeOf, truncate } from "../contract.js";
import { doctor } from "../commands/doctor.js";
import { isPendingCommand } from "../commands/registry.js";
import { handleLogin } from "../commands/login.js";
import { handleJobdelete, handleJobpublish } from "../commands/jobs.js";
import { handleGreet, handleRequestResume, handleSendMessage } from "../commands/outbound.js";
import {
  handleChatMsg,
  handleChatlist,
  handleJoblist,
  handleRecommend,
  handleResume,
  handleSearch,
} from "../commands/reads.js";
import { handleAttachDownload, handleAttachFetch } from "../commands/attachments.js";
import { parseArgs } from "./args.js";

const VERSION = "0.1.0";

function printHelp(): void {
  console.log(`cua-liepin-driver ${VERSION} - 猎聘 UI 驱动适配器(cua-driver based)

用法: cua-liepin-driver <命令> [选项]

已实现命令:
  doctor                                          环境自检(--attach 附加+快照冒烟;--json 输出 JSON)
  login [--timeout <秒>] [--force]                登录检测/等待扫码(登录态有效时直接复用;--json)
  greet <resume_id> --ejobId <id>                 打招呼(--jobTitle 职位标题;--message 话术;
                                                   --dry-run 只定位不执行;--allow-unverified)
  request-resume <resume_id> [--imId <对方会话>]  索要简历(--dry-run/--allow-unverified)
  send-message <resume_id> --text <消息>          向已建会话发送消息(--dry-run)
  resume <resume_id>                              在线简历详情读取(want_title + raw_text)
  recommend [--jobId <id>] [--url <页面>]         推荐列表页抽取;--capture-ids --ref <pN:M>...
                                                   点击穿透取 resume_id(联调原语,--dry-run 抑制点击)
  search --url <页面>                             人才搜索页抽取(--url 待联调确认)
  chatlist --url <页面>                           沟通列表页抽取(--url 待联调确认)
  chatmsg --url <会话页> | --name <候选人名>         会话消息读取(附件卡片迹象检测;
         --name=会话名键模式,替代 im_id,自动导航 /chat/im 并点开会话)
  joblist [--url <页面>] [--with-ids] [--capture-ids --ref <pN:M> ...]  职位列表页抽取(默认 /job/manager;结构化 records)
        点击穿透取 ejob_id(--with-ids 自动逐行穿透并合并进 records;--id-param 默认 ejob_id)
  attach-fetch --url <会话页> --out <目录>        附件检出+下载(三态输出;--imId 留痕;--dry-run)
  attach-download --url <会话页> --out <目录>     附件下载(任一失败非零退出)

W5 管理类命令(部分校准):
  jobpublish --data <JSON> [--draft-only]         发布职位(UI 表单:填写+保存/发布+校验反馈;
                                                  字段支持范围见输出 unvalidated_fields)
  jobdelete --job <id[,id..]>                     删除职位(安全闸:--confirm-destructive;
                                                  穿透匹配 ejob_id → 全选 → 结束;删除入口待校准)

计划内命令(W5+ 续,当前为占位应答):
  (jobpublish/jobdelete 已实现 v1;搜索引擎等扩展项待评估)

公共选项: --json(JSON 输出,步骤日志走 stderr)
外部辅助: help | --version

环境变量:
  CUA_DRIVER_BIN             cua-driver 可执行文件(默认 PATH 查找)
  CUA_SESSION                会话标签(默认 hr-agent;必须全程一致)
  LIEPIN_USER_DATA_DIR       账号 Chrome profile 目录
  LIEPIN_WINDOW_TITLE_MATCH  窗口标题匹配(默认 猎聘|liepin)
  CUA_CALL_TIMEOUT_MS        单次 cua-driver call 超时(默认 60000)`);
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const args = parseArgs(rest);

  if (command === undefined || command === "help" || command === "--help") {
    printHelp();
    return command === undefined ? 1 : 0;
  }
  if (command === "--version" || command === "version") {
    console.log(`cua-liepin-driver ${VERSION}`);
    return 0;
  }

  if (command === "doctor") {
    const cfg = loadConfigFromEnv();
    const json = args.flags.json === true;
    const { code, report } = await doctor(cfg, {
      attach: args.flags.attach === true,
      log: json ? () => undefined : (line) => console.log(line),
    });
    if (json) {
      console.log(JSON.stringify(report, null, 2));
    }
    return code;
  }

  // W5 登录与浏览器生命周期
  if (command === "login") {
    const cfg = loadConfigFromEnv();
    return handleLogin(cfg, args);
  }

  // W5 管理类命令(职位发布/删除)
  if (command === "jobpublish") {
    const cfg = loadConfigFromEnv();
    return handleJobpublish(cfg, args);
  }
  if (command === "jobdelete") {
    const cfg = loadConfigFromEnv();
    return handleJobdelete(cfg, args);
  }

  // W2 外发类命令(UI 通道)
  if (command === "greet" || command === "request-resume" || command === "send-message") {
    const cfg = loadConfigFromEnv();
    if (command === "greet") {
      return handleGreet(cfg, args);
    }
    if (command === "request-resume") {
      return handleRequestResume(cfg, args);
    }
    return handleSendMessage(cfg, args);
  }

  // W3 读类命令(UI 读取抽取)
  if (command === "resume" || command === "recommend" || command === "search"
      || command === "chatlist" || command === "chatmsg" || command === "joblist") {
    const cfg = loadConfigFromEnv();
    switch (command) {
      case "resume":
        return handleResume(cfg, args);
      case "recommend":
        return handleRecommend(cfg, args);
      case "search":
        return handleSearch(cfg, args);
      case "chatlist":
        return handleChatlist(cfg, args);
      case "chatmsg":
        return handleChatMsg(cfg, args);
      default:
        return handleJoblist(cfg, args);
    }
  }

  // W4 附件类命令(UI 下载通道)
  if (command === "attach-fetch" || command === "attach-download") {
    const cfg = loadConfigFromEnv();
    return command === "attach-fetch"
      ? handleAttachFetch(cfg, args)
      : handleAttachDownload(cfg, args);
  }

  if (isPendingCommand(command)) {
    console.error(`${command}: 未实现(按全量替换计划在 W5+ 落地)`);
    return 1;
  }

  console.error(`未知命令: ${command}`);
  printHelp();
  return 1;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(truncate(String(err), 500));
    process.exit(exitCodeOf(err));
  });
