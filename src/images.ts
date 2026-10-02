import { getImageObjectDirectory } from "@earendil-works/gondolin";
import fs from "node:fs/promises";
import path from "node:path";

import { dataDir, readJsonFile, writeJsonFile } from "./datafile.js";

export interface ImageRecord {
  buildId: string;
  name: string;
  arch: string;
  createdAt: string; // ISO 8601
  ociDigest: string;
}

interface ImagesFile {
  images: ImageRecord[];
}

export function defaultImagesPath(): string {
  return path.join(dataDir(), "images.json");
}

export class ImageStore {
  // Writes are chained so that two builds finishing together do not lose one
  // another's record through interleaved read-modify-write.
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string = defaultImagesPath()) {}

  async list(): Promise<ImageRecord[]> {
    await this.queue.catch(() => {});
    return (await this.read()).images;
  }

  async get(buildId: string): Promise<ImageRecord | undefined> {
    return (await this.list()).find((i) => i.buildId === buildId);
  }

  // The newest record built from the same OCI image whose assets are still on
  // disk. Gondolin builds are not reproducible (every build of identical input
  // gets a new build id), so the OCI digest is what identifies "the same image".
  async findReusable(ociDigest: string, arch: string): Promise<ImageRecord | undefined> {
    const candidates = (await this.list())
      .filter((i) => i.ociDigest === ociDigest && i.arch === arch)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const c of candidates) if (await assetsPresent(c.buildId)) return c;
    return undefined;
  }

  // A record with the same build id is replaced rather than duplicated.
  record(rec: ImageRecord): Promise<void> {
    const op = this.queue.then(async () => {
      const cur = await this.read();
      cur.images = cur.images.filter((i) => i.buildId !== rec.buildId);
      cur.images.push(rec);
      await this.write(cur);
    });
    this.queue = op.catch(() => {});
    return op;
  }

  remove(buildIds: ReadonlySet<string>): Promise<void> {
    const op = this.queue.then(async () => {
      const cur = await this.read();
      cur.images = cur.images.filter((i) => !buildIds.has(i.buildId));
      await this.write(cur);
    });
    this.queue = op.catch(() => {});
    return op;
  }

  private async read(): Promise<ImagesFile> {
    const parsed = await readJsonFile<Partial<ImagesFile>>(this.file);
    return { images: Array.isArray(parsed?.images) ? parsed.images : [] };
  }

  private write(data: ImagesFile): Promise<void> {
    return writeJsonFile(this.file, data);
  }
}

export async function assetsPresent(buildId: string): Promise<boolean> {
  const st = await fs.stat(getImageObjectDirectory(buildId)).catch(() => undefined);
  return st?.isDirectory() ?? false;
}
