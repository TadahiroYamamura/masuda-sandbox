import { Code, ConnectError, type ServiceImpl } from "@connectrpc/connect";
import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import fs from "node:fs/promises";
import path from "node:path";

import { buildImage, parseArch } from "./build.js";
import { ImageSchema, ListImagesResponseSchema, ListSandboxesResponseSchema, SandboxService, type Image } from "./gen/masuda/sandbox/v1/sandbox_pb.js";
import type { ImageRecord, ImageStore } from "./images.js";
import { log } from "./log.js";
import { ProcessError } from "./proc.js";
import type { SandboxRegistry } from "./registry.js";

function toImage(r: ImageRecord): Image {
  return create(ImageSchema, { buildId: r.buildId, name: r.name, arch: r.arch, createdAt: timestampFromDate(new Date(r.createdAt)), ociDigest: r.ociDigest });
}

// Methods left out of the returned object are answered with Unimplemented by
// the Connect router.
export function sandboxServiceImpl(registry: SandboxRegistry, images: ImageStore): Partial<ServiceImpl<typeof SandboxService>> {
  return {
    async *buildImage(req, ctx) {
      const arch = parseArch(req.arch);
      if (!arch) throw new ConnectError(`unsupported arch ${JSON.stringify(req.arch)}`, Code.InvalidArgument);
      if (!req.contextDir) throw new ConnectError("context_dir is required", Code.InvalidArgument);
      const contextDir = path.resolve(req.contextDir);
      const st = await fs.stat(contextDir).catch(() => undefined);
      if (!st?.isDirectory()) throw new ConnectError(`context_dir ${contextDir} is not a directory`, Code.InvalidArgument);

      log.info("image build started", { contextDir, name: req.name, arch });
      try {
        for await (const ev of buildImage({ contextDir, dockerfile: req.dockerfile || "Dockerfile", name: req.name, arch, signal: ctx.signal })) {
          if ("log" in ev) {
            yield { event: { case: "logLine", value: ev.log } };
            continue;
          }
          const rec: ImageRecord = { buildId: ev.built.buildId, name: req.name, arch, createdAt: new Date().toISOString(), ociDigest: ev.built.ociDigest };
          await images.record(rec);
          log.info("image built", { ...rec });
          yield { event: { case: "built", value: toImage(rec) } };
        }
      } catch (e) {
        log.error("image build failed", { contextDir, name: req.name, error: e });
        if (ctx.signal.aborted) throw new ConnectError("build cancelled", Code.Canceled);
        if (e instanceof ProcessError) throw new ConnectError(e.message, Code.Internal);
        throw e;
      }
    },
    async listImages() {
      return create(ListImagesResponseSchema, { images: (await images.list()).map(toImage) });
    },
    listSandboxes() {
      return create(ListSandboxesResponseSchema, { sandboxes: registry.list() });
    },
    getSandbox(req) {
      const sb = registry.get(req.id);
      if (!sb) throw new ConnectError(`sandbox ${JSON.stringify(req.id)} not found`, Code.NotFound);
      return sb;
    },
  };
}
