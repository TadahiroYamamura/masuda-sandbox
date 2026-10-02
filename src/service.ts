import { Code, ConnectError, type ServiceImpl } from "@connectrpc/connect";
import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { getImageObjectDirectory } from "@earendil-works/gondolin";
import fs from "node:fs/promises";
import path from "node:path";

import { buildImage, parseArch } from "./build.js";
import { runExec } from "./exec.js";
import { readGuestFile, writeGuestFile } from "./files.js";
import { DestroySandboxResponseSchema, ImageSchema, ListImagesResponseSchema, ListSandboxesResponseSchema, SandboxService, SetPolicyResponseSchema, WriteFileResponseSchema, type CreateSandboxRequest, type Image } from "./gen/masuda/sandbox/v1/sandbox_pb.js";
import type { ImageRecord, ImageStore } from "./images.js";
import { log } from "./log.js";
import { ProcessError } from "./proc.js";
import type { SandboxRecord, SandboxRegistry } from "./sandboxes.js";

function toImage(r: ImageRecord): Image {
  return create(ImageSchema, { buildId: r.buildId, name: r.name, arch: r.arch, createdAt: timestampFromDate(new Date(r.createdAt)), ociDigest: r.ociDigest });
}

const DEFAULT_MEMORY_MIB = 4096;
const DEFAULT_CPUS = 4;

function toRecord(req: CreateSandboxRequest): SandboxRecord {
  if (!req.id) throw new ConnectError("id is required", Code.InvalidArgument);
  if (!req.buildId) throw new ConnectError("build_id is required", Code.InvalidArgument);
  if (!req.defaultUser) throw new ConnectError("default_user is required", Code.InvalidArgument);
  const e = req.sshEgress;
  return {
    id: req.id,
    buildId: req.buildId,
    createdAt: new Date().toISOString(),
    defaultUser: req.defaultUser,
    memoryMib: req.memoryMib || DEFAULT_MEMORY_MIB,
    cpus: req.cpus || DEFAULT_CPUS,
    env: { ...req.env },
    policy: { allowedHosts: [...(req.policy?.allowedHosts ?? [])], enabledSecrets: [...(req.policy?.enabledSecrets ?? [])] },
    secretNames: req.secrets.map((s) => s.name),
    tcpMaps: req.tcpMaps.map((m) => ({ host: m.host, port: m.port, upstream: m.upstream })),
    sshEgress: e && { allowedHosts: [...e.allowedHosts], agentSocket: e.agentSocket, knownHostsFile: e.knownHostsFile, pushAllowedRefs: [...e.pushAllowedRefs] },
  };
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
    async createSandbox(req) {
      const record = toRecord(req);
      const image = await images.get(record.buildId);
      if (!image) throw new ConnectError(`image ${JSON.stringify(record.buildId)} not found`, Code.NotFound);
      const imageDir = getImageObjectDirectory(record.buildId);
      const st = await fs.stat(imageDir).catch(() => undefined);
      if (!st?.isDirectory()) throw new ConnectError(`assets for image ${record.buildId} are missing (${imageDir})`, Code.FailedPrecondition);
      try {
        return await registry.create(record, req.secrets, imageDir);
      } catch (e) {
        if (e instanceof ConnectError) throw e;
        log.error("sandbox boot failed", { id: record.id, error: e });
        throw new ConnectError(`boot failed: ${(e as Error).message}`, Code.Internal);
      }
    },
    async destroySandbox(req) {
      await registry.destroy(req.id);
      return create(DestroySandboxResponseSchema, {});
    },
    async *exec(req, ctx) {
      const sb = registry.running(req.id);
      for await (const ev of runExec(sb.vm, req, sb.record.defaultUser, sb.env, ctx.signal)) yield { event: ev };
    },
    async *readFile(req, ctx) {
      const sb = registry.running(req.id);
      for await (const data of readGuestFile(sb.vm, req.path, req.maxBytes, ctx.signal)) yield { data };
    },
    async writeFile(reqs, ctx) {
      const it = reqs[Symbol.asyncIterator]();
      const first = await it.next();
      if (first.done || first.value.msg.case !== "header") throw new ConnectError("the first message must be the header", Code.InvalidArgument);
      const header = first.value.msg.value;
      const sb = registry.running(header.id);
      async function* data(): AsyncGenerator<Uint8Array> {
        for (let r = await it.next(); !r.done; r = await it.next()) {
          if (r.value.msg.case !== "data") throw new ConnectError("only the first message may be the header", Code.InvalidArgument);
          yield r.value.msg.value;
        }
      }
      const bytesWritten = await writeGuestFile(sb.vm, header, sb.record.defaultUser, data(), ctx.signal);
      return create(WriteFileResponseSchema, { bytesWritten });
    },
    async setPolicy(req) {
      await registry.setPolicy(req.id, { allowedHosts: [...(req.policy?.allowedHosts ?? [])], enabledSecrets: [...(req.policy?.enabledSecrets ?? [])] });
      return create(SetPolicyResponseSchema, {});
    },
    getSandbox(req) {
      const sb = registry.get(req.id);
      if (!sb) throw new ConnectError(`sandbox ${JSON.stringify(req.id)} not found`, Code.NotFound);
      return sb;
    },
  };
}
