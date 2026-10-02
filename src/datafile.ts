import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function dataDir(): string {
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(base, "masuda-sandbox");
}

export async function readJsonFile<T>(file: string): Promise<T | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  return JSON.parse(raw) as T;
}

// Written to a temporary file and renamed so that a crash mid-write never
// leaves a truncated file for the next start to choke on.
export async function writeJsonFile(file: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2) + "\n");
  await fs.rename(tmp, file);
}
