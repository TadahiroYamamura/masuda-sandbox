import fs from "node:fs";
import path from "node:path";

type Level = "debug" | "info" | "warn" | "error";

// ログのファイルの記述子。undefinedなら標準エラー出力に書く。
let fd: number | undefined;

function normalize(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = v instanceof Error ? { name: v.name, message: v.message } : typeof v === "bigint" ? v.toString() : v;
  }
  return out;
}

function write(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ time: new Date().toISOString(), level, msg, ...normalize(fields) }) + "\n";
  if (fd === undefined) {
    process.stderr.write(line);
    return;
  }
  // 1行ずつ同期で書く。非同期のストリームはプロセスが落ちたときに末尾の行を失いうる。
  try {
    fs.writeSync(fd, line);
  } catch {
    process.stderr.write(line);
  }
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => write("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => write("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => write("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => write("error", msg, fields),
};

/**
 * ログをfileに書くよう切り替える。回すのは起動のときだけ（前のファイルを.1にする）。動いている間に回すと、
 * 書き込みの途中で行がちぎれる・開き直しに失敗してログが止まる、といった壊れ方がありうるので、しない。
 * 開けなければ、ログを失わないよう標準エラー出力のままにし、その旨を標準エラー出力に書いてfalseを返す。
 */
export function logToFile(file: string): boolean {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  } catch (e) {
    process.stderr.write(`masuda-sandbox: cannot create the log directory (${(e as Error).message}); logging to stderr\n`);
    return false;
  }
  try {
    fs.renameSync(file, `${file}.1`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      process.stderr.write(`masuda-sandbox: cannot rotate ${file} (${(e as Error).message}); appending to it\n`);
    }
  }
  try {
    fd = fs.openSync(file, "a", 0o600);
  } catch (e) {
    process.stderr.write(`masuda-sandbox: cannot open the log file (${(e as Error).message}); logging to stderr\n`);
    return false;
  }
  return true;
}

/** ログをファイルに書いているか。 */
export function loggingToFile(): boolean {
  return fd !== undefined;
}

/** テスト用: 標準エラー出力に戻す。 */
export function logToStderr(): void {
  if (fd !== undefined) fs.closeSync(fd);
  fd = undefined;
}
