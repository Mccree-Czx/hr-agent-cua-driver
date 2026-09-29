/**
 * 运行配置(env 注入;后端 CuaDriverExecutor 通过环境变量传入账号上下文)。
 */

export interface DriverConfig {
  /** cua-driver 可执行文件(CUA_DRIVER_BIN,默认从 PATH 查找) */
  bin: string;
  /** 会话标签:必须全程一致,否则 prepare/bind/ref 在多次 CLI 调用间失效(W0 验证) */
  session: string;
  /** 账号独立 Chrome profile 目录(LIEPIN_USER_DATA_DIR;用于窗口匹配/后续启动,W5) */
  profileDir: string | null;
  /** 猎聘 Chrome 窗口标题匹配(LIEPIN_WINDOW_TITLE_MATCH,默认 猎聘|liepin) */
  windowTitleMatch: RegExp;
  /** 单次 cua-driver call 超时 */
  callTimeoutMs: number;
  /** Chrome 可执行文件路径(CHROME_PATH,预留:W5 浏览器生命周期) */
  chromePath: string | null;
}

export const DEFAULT_SESSION = "hr-agent";
export const DEFAULT_BIN = "cua-driver";

export function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DriverConfig {
  const titlePattern = env.LIEPIN_WINDOW_TITLE_MATCH?.trim() || "猎聘|liepin";
  return {
    bin: env.CUA_DRIVER_BIN?.trim() || DEFAULT_BIN,
    session: env.CUA_SESSION?.trim() || DEFAULT_SESSION,
    profileDir: env.LIEPIN_USER_DATA_DIR?.trim() || null,
    windowTitleMatch: new RegExp(titlePattern, "i"),
    callTimeoutMs: Number.parseInt(env.CUA_CALL_TIMEOUT_MS ?? "", 10) || 60_000,
    chromePath: env.CHROME_PATH?.trim() || null,
  };
}
