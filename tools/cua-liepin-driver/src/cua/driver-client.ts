/**
 * cua-driver CLI 客户端。
 *
 * 契约要点(W0 spike 实测,见 docs/superpowers/specs/2026-09-29-cua-driver-w0-spike.md):
 * - 每次 `cua-driver call <tool>` 是独立进程;必须携带同一 `session` 标签,
 *   prepare/bind/ref 才能跨调用生效;
 * - JSON 参数经 stdin 传入;
 * - 结构化拒绝(refusal)返回 JSON 且 exit code = 0,必须解析 status/refusal 字段;
 * - 输出形状未完全统一:浏览器类工具带 status(ok/refused);非浏览器类工具(如 list_windows)
 *   成功时无 status 字段;browser_click 拒绝还有 effect="refused"+error.code 形状——逐一兼容;
 * - session 标签有生命周期:过期/结束后普通动作会被拒绝("session has ended"),
 *   必须显式 start_session 复活;标签彻底不可复活('session_unavailable')时
 *   自动派生 base-1..base-N 新标签并重试一次(2026-09-29 真机验证);
 * - exit code 非 0 仅表示用法/进程级失败。
 */

import { CuaError, truncate } from "../contract.js";
import { defaultRunner, type ProcessRunner } from "./process.js";

/** 会话迁移档位上限(base-1..base-N;防御标签连续死亡下的无限派生) */
export const SESSION_MIGRATION_SLOTS = 3;

export interface DriverClientOptions {
  bin: string;
  session: string;
  timeoutMs: number;
  runner?: ProcessRunner;
}

export interface ToolCallResult {
  tool: string;
  /** ok=成功;refused=结构化拒绝(调用方按业务语义处理) */
  status: "ok" | "refused";
  /** refused 时的拒绝码(如 browser_consent_required / browser_ref_stale) */
  refusalCode?: string;
  refusalMessage?: string;
  /** 解析后的 JSON 载荷(status=ok 时为工具输出;refused 时为完整拒绝体) */
  data: Record<string, unknown>;
  /** 原始 stdout(诊断用) */
  raw: string;
}

export class DriverClient {
  private readonly runner: ProcessRunner;
  /** 当前活动会话标签(可因迁移而变化:base → base-1..base-N) */
  private activeSession: string;

  constructor(private readonly opts: DriverClientOptions) {
    this.runner = opts.runner ?? defaultRunner;
    this.activeSession = opts.session;
  }

  /** 当前活动会话标签(诊断/测试用) */
  get sessionLabel(): string {
    return this.activeSession;
  }

  /** 调用一个 cua-driver 工具;拒绝不抛错,由调用方决定语义 */
  async callTool(tool: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    return this.callToolInternal(tool, args, false);
  }

