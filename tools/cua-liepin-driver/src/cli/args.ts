/**
 * 极简参数解析:位置参数 + --flag / --key value / --key=value。
 * 与 liepin-cli 的命令行观感保持一致,不引入依赖。
 */

export interface ParsedArgs {
  flags: Record<string, string | true>;
  /** 重复 flag 的全部取值(如 --ref a --ref b);未重复时为单元素数组 */
  multi: Record<string, string[]>;
  positional: string[];
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | true> = {};
  const multi: Record<string, string[]> = {};
  const positional: string[] = [];
  const record = (key: string, value: string | true): void => {
    flags[key] = value;
    if (typeof value === "string") {
      multi[key] = [...(multi[key] ?? []), value];
    }
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const body = token.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        record(body.slice(0, eq), body.slice(eq + 1));
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          record(body, next);
          i++;
        } else {
          record(body, true);
        }
      }
    } else {
      positional.push(token);
    }
  }
  return { flags, multi, positional };
}

/** flag 值读取(仅接受字符串值;true/缺省视为未提供) */
export function flagValue(args: ParsedArgs, name: string): string | null {
  const value = args.flags[name];
  return typeof value === "string" ? value : null;
}
