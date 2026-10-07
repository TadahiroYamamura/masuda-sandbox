// Contract tests for the sandbox API: the definition of done for each work
// order in docs/work-orders.md. They talk to a running `masuda-sandbox serve`
// over its Unix socket (MASUDA_SANDBOX_SOCKET) and boot real VMs.
//
// Owned by the supervisor. Implementers do not edit assertions; if a test is
// wrong, say so in HANDOFF.md. The connection helper (./client.ts) is part of
// S1 and is implemented by the sandbox work.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Code, ConnectError } from "@connectrpc/connect";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { connect, type Client } from "./client.js";
import {
  SandboxState,
  SubstituteIn,
  type RunJobEvent_Finished,
} from "../../src/gen/masuda/sandbox/v1/sandbox_pb.js";

const socket = process.env.MASUDA_SANDBOX_SOCKET;
const imageDir = path.resolve(__dirname, "image"); // Dockerfile: ubuntu + curl + git + user `ubuntu`
const freshImageDir = path.resolve(__dirname, "image-fresh"); // Dockerfile: alpine, plus a random line the test appends
let client: Client;
let buildId = "";

async function exec(id: string, shell: string, opts: Partial<{ user: string; cwd: string; env: Record<string, string>; timeoutMs: number }> = {}) {
  let stdout = "";
  let stderr = "";
  let exit = -1;
  let timedOut = false;
  for await (const ev of client.exec({ id, shell, user: opts.user ?? "", cwd: opts.cwd ?? "", env: opts.env ?? {}, timeoutMs: opts.timeoutMs ?? 0 })) {
    if (ev.event.case === "stdout") stdout += Buffer.from(ev.event.value).toString();
    if (ev.event.case === "stderr") stderr += Buffer.from(ev.event.value).toString();
    if (ev.event.case === "exited") { exit = ev.event.value.exitCode; timedOut = ev.event.value.timedOut; }
  }
  return { stdout, stderr, exit, timedOut };
}

async function readAll(id: string, p: string) {
  const chunks: Buffer[] = [];
  for await (const c of client.readFile({ id, path: p, maxBytes: 0n })) chunks.push(Buffer.from(c.data));
  return Buffer.concat(chunks).toString();
}

async function write(id: string, p: string, content: string, mode = 0o644, owner = "") {
  async function* msgs() {
    yield { msg: { case: "header" as const, value: { id, path: p, mode, owner } } };
    yield { msg: { case: "data" as const, value: Buffer.from(content) } };
  }
  return client.writeFile(msgs());
}

const sid = (s: string) => `ct-${s}-${process.pid}`;

type RunJobInit = Parameters<Client["runJob"]>[0];

async function runJob(req: Partial<RunJobInit>, signal?: AbortSignal) {
  const phases: string[] = [];
  const denied: string[] = [];
  let sandboxId = "";
  let stdout = "";
  let stderr = "";
  let finished: RunJobEvent_Finished | undefined;
  for await (const ev of client.runJob({ buildId, memoryMib: 1024, cpus: 1, ...req } as RunJobInit, { signal })) {
    const e = ev.event;
    if (e.case === "phase") { phases.push(e.value.name); sandboxId = e.value.sandboxId; }
    if (e.case === "stdout") stdout += Buffer.from(e.value).toString();
    if (e.case === "stderr") stderr += Buffer.from(e.value).toString();
    if (e.case === "denied") denied.push(e.value.host);
    if (e.case === "finished") finished = e.value;
  }
  return { phases, denied, sandboxId, stdout, stderr, finished: finished! };
}

async function sandboxIds() {
  return (await client.listSandboxes({})).sandboxes.map((s) => s.id);
}

