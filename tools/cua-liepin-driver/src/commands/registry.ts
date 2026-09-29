/**
 * 后端消费的命令名字面量(全量替换清单,W2+ 逐波实现)。
 * W1 仅提供字面量与占位应答,保证 CLI 面与后端路由对齐。
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

export function isPlannedCommand(name: string): name is PlannedCommand {
  return (PLANNED_COMMANDS as readonly string[]).includes(name);
}
