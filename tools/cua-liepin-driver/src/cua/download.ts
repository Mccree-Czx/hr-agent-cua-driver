/**
 * 附件下载与校验工具(W4)。
 *
 * `browser_download` 不返回文件名/路径(契约),因此落盘文件通过"目标目录差集"识别;
 * 校验语义与 legacy attach-fetch 对齐:非空 + PDF 签名(%PDF-)+ SHA-256 记录;
 * 输出 file 字段为绝对路径(后端将从该路径读字节并随后删除,见 ChatProducerService#storeFetchedAttachment)。
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { CuaError } from "../contract.js";

export interface FileStamp {
  name: string;
  size: number;
  mtimeMs: number;
}

/** 目标目录白名单校验:必须绝对路径;不存在则创建;返回规范化(realpath)路径 */
export function ensureAbsoluteDir(dir: string): string {
  if (!isAbsolute(dir)) {
    throw new CuaError("failed", `下载目录必须是绝对路径: ${dir}`);
  }
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return realpathSync(dir);
}

/** 目录快照(文件名 → 大小/mtime),用于差集识别新落盘文件 */
export function listDir(dir: string): FileStamp[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => {
      const full = join(dir, e.name);
      const st = statSync(full);
      return { name: e.name, size: st.size, mtimeMs: st.mtimeMs };
    });
}

export interface WaitFileOptions {
  timeoutMs?: number;
  pollMs?: number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

/**
 * 等待目录中出现(相对 before 的)新文件;返回新文件的绝对路径。
 * 多文件同时出现时取 mtime 最新者;超时返回 null。
 */
export async function waitForNewFile(
  dir: string,
  before: FileStamp[],
  opts: WaitFileOptions,
): Promise<string | null> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const pollMs = opts.pollMs ?? 1_000;
  const deadline = opts.now() + timeoutMs;
  const known = new Set(before.map((f) => f.name));

  for (;;) {
    const fresh = listDir(dir)
      .filter((f) => !known.has(f.name) && f.size > 0)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    if (fresh.length > 0) {
      return join(dir, fresh[0].name);
    }
    if (opts.now() >= deadline) {
      return null;
    }
    await opts.sleep(pollMs);
  }
}

export interface ResumedFileValidation {
  bytes: number;
  sha256: string;
  /** 文件头签名(magic) */
  magic: string;
}

/** 校验落盘简历文件:非空 + PDF 签名;返回 bytes/sha256/magic */
export function validateResumeFile(filePath: string): ResumedFileValidation {
  const buf = readFileSync(filePath);
  if (buf.length === 0) {
    throw new CuaError("failed", `附件内容为空: ${filePath}`);
  }
  const magic = buf.subarray(0, 5).toString("latin1");
  if (magic !== "%PDF-") {
    throw new CuaError("failed", `附件非 PDF(文件头=${JSON.stringify(magic)}),拒绝入库`);
  }
  return {
    bytes: buf.length,
    sha256: createHash("sha256").update(buf).digest("hex"),
    magic,
  };
}

/** 文件名(输出 fileName 用) */
export function fileNameOf(filePath: string): string {
  return basename(filePath);
}
