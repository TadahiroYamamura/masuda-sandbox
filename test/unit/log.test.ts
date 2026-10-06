import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { log, loggingToFile, logToFile, logToStderr } from "../../src/log.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "masuda-sandbox-log-"));
}

describe("logToFile", () => {
  afterEach(() => {
    logToStderr();
    vi.restoreAllMocks();
  });

  it("ログの行をファイルに書き、標準エラー出力には書かない", () => {
    const file = path.join(tmp(), "logs", "masuda-sandbox-serve.log");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(logToFile(file)).toBe(true);
    log.info("listening", { socket: "/s" });
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ level: "info", msg: "listening", socket: "/s" });
    expect(stderr).not.toHaveBeenCalled();
  });

  it("起動のたびに前のファイルを.1に回し、その前の.1は残さない", () => {
    const file = path.join(tmp(), "logs", "masuda-sandbox-serve.log");
    for (const msg of ["first", "second", "third"]) {
      logToStderr();
      expect(logToFile(file)).toBe(true);
      log.info(msg);
    }
    expect(JSON.parse(fs.readFileSync(file, "utf8")).msg).toBe("third");
    expect(JSON.parse(fs.readFileSync(`${file}.1`, "utf8")).msg).toBe("second");
  });

  it("ディレクトリを作れないときは標準エラー出力のままにしてその旨を書く", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "logs"), "");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(logToFile(path.join(dir, "logs", "masuda-sandbox-serve.log"))).toBe(false);
    expect(loggingToFile()).toBe(false);
    expect(String(stderr.mock.calls[0]?.[0])).toContain("logging to stderr");
  });

  it("ディレクトリに書けずファイルを開けないときも標準エラー出力のままにする", () => {
    if (process.getuid?.() === 0) return; // rootは読み取り専用のディレクトリにも書ける
    const logs = path.join(tmp(), "logs");
    fs.mkdirSync(logs, { mode: 0o500 });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(logToFile(path.join(logs, "masuda-sandbox-serve.log"))).toBe(false);
      expect(loggingToFile()).toBe(false);
      expect(String(stderr.mock.calls.at(-1)?.[0])).toContain("cannot open the log file");
    } finally {
      fs.chmodSync(logs, 0o700);
    }
  });
});
