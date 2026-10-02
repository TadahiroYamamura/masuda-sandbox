import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(base, "masuda-sandbox", "images.json");
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
    let raw: string;
    try {
      raw = await fs.readFile(this.file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { images: [] };
      throw e;
    }
    const parsed = JSON.parse(raw) as Partial<ImagesFile>;
    return { images: Array.isArray(parsed.images) ? parsed.images : [] };
  }

  private async write(data: ImagesFile): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2) + "\n");
    await fs.rename(tmp, this.file);
  }
}
