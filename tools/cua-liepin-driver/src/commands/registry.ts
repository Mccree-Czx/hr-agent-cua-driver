/**
 * 后端消费的命令名字面量(全量替换清单)。
 *
 * W2 起:doctor/greet/request-resume/send-message 已实现(UI 通道);
 * 其余命令按波次(W3+)落地,未实现前 CLI 以占位应答(exit 1)。
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

/** 已实现命令(W2:外发类) */
export const IMPLEMENTED_COMMANDS: readonly string[] = ["greet", "request-resume", "send-message"];

/** 尚未实现的计划内命令(CLI 占位应答) */
export function isPendingCommand(name: string): name is PlannedCommand {
  return (PLANNED_COMMANDS as readonly string[]).includes(name) && !IMPLEMENTED_COMMANDS.includes(name);
}