describe.skipIf(!socket)("sandbox contract", () => {
  beforeAll(async () => {
    client = await connect(socket!);
  });
  afterAll(async () => {
    for (const s of (await client.listSandboxes({})).sandboxes) {
      if (s.id.startsWith("ct-")) await client.destroySandbox({ id: s.id });
    }
  });

  // ---- C-S1 ---------------------------------------------------------------
  it("C-S1 serves over the socket and lists nothing", async () => {
    const r = await client.listSandboxes({});
    expect(r.sandboxes.filter((s) => s.id.startsWith("ct-"))).toHaveLength(0);
    await expect(client.getSandbox({ id: "does-not-exist" })).rejects.toMatchObject({ code: Code.NotFound });
  });

  // ---- C-S2 ---------------------------------------------------------------
  // Two steps. The first builds an OCI image no earlier run has seen, so the
  // assets cannot be reused and the build has to go through gondolin build;
  // it is removed again at the end through DeleteImage. The second is
  // the long-lived contract:test image the later tests boot, which is reused
  // across runs to avoid ~400MB of new assets each time.
  it("C-S2 builds a never-seen image through to new assets and lists it", async () => {
    const ctx = fs.mkdtempSync(path.join(os.tmpdir(), "ct-image-fresh-"));
    fs.writeFileSync(path.join(ctx, "Dockerfile"), `${fs.readFileSync(path.join(freshImageDir, "Dockerfile"), "utf8")}RUN echo ${randomUUID()} > /fresh\n`);
    const before = new Set((await client.listImages({})).images.map((i) => i.buildId));
    let built;
    try {
      for await (const ev of client.buildImage({ contextDir: ctx, dockerfile: "Dockerfile", name: "contract:fresh", arch: "" })) {
        if (ev.event.case === "built") built = ev.event.value;
      }
      expect(built?.buildId).toMatch(/^[0-9a-f-]{36}$/);
      expect(before).not.toContain(built!.buildId);
      const list = await client.listImages({});
      expect(list.images.map((i) => i.buildId)).toContain(built!.buildId);
    } finally {
      fs.rmSync(ctx, { recursive: true, force: true });
      if (built?.buildId) await client.deleteImage({ buildId: built.buildId });
    }
    expect((await client.listImages({})).images.map((i) => i.buildId)).not.toContain(built!.buildId);
  }, 600_000);

  it("C-S2 builds an image from a Dockerfile and lists it", async () => {
    let built;
    const lines: string[] = [];
    for await (const ev of client.buildImage({ contextDir: imageDir, dockerfile: "Dockerfile", name: "contract:test", arch: "" })) {
      if (ev.event.case === "logLine") lines.push(ev.event.value);
      if (ev.event.case === "built") built = ev.event.value;
    }
    expect(lines.length).toBeGreaterThan(0);
    expect(built?.buildId).toMatch(/^[0-9a-f-]{36}$/);
    expect(built?.ociDigest).toMatch(/^sha256:/);
    buildId = built!.buildId;
    const list = await client.listImages({});
    expect(list.images.map((i) => i.buildId)).toContain(buildId);
  }, 600_000);

  // ---- C-S3 ---------------------------------------------------------------
  it("C-S3 creates a VM, execs as the default and as root, destroys idempotently", async () => {
    const id = sid("s3");
    const sb = await client.createSandbox({ id, buildId, memoryMib: 1024, cpus: 1, defaultUser: "ubuntu", env: { HELLO: "world" }, secrets: [], tcpMaps: [] });
    expect(sb.state).toBe(SandboxState.RUNNING);
    await expect(client.createSandbox({ id, buildId, defaultUser: "ubuntu" })).rejects.toMatchObject({ code: Code.AlreadyExists });

    const who = await exec(id, "id -un; echo $HELLO; pwd", { cwd: "/tmp" });
    expect(who.exit).toBe(0);
    expect(who.stdout.trim().split("\n")).toEqual(["ubuntu", "world", "/tmp"]);

    const root = await exec(id, "id -u", { user: "root" });
    expect(root.stdout.trim()).toBe("0");

    const fail = await exec(id, "echo err >&2; exit 7");
    expect(fail.exit).toBe(7);
    expect(fail.stderr).toContain("err");

    const slow = await exec(id, "sleep 30", { timeoutMs: 1500 });
    expect(slow.timedOut).toBe(true);

    const argv = await (async () => {
      let out = "";
      for await (const ev of client.exec({ id, argv: ["/bin/echo", "a b"], env: {} })) if (ev.event.case === "stdout") out += Buffer.from(ev.event.value).toString();
      return out;
    })();
    expect(argv.trim()).toBe("a b");

    await client.destroySandbox({ id });
    await client.destroySandbox({ id }); // idempotent
    const after = await client.getSandbox({ id }).catch((e) => e);
    expect(after instanceof ConnectError ? after.code === Code.NotFound : after.state === SandboxState.STOPPED).toBe(true);
  }, 120_000);

  // ---- C-S4 ---------------------------------------------------------------
  it("C-S4 switches egress per policy and substitutes secrets only where enabled", async () => {
    const id = sid("s4");
    const sb = await client.createSandbox({
      id, buildId, defaultUser: "ubuntu",
      secrets: [
        { name: "DEMO_TOKEN", value: "real-secret-value-123", hosts: ["httpbin.org"], substituteIn: [SubstituteIn.HEADER], placeholderPrefix: "tok_", placeholderLength: 32 },
        { name: "BODY_TOKEN", value: "real-body-456", hosts: ["httpbin.org"], substituteIn: [SubstituteIn.HEADER, SubstituteIn.BODY] },
      ],
      policy: { allowedHosts: [], enabledSecrets: [] },
      tcpMaps: [],
    });
    const ph = sb.placeholders["DEMO_TOKEN"];
    expect(ph).toMatch(/^tok_[A-Za-z0-9]{32}$/);
    expect((await client.getSandbox({ id })).placeholders["DEMO_TOKEN"]).toBe(ph); // stable

    const curl = (u: string, extra = "") => exec(id, `curl -sS -m 15 -o /dev/null -w '%{http_code}' ${extra} ${u} 2>&1 || echo FAIL`);

    // Nothing allowed yet.
    expect((await curl("https://example.com")).stdout).not.toBe("200");

    await client.setPolicy({ id, policy: { allowedHosts: ["example.com"], enabledSecrets: [] } });
    expect((await curl("https://example.com")).stdout).toBe("200");
    expect((await curl("https://httpbin.org/get")).stdout).not.toBe("200");

    // Secret not enabled: a request carrying its placeholder is denied even to an allowed host.
    await client.setPolicy({ id, policy: { allowedHosts: ["httpbin.org"], enabledSecrets: [] } });
    expect((await curl("https://httpbin.org/get", `-H "Authorization: Bearer $DEMO_TOKEN"`)).stdout).not.toBe("200");

    // Enabled: the host sees the real value, the guest never does.
    await client.setPolicy({ id, policy: { allowedHosts: ["httpbin.org"], enabledSecrets: ["DEMO_TOKEN", "BODY_TOKEN"] } });
    const hdr = await exec(id, `curl -sS -m 15 https://httpbin.org/headers -H "Authorization: Bearer $DEMO_TOKEN"`);
    expect(hdr.stdout).toContain("real-secret-value-123");
    const envDump = await exec(id, "echo $DEMO_TOKEN");
    expect(envDump.stdout).not.toContain("real-secret-value-123");

    const body = await exec(id, `curl -sS -m 15 https://httpbin.org/post -H 'content-type: application/json' -d "{\\"k\\":\\"$BODY_TOKEN\\"}"`);
    expect(body.stdout).toContain("real-body-456");
    const bodyNo = await exec(id, `curl -sS -m 15 https://httpbin.org/post -d "k=$DEMO_TOKEN"`);
    expect(bodyNo.stdout).not.toContain("real-secret-value-123"); // HEADER-only secret stays a placeholder in bodies

    await client.destroySandbox({ id });
  }, 180_000);

  // ---- C-S5 ---------------------------------------------------------------
  it("C-S5 reads and writes files, never follows symlinks", async () => {
    const id = sid("s5");
    await client.createSandbox({ id, buildId, defaultUser: "ubuntu", secrets: [], tcpMaps: [] });
    await write(id, "/masuda/in/0001/task.md", "# task\n", 0o644, "ubuntu");
    const st = await exec(id, "stat -c '%U %a' /masuda/in/0001/task.md; cat /masuda/in/0001/task.md");
    expect(st.stdout).toBe("ubuntu 644\n# task\n");

    await exec(id, "ln -s /etc/hostname /masuda/in/0001/link; mkdir -p /masuda/in/0001/dir");
    await expect(readAll(id, "/masuda/in/0001/link")).rejects.toMatchObject({ code: Code.NotFound });
    await expect(readAll(id, "/masuda/in/0001/dir")).rejects.toMatchObject({ code: Code.NotFound });
    await expect(readAll(id, "/masuda/in/0001/missing")).rejects.toMatchObject({ code: Code.NotFound });

    // Writing over a symlink replaces the link; the target is untouched.
    await exec(id, "ln -sf /tmp/victim /masuda/in/0001/trap; echo original > /tmp/victim");
    await write(id, "/masuda/in/0001/trap", "payload\n");
    const chk = await exec(id, "cat /tmp/victim; test -L /masuda/in/0001/trap && echo still-link || echo regular; cat /masuda/in/0001/trap");
    expect(chk.stdout).toBe("original\nregular\npayload\n");

    await exec(id, "head -c 3000000 /dev/zero > /tmp/big");
    await expect(readAll_limited(id, "/tmp/big", 1_000_000n)).rejects.toMatchObject({ code: Code.ResourceExhausted });
    await client.destroySandbox({ id });
  }, 120_000);

  // ---- C-S6 ---------------------------------------------------------------
  it("C-S6 reaches a host-local listener through tcp_maps and attaches over SSH", async () => {
    const server = http.createServer((_req, res) => res.end("hello from host"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as any).port as number;
    const id = sid("s6");
    try {
      await client.createSandbox({ id, buildId, defaultUser: "ubuntu", secrets: [], tcpMaps: [{ host: "masuda.internal", port: 0, upstream: `127.0.0.1:${port}` }] });
      const r = await exec(id, `curl -sS -m 10 http://masuda.internal:${port}/x`);
      expect(r.stdout).toBe("hello from host");
      const direct = await exec(id, `curl -sS -m 5 -o /dev/null -w '%{http_code}' http://192.168.127.1:${port}/ || echo BLOCKED`);
      expect(direct.stdout).not.toBe("200");

      await exec(id, "tmux new-session -d -s claude-work 'sleep 600'");
      const access = await client.enableSsh({ id, user: "ubuntu" });
      expect(access.user).toBe("ubuntu");
      expect(Buffer.from(access.privateKeyPem).toString()).toContain("PRIVATE KEY");
      const keyFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ct-ssh-")), "id");
      fs.writeFileSync(keyFile, Buffer.from(access.privateKeyPem), { mode: 0o600 });
      const { execFile } = await import("node:child_process");
      const out = await new Promise<string>((resolve, reject) =>
        execFile("ssh", ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "LogLevel=ERROR", "-i", keyFile, "-p", String(access.port), `${access.user}@${access.host}`, "tmux ls"], { timeout: 20_000 }, (e, so) => (e ? reject(e) : resolve(so))),
      );
      expect(out).toContain("claude-work");
      await client.disableSsh({ id, user: "ubuntu" });
    } finally {
      await client.destroySandbox({ id }).catch(() => {});
      server.close();
    }
  }, 120_000);

  // ---- C-S7 ---------------------------------------------------------------
  it("C-S7 streams host-observed HTTP activity with replay", async () => {
    const id = sid("s7");
    await client.createSandbox({ id, buildId, defaultUser: "ubuntu", secrets: [], policy: { allowedHosts: ["example.com"], enabledSecrets: [] }, tcpMaps: [] });
    await exec(id, "curl -sS -m 15 -o /dev/null https://example.com; curl -sS -m 5 -o /dev/null https://httpbin.org/get || true");
    const seen: string[] = [];
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 5000);
    try {
      for await (const ev of client.watchEvents({ id, afterSeq: 0n }, { signal: ac.signal })) {
        seen.push(ev.event.case ?? "");
        if (seen.filter((s) => s === "httpFinished").length >= 1 && seen.includes("httpDenied")) break;
      }
    } catch (e) { /* aborted */ } finally { clearTimeout(t); }
    expect(seen).toContain("httpStarted");
    expect(seen).toContain("httpFinished");
    expect(seen).toContain("httpDenied");
    const sb = await client.getSandbox({ id });
    expect(sb.lastHttpActivity).toBeDefined();
    await client.destroySandbox({ id });
  }, 120_000);

  // ---- C-S16 --------------------------------------------------------------
  it("C-S16 RunJob puts a host file in, transforms it, collects outputs and leaves no VM", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-job-"));
    try {
      fs.writeFileSync(path.join(dir, "in.txt"), "hello");
      const out = path.join(dir, "out");
      const r = await runJob({
        inputs: [{ source: { case: "hostFile", value: { hostPath: path.join(dir, "in.txt"), guestPath: "/workspace/in.txt", mode: 0 } } }],
        shell: "pwd; id -un; mkdir -p result && tr a-z A-Z < in.txt > result/up.txt",
        outputs: ["result/**"],
        outputsHostDir: out,
      });
      expect(r.phases).toEqual(["creating", "inputs", "running", "outputs", "destroying"]);
      expect(r.sandboxId).toMatch(/^job-/);
      expect(r.stdout).toBe("/workspace\nroot\n");
      expect(r.finished.exited?.exitCode).toBe(0);
      expect(r.finished.setup).toBeUndefined();
      expect(r.finished.jobTimedOut).toBe(false);
      expect(r.finished.outputs).toEqual(["result/up.txt"]);
      expect(r.finished.outputsError).toBe("");
      expect(fs.readFileSync(path.join(out, "result", "up.txt"), "utf8")).toBe("HELLO");
      expect(await sandboxIds()).not.toContain(r.sandboxId);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);

  it("C-S16 RunJob reports a non-zero exit and a command timeout without failing the RPC", async () => {
    const fail = await runJob({ shell: "echo err >&2; exit 7" });
    expect(fail.finished.exited?.exitCode).toBe(7);
    expect(fail.stderr).toContain("err");

    const slow = await runJob({ shell: "sleep 30", timeoutMs: 1500 });
    expect(slow.finished.exited?.timedOut).toBe(true);
    expect(slow.finished.jobTimedOut).toBe(false);
    expect(await sandboxIds()).not.toContain(slow.sandboxId);
  }, 180_000);

  it("C-S16 RunJob denies hosts that are not allowed and lists them", async () => {
    const r = await runJob({
      allowedHosts: ["example.com"],
      shell: "curl -sS -m 15 -o /dev/null -w '%{http_code}\\n' https://example.com; curl -sS -m 5 -o /dev/null https://httpbin.org/get || true",
    });
    expect(r.stdout.split("\n")[0]).toBe("200");
    expect(r.denied).toContain("httpbin.org");
    expect(r.finished.deniedHosts).toContainEqual(expect.objectContaining({ host: "httpbin.org", reason: "host-not-allowed" }));
    expect(r.finished.deniedHosts.map((d) => d.host)).not.toContain("example.com");
  }, 180_000);

  it("C-S16 RunJob does not run the command when setup fails", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-job-"));
    try {
      const r = await runJob({ setupShell: "echo preparing; exit 4", shell: "touch ran", outputs: ["ran"], outputsHostDir: dir });
      expect(r.phases).toContain("setup");
      expect(r.phases).not.toContain("running");
      expect(r.stdout).toContain("preparing");
      expect(r.finished.setup?.exitCode).toBe(4);
      expect(r.finished.exited).toBeUndefined();
      expect(r.finished.outputs).toEqual([]);
      expect(r.finished.outputsError).toContain("ran");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);

  it("C-S16 RunJob copies files from another sandbox, keeping modes and skipping .git and symlinks", async () => {
    const src = sid("s16-src");
    try {
      await client.createSandbox({ id: src, buildId, memoryMib: 1024, cpus: 1, defaultUser: "ubuntu", secrets: [], tcpMaps: [] });
      await write(src, "/workspace/.env", "K=V\n", 0o600);
      await write(src, "/workspace/bin/run.sh", "#!/bin/sh\n", 0o755);
      await write(src, "/workspace/.git/config", "[core]\n");
      await exec(src, "ln -s /etc/hostname /workspace/link");
      const r = await runJob({
        inputs: [{ source: { case: "fromSandbox", value: { id: src, root: "/workspace", patterns: [".env", "bin/**", "link", ".git/**"], destRoot: "" } } }],
        shell: "stat -c '%a %n' .env bin/run.sh; cat .env; test -e link && echo has-link || echo no-link; test -e .git/config && echo has-git || echo no-git",
      });
      expect(r.stdout).toBe("600 .env\n755 bin/run.sh\nK=V\nno-link\nno-git\n");
    } finally {
      await client.destroySandbox({ id: src }).catch(() => {});
    }
  }, 180_000);

  it("C-S16 RunJob destroys the VM when the client cancels the stream", async () => {
    const ac = new AbortController();
    let jobId = "";
    try {
      for await (const ev of client.runJob({ buildId, memoryMib: 1024, cpus: 1, shell: "sleep 600" }, { signal: ac.signal })) {
        if (ev.event.case === "phase") {
          jobId = ev.event.value.sandboxId;
          if (ev.event.value.name === "running") ac.abort();
        }
      }
    } catch (e) {
      expect(e).toMatchObject({ code: Code.Canceled });
    }
    expect(jobId).toMatch(/^job-/);
    const deadline = Date.now() + 30_000;
    while ((await sandboxIds()).includes(jobId) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));
    expect(await sandboxIds()).not.toContain(jobId);
  }, 180_000);

  it("C-S16 DeleteImage refuses an image in use, then removes it, idempotently", async () => {
    const ctx = fs.mkdtempSync(path.join(os.tmpdir(), "ct-image-delete-"));
    fs.writeFileSync(path.join(ctx, "Dockerfile"), `${fs.readFileSync(path.join(imageDir, "Dockerfile"), "utf8")}RUN echo ${randomUUID()} > /fresh\n`);
    const id = sid("s16-del");
    let doomed = "";
    try {
      for await (const ev of client.buildImage({ contextDir: ctx, dockerfile: "Dockerfile", name: "contract:delete", arch: "" })) {
        if (ev.event.case === "built") doomed = ev.event.value.buildId;
      }
      expect(doomed).toMatch(/^[0-9a-f-]{36}$/);
      await client.createSandbox({ id, buildId: doomed, memoryMib: 1024, cpus: 1, defaultUser: "ubuntu", secrets: [], tcpMaps: [] });
      await expect(client.deleteImage({ buildId: doomed })).rejects.toMatchObject({ code: Code.FailedPrecondition });
      expect((await client.listImages({})).images.map((i) => i.buildId)).toContain(doomed);

      await client.destroySandbox({ id });
      await client.deleteImage({ buildId: doomed });
      expect((await client.listImages({})).images.map((i) => i.buildId)).not.toContain(doomed);
      await client.deleteImage({ buildId: doomed }); // idempotent
      await expect(client.createSandbox({ id, buildId: doomed, defaultUser: "ubuntu" })).rejects.toMatchObject({ code: Code.NotFound });
    } finally {
      fs.rmSync(ctx, { recursive: true, force: true });
      await client.destroySandbox({ id }).catch(() => {});
      if (doomed) await client.deleteImage({ buildId: doomed }).catch(() => {});
    }
  }, 600_000);
});

async function readAll_limited(id: string, p: string, max: bigint) {
  const chunks: Buffer[] = [];
  for await (const c of client.readFile({ id, path: p, maxBytes: max })) chunks.push(Buffer.from(c.data));
  return Buffer.concat(chunks);
}
