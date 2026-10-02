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

  // Gondolin build ids are content-derived, so rebuilding identical input
  // yields the same id; the newer record replaces the older one.
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

  private async read(): Promise<ImagesFile> {
    const parsed = await readJsonFile<Partial<ImagesFile>>(this.file);
    return { images: Array.isArray(parsed?.images) ? parsed.images : [] };
  }

  private write(data: ImagesFile): Promise<void> {
    return writeJsonFile(this.file, data);
  }
}
