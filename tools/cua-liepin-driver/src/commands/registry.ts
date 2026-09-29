/**
 * 后端消费的命令名字面量(全量替换清单)。
 *
 * W2 起:doctor/greet/request-resume/send-message 已实现(UI 通道);
 * W3 起:resume/recommend/search/chatlist/chatmsg/joblist 已实现(UI 读取抽取);
 * W4 起:attach-fetch/attach-download 已实现(UI 下载通道);
 * W5 起:login/jobpublish/jobdelete 已实现(浏览器生命周期+登录检测;职位发布/删除 v1);
 * 其余命令按波次(W5+)落地,未实现前 CLI 以占位应答(exit 1)。
 */

export const PLANNED_COMMANDS = [
  "login",
  "greet",
  "request-resume",
  "send-message",
  "chatlist",
  "chatmsg",
  "recommend",
  "resume",
  "search",
  "joblist",
  "attach-fetch",
  "attach-download",
  "jobpublish",
  "jobdelete",
] as const;

export type PlannedCommand = (typeof PLANNED_COMMANDS)[number];

/** 已实现命令(W2 外发类 + W3 读类 + W4 附件类 + W5 登录/管理类) */
export const IMPLEMENTED_COMMANDS: readonly string[] = [
  "login",
  "jobpublish",
  "jobdelete",
  "greet",
  "request-resume",
  "send-message",
  "resume",
  "recommend",
  "search",
  "chatlist",
  "chatmsg",
  "joblist",
  "attach-fetch",
  "attach-download",
];

/** 尚未实现的计划内命令(CLI 占位应答) */
export function isPendingCommand(name: string): name is PlannedCommand {
  return (PLANNED_COMMANDS as readonly string[]).includes(name) && !IMPLEMENTED_COMMANDS.includes(name);
}
