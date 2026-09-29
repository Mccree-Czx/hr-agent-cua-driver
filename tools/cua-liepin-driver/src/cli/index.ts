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
import { isPlannedCommand } from "../commands/registry.js";
import { parseArgs } from "./args.js";

const VERSION = "0.1.0";

function printHelp(): void {
  console.log(`cua-liepin-driver ${VERSION} - 猎聘 UI 驱动适配器(cua-driver based)

用法: cua-liepin-driver <命令> [选项]

命令:
  doctor            环境自检(--attach 做一次附加+快照冒烟;--json 输出 JSON)
  login/greet/request-resume/send-message/chatlist/chatmsg/recommend/resume/
  search/joblist/attach-fetch/attach-download/jobpublish/jobdelete
                    计划内命令(W1 骨架阶段未实现,按全量替换计划 W2+ 落地)
  help | --version

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

  if (isPlannedCommand(command)) {
    console.error(`${command}: 未实现(W1 骨架;按全量替换计划在 W2+ 落地)`);
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
