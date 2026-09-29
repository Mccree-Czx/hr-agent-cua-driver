/**
 * 子进程执行抽象:便于单测注入 mock(默认实现走 child_process.spawn)。
 *
 * JSON 参数经 stdin 传入(W0 验证的最稳路径:绕开 PowerShell 引号/编码问题,
 * 也与 `cua-driver call` 官方建议一致)。
 */

import { spawn } from "node:child_process";

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunOptions {
  stdin?: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}

export type ProcessRunner = (cmd: string, args: string[], opts: RunOptions) => Promise<ProcessResult>;

export const defaultRunner: ProcessRunner = (cmd, args, opts) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { env: opts.env ?? process.env, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, opts.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr + String(err), timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });

    if (opts.stdin !== undefined) {
      child.stdin.write(opts.stdin, "utf8");
    }
    child.stdin.end();
  });
