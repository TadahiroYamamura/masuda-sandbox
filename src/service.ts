import { Code, ConnectError, type ServiceImpl } from "@connectrpc/connect";
import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import fs from "node:fs/promises";
import path from "node:path";

import { buildImage, parseArch } from "./build.js";
import { execBaseEnv, parseImageEnv, runExec } from "./exec.js";
import { readGuestFile, writeGuestFile } from "./files.js";
import { DeleteImageResponseSchema, DestroySandboxResponseSchema, DisableSshResponseSchema, ImageSchema, ListImagesResponseSchema, ListSandboxesResponseSchema, SandboxService, SetPolicyResponseSchema, SshAccessSchema, WriteFileResponseSchema, type CreateSandboxRequest, type Image } from "./gen/masuda/sandbox/v1/sandbox_pb.js";
import { bootableImage, deleteImage, type ImageRecord, type ImageStore } from "./images.js";
import { sandboxJobEnv, streamJob } from "./jobs.js";
import { log } from "./log.js";
import { ProcessError } from "./proc.js";
import { DEFAULT_CPUS, DEFAULT_MEMORY_MIB, type SandboxRecord, type SandboxRegistry } from "./sandboxes.js";
import { serverInfo } from "./serverinfo.js";
import { validateTcpMaps } from "./tcpmaps.js";

function toImage(r: ImageRecord): Image {
  return create(ImageSchema, { buildId: r.buildId, name: r.name, arch: r.arch, createdAt: timestampFromDate(new Date(r.createdAt)), ociDigest: r.ociDigest });
}

function validateCreate(req: CreateSandboxRequest): void {
  if (!req.id) throw new ConnectError("id is required", Code.InvalidArgument);
  if (!req.buildId) throw new ConnectError("build_id is required", Code.InvalidArgument);
  if (!req.defaultUser) throw new ConnectError("default_user is required", Code.InvalidArgument);
}

function toRecord(req: CreateSandboxRequest, image: ImageRecord): SandboxRecord {
  const e = req.sshEgress;
  return {
    id: req.id,
    buildId: req.buildId,
    createdAt: new Date().toISOString(),
    defaultUser: req.defaultUser,
    memoryMib: req.memoryMib || DEFAULT_MEMORY_MIB,
    cpus: req.cpus || DEFAULT_CPUS,
    diskMib: req.diskMib,
    imageEnv: parseImageEnv(image.env ?? []),
    env: { ...req.env },
    policy: { allowedHosts: [...(req.policy?.allowedHosts ?? [])], enabledSecrets: [...(req.policy?.enabledSecrets ?? [])] },
    secretNames: req.secrets.map((s) => s.name),
    tcpMaps: validateTcpMaps(req.tcpMaps.map((m) => ({ host: m.host, port: m.port, upstream: m.upstream }))),
    sshEgress: e && { allowedHosts: [...e.allowedHosts], agentSocket: e.agentSocket, knownHostsFile: e.knownHostsFile, pushAllowedRefs: [...e.pushAllowedRefs] },
  };
}

// Methods left out of the returned object are answered with Unimplemented by
// the Connect router.
export function sandboxServiceImpl(registry: SandboxRegistry, images: ImageStore): Partial<ServiceImpl<typeof SandboxService>> {
  const jobs = sandboxJobEnv(registry, images);
  return {
    getServerInfo() {
      return serverInfo();
    },

    async *buildImage(req, ctx) {
      const arch = parseArch(req.arch);
      if (!arch) throw new ConnectError(`unsupported arch ${JSON.stringify(req.arch)}`, Code.InvalidArgument);
      if (!req.contextDir) throw new ConnectError("context_dir is required", Code.InvalidArgument);
      const contextDir = path.resolve(req.contextDir);
      const st = await fs.stat(contextDir).catch(() => undefined);
      if (!st?.isDirectory()) throw new ConnectError(`context_dir ${contextDir} is not a directory`, Code.InvalidArgument);

      log.info("image build started", { contextDir, name: req.name, arch });
      try {
        const reusable = async (ociDigest: string) => (await images.findReusable(ociDigest, arch))?.buildId;
        for await (const ev of buildImage({ contextDir, dockerfile: req.dockerfile || "Dockerfile", name: req.name, arch, signal: ctx.signal, reusable })) {
          if ("log" in ev) {
            yield { event: { case: "logLine", value: ev.log } };
            continue;
          }
          if ("reused" in ev) {
            let rec = await images.get(ev.reused.buildId);
            if (!rec) throw new ConnectError(`image ${ev.reused.buildId} vanished from images.json during the build`, Code.Internal);
            if (!rec.env) {
              rec = { ...rec, env: ev.reused.env };
              await images.record(rec);
            }
            log.info("image reused", { ...rec });
            yield { event: { case: "built", value: toImage(rec) } };
            continue;
          }
          const rec: ImageRecord = { buildId: ev.built.buildId, name: req.name, arch, createdAt: new Date().toISOString(), ociDigest: ev.built.ociDigest, env: ev.built.env };
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
    async deleteImage(req) {
      if (!req.buildId) throw new ConnectError("build_id is required", Code.InvalidArgument);
      const users = registry.usingImage(req.buildId);
      if (users.length > 0) throw new ConnectError(`image ${req.buildId} is used by running sandboxes: ${users.join(", ")}`, Code.FailedPrecondition);
      await deleteImage(images, req.buildId);
      return create(DeleteImageResponseSchema, {});
    },
    async listImages() {
      return create(ListImagesResponseSchema, { images: (await images.list()).map(toImage) });
    },
    listSandboxes() {
      return create(ListSandboxesResponseSchema, { sandboxes: registry.list() });
    },
    async createSandbox(req) {
      validateCreate(req);
      const { image, imageDir } = await bootableImage(images, req.buildId);
      const record = toRecord(req, image);
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
    async enableSsh(req) {
      return create(SshAccessSchema, await registry.enableSsh(req.id, req.user));
    },
    async disableSsh(req) {
      await registry.disableSsh(req.id, req.user);
      return create(DisableSshResponseSchema, {});
    },
    async *exec(req, ctx) {
      const sb = registry.running(req.id);
      const release = sb.execSlots.acquire();
      try {
        const user = req.user || sb.record.defaultUser;
        const baseEnv = execBaseEnv(await sb.home(user, ctx.signal), sb.record.imageEnv, sb.env);
        for await (const ev of runExec(sb.vm, req, sb.record.defaultUser, baseEnv, ctx.signal)) yield { event: ev };
      } finally {
        release();
      }
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
    async *watchEvents(req, ctx) {
      yield* registry.watchEvents(req.id, req.afterSeq, ctx.signal);
    },
    async *runJob(req, ctx) {
      for await (const event of streamJob(jobs, req, ctx.signal)) yield { event };
    },
    getSandbox(req) {
      const sb = registry.get(req.id);
      if (!sb) throw new ConnectError(`sandbox ${JSON.stringify(req.id)} not found`, Code.NotFound);
      return sb;
    },
  };
}
