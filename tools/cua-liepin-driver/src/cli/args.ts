/**
 * 极简参数解析:位置参数 + --flag / --key value / --key=value。
 * 与 liepin-cli 的命令行观感保持一致,不引入依赖。
 */

export interface ParsedArgs {
  flags: Record<string, string | true>;
  positional: string[];
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | true> = {};
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const body = token.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[body] = next;
          i++;
        } else {
          flags[body] = true;
        }
      }
    } else {
      positional.push(token);
    }
  }
  return { flags, positional };
}

/** flag 值读取(仅接受字符串值;true/缺省视为未提供) */
export function flagValue(args: ParsedArgs, name: string): string | null {
  const value = args.flags[name];
  return typeof value === "string" ? value : null;
}
