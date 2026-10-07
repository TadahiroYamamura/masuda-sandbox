import { Code, ConnectError } from "@connectrpc/connect";
import { getImageObjectDirectory } from "@earendil-works/gondolin";
import fs from "node:fs/promises";
import path from "node:path";

import { dockerTag } from "./build.js";
import { dataDir, readJsonFile, writeJsonFile } from "./datafile.js";
import { log } from "./log.js";
import { runLines } from "./proc.js";

export interface ImageRecord {
  buildId: string;
  name: string;
  arch: string;
  createdAt: string; // ISO 8601
  ociDigest: string;
  // The Docker image's Config.Env ("K=V"). Absent in records written before
  // S10; BuildImage fills it in when such a record is reused.
  env?: string[];
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

export async function bootableImage(images: ImageStore, buildId: string): Promise<{ image: ImageRecord; imageDir: string }> {
  const image = await images.get(buildId);
  if (!image) throw new ConnectError(`image ${JSON.stringify(buildId)} not found`, Code.NotFound);
  const imageDir = getImageObjectDirectory(buildId);
  const st = await fs.stat(imageDir).catch(() => undefined);
  if (!st?.isDirectory()) throw new ConnectError(`assets for image ${buildId} are missing (${imageDir})`, Code.FailedPrecondition);
  return { image, imageDir };
}

const BUILD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// 記録の無いbuild_idには何もしない。資産ディレクトリだけがあるのは、BuildImageが
// gondolin buildを終えてまだ記録していない途中でもありうるため（prune.tsのRECENT_MSと同じ事情）。
//
// 記録→資産の順に消すのはapplyPruneと同じ理由。Dockerのイメージは、同じOCIイメージから
// 作った記録がほかに残っていれば、まだ使われているものとして残す。Dockerの削除の失敗
// （ほかのタグやコンテナが使っている等）はRPCのエラーにせずログに残す。サービスの状態
// （記録と資産）は消せており、Dockerのイメージは利用者が別の用途で使っていることもあるため。
export async function deleteImage(images: ImageStore, buildId: string): Promise<void> {
  if (!BUILD_ID.test(buildId)) throw new ConnectError(`invalid build_id ${JSON.stringify(buildId)}`, Code.InvalidArgument);
  const rec = await images.get(buildId);
  if (!rec) return;
  await images.remove(new Set([buildId]));
  await fs.rm(getImageObjectDirectory(buildId), { recursive: true, force: true });
  log.info("image deleted", { buildId, name: rec.name });
  if ((await images.list()).some((r) => r.ociDigest === rec.ociDigest && r.arch === rec.arch)) return;
  for (const ref of [dockerTag(rec.arch, rec.ociDigest), rec.ociDigest]) {
    const lines: string[] = [];
    try {
      for await (const l of runLines("docker", ["image", "rm", ref])) lines.push(l);
    } catch (e) {
      // 再利用されたビルドはタグを作らないので、タグが無いのは普通のこと。
      if (lines.some((l) => /no such image/i.test(l))) continue;
      log.warn("removing a docker image failed", { buildId, ref, output: lines.join("\n"), error: e });
    }
  }
}