  private async callToolInternal(
    tool: string,
    args: Record<string, unknown>,
    retriedAfterSessionFix: boolean,
  ): Promise<ToolCallResult> {
    const payload = JSON.stringify({ ...args, session: this.activeSession });
    const res = await this.runner(this.opts.bin, ["call", tool], {
      stdin: payload,
      timeoutMs: this.opts.timeoutMs,
    });

    if (res.timedOut) {
      throw new CuaError("failed", `cua-driver call ${tool} 超时(${this.opts.timeoutMs}ms)`);
    }
    if (res.code !== 0) {
      // 会话标签生命周期(2026-09-29 两次真机实测):
      // - "session has ended":闲置过期,start_session 可复活;
      // - "session_unavailable":标签不可复活,需派生新标签(base-1..base-N);
      // 修复后重试一次(幂等)。
      const output = res.stderr + res.stdout;
      if (!retriedAfterSessionFix && /session has ended|session_unavailable/i.test(output)) {
        const fixed = await this.migrateSession();
        if (fixed) {
          return this.callToolInternal(tool, args, true);
        }
      }
      throw new CuaError(
        "failed",
        `cua-driver call ${tool} 非零退出 code=${res.code}: ${truncate(res.stderr || res.stdout)}`,
      );
    }

    const data = parseOutput(tool, res.stdout);

    // 形状①:status=refused(status/refusal)
    if (data.status === "refused") {
      const refusal = (data.refusal ?? {}) as Record<string, unknown>;
      return {
        tool,
        status: "refused",
        refusalCode: typeof refusal.code === "string" ? refusal.code : "unknown",
        refusalMessage: typeof refusal.message === "string" ? refusal.message : "",
        data,
        raw: res.stdout,
      };
    }
    // 形状②:effect=refused(error.code;browser_click 等动作类工具)
    if (data.effect === "refused") {
      const error = (data.error ?? {}) as Record<string, unknown>;
      return {
        tool,
        status: "refused",
        refusalCode: typeof error.code === "string" ? error.code : "unknown",
        refusalMessage: typeof error.message === "string" ? error.message : String(data.summary ?? ""),
        data,
        raw: res.stdout,
      };
    }
    // 失败形状:isError=true(MCP 风格的错误包)
    if (data.isError === true) {
      const structured = (data.structuredContent ?? {}) as Record<string, unknown>;
      throw new CuaError(
        "failed",
        `cua-driver call ${tool} 失败(${String(structured.code ?? "isError")}): ` +
          truncate(String(structured.message ?? res.stdout)),
      );
    }
    // 形状③:成功——status=ok 或非浏览器工具的裸输出(无 status 字段)
    if (data.status === "ok" || data.status === undefined) {
      return { tool, status: "ok", data, raw: res.stdout };
    }
    throw new CuaError("failed", `cua-driver call ${tool} 返回异常状态: ${truncate(res.stdout)}`);
  }

  /** 调用并要求成功;拒绝抛 CuaError(附拒绝码,便于上层识别 setup/授权问题) */
  async requireOk(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = await this.callTool(tool, args);
    if (result.status === "refused") {
      throw new CuaError(
        "failed",
        `cua-driver 拒绝 ${tool}(${result.refusalCode}): ${result.refusalMessage ?? ""}`.trim(),
      );
    }
    return result.data;
  }

  /**
   * 会话修复(2026-09-29 真机:标签会闲置死亡且 start_session 可能返回
   * session_unavailable):先尝试复活当前标签,再逐档派生 base-1..base-N;
   * 成功返回 true 并切换 activeSession。
   */
  private async migrateSession(): Promise<boolean> {
    if (await this.ensureSession(this.activeSession)) {
      return true;
    }
    for (let i = 1; i <= SESSION_MIGRATION_SLOTS; i++) {
      const candidate = `${this.opts.session}-${i}`;
      if (await this.ensureSession(candidate)) {
        this.activeSession = candidate;
        return true;
      }
    }
    return false;
  }

  /** start_session(label) 幂等;退出码 0 视为可用 */
  private async ensureSession(label: string): Promise<boolean> {
    try {
      const res = await this.runner(this.opts.bin, ["call", "start_session"], {
        stdin: JSON.stringify({ session: label }),
        timeoutMs: this.opts.timeoutMs,
      });
      return !res.timedOut && res.code === 0;
    } catch {
      return false;
    }
  }

  /** cua-driver 版本(`--version`) */
  async version(): Promise<string> {
    const res = await this.runner(this.opts.bin, ["--version"], { timeoutMs: this.opts.timeoutMs });
    if (res.code !== 0) {
      throw new CuaError("failed", `cua-driver --version 失败: ${truncate(res.stderr || res.stdout)}`);
    }
    return res.stdout.trim();
  }
}

/** 解析工具输出;非 JSON 抛错(带工具名与原始片段,便于定位) */
function parseOutput(tool: string, stdout: string): Record<string, unknown> {
  try {
    return JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    throw new CuaError("failed", `cua-driver call ${tool} 输出非 JSON: ${truncate(stdout)}`);
  }
}
