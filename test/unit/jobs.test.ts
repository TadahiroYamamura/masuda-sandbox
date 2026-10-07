import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ExecOutput } from "../../src/exec.js";
import type { GuestFileEntry, WriteHeader } from "../../src/files.js";
import { RunJobRequestSchema, type RunJobRequest } from "../../src/gen/masuda/sandbox/v1/sandbox_pb.js";
import { runJob, streamJob, type JobEnv, type JobExec, type JobGuest, type JobVm, type RunJobEventBody } from "../../src/jobs.js";

type ExecBehavior = { chunks?: number; stdout?: string; exitCode?: number; signal?: string; timedOut?: boolean; hang?: boolean; throws?: boolean };

// ゲストのファイルシステムを相対パス→内容の表で持つフェイク。呼ばれた操作をlogに残す。
class FakeGuest implements JobGuest {
  files = new Map<string, { data: Buffer; mode: number }>();
  failRead = new Set<string>();
  failWrite = false;
  behaviors = new Map<string, ExecBehavior>();
  produced = 0;

  constructor(readonly name: string, readonly log: string[]) {}

  async *exec(spec: JobExec, signal: AbortSignal): AsyncIterable<ExecOutput> {
    this.log.push(`${this.name}:exec:${spec.shell}`);
    const b = this.behaviors.get(spec.shell) ?? {};
    if (b.throws) throw new ConnectError("exec failed: boom", Code.Internal);
    yield { case: "started", value: {} };
    if (b.stdout) yield { case: "stdout", value: Buffer.from(b.stdout) };
    for (let i = 0; i < (b.chunks ?? 0); i++) {
      this.produced += 1;
      yield { case: "stdout", value: Buffer.from("y") };
    }
    if (b.hang) {
      await new Promise<void>((_, reject) => {
        const cancel = () => reject(new ConnectError("exec cancelled", Code.Canceled));
        if (signal.aborted) cancel();
        else signal.addEventListener("abort", cancel, { once: true });
      });
    }
    yield { case: "exited", value: { exitCode: b.exitCode ?? 0, signal: b.signal ?? "", timedOut: b.timedOut ?? false } };
  }

  async list(root: string, patterns: readonly string[]): Promise<GuestFileEntry[]> {
    this.log.push(`${this.name}:list:${root}:${patterns.join(",")}`);
    const { match } = await import("../../src/glob.js");
    const prefix = `${root}/`;
    return [...this.files.entries()]
      .filter(([p]) => p.startsWith(prefix))
      .map(([p, f]) => ({ rel: p.slice(prefix.length), mode: f.mode, size: f.data.length }))
      .filter((f) => patterns.some((pat) => match(pat, f.rel)))
      .sort((a, b) => a.rel.localeCompare(b.rel));
  }

  async *read(p: string, maxBytes: bigint): AsyncIterable<Uint8Array> {
    this.log.push(`${this.name}:read:${p}`);
    const f = this.files.get(p);
    if (!f || this.failRead.has(p)) throw new ConnectError(`${p} is not a regular file`, Code.NotFound);
    if (maxBytes > 0n && BigInt(f.data.length) > maxBytes) throw new ConnectError(`${p} over the limit`, Code.ResourceExhausted);
    yield f.data;
  }

  async write(header: WriteHeader, data: AsyncIterable<Uint8Array>): Promise<bigint> {
    this.log.push(`${this.name}:write:${header.path}`);
    if (this.failWrite) throw new ConnectError("write failed", Code.Internal);
    const chunks: Buffer[] = [];
    for await (const c of data) chunks.push(Buffer.from(c));
    this.files.set(header.path, { data: Buffer.concat(chunks), mode: header.mode || 0o644 });
    return BigInt(Buffer.concat(chunks).length);
  }

  async mkdir(dir: string): Promise<void> {
    this.log.push(`${this.name}:mkdir:${dir}`);
  }
}

class FakeEnv implements JobEnv {
  log: string[] = [];
  vm = new FakeGuest("job", this.log);
  sources = new Map<string, FakeGuest>();
  createFails = false;
  createGate?: Promise<void>;
  destroyed: string[] = [];
  private deniedPush?: (d: { host: string; reason: string } | null) => void;
  private pendingDenials: ({ host: string; reason: string } | null)[] = [];

  async create(id: string): Promise<JobVm> {
    this.log.push("create");
    await this.createGate;
    if (this.createFails) throw new ConnectError("boot failed: no kvm", Code.Internal);
    const self = this;
    async function* denied() {
      for (;;) {
        while (self.pendingDenials.length > 0) {
          const d = self.pendingDenials.shift()!;
          if (d === null) return;
          yield d;
        }
        await new Promise<void>((r) => (self.deniedPush = () => r()));
      }
    }
    const vm = this.vm;
    return {
      exec: (s, sig) => vm.exec(s, sig),
      list: (r, p) => vm.list(r, p),
      read: (p, m) => vm.read(p, m),
      write: (h, d) => vm.write(h, d),
      mkdir: (d) => vm.mkdir(d),
      denied: denied(),
    };
  }

  deny(host: string, reason = "host-not-allowed"): void {
    this.pendingDenials.push({ host, reason });
    this.deniedPush?.(null);
  }

  async destroy(id: string): Promise<void> {
    this.log.push("destroy");
    this.destroyed.push(id);
    this.pendingDenials.push(null);
    this.deniedPush?.(null);
  }

  source(id: string): JobGuest {
    const s = this.sources.get(id);
    if (!s) throw new ConnectError(`sandbox ${JSON.stringify(id)} is not running`, Code.FailedPrecondition);
    return s;
  }
}

let tmp: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "masuda-jobs-test-"));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const request = (r: Partial<Parameters<typeof create<typeof RunJobRequestSchema>>[1]>): RunJobRequest => create(RunJobRequestSchema, { buildId: "b1", shell: "make", ...r });

async function run(env: FakeEnv, req: RunJobRequest, signal: AbortSignal = new AbortController().signal) {
  const events: RunJobEventBody[] = [];
  await runJob(env, req, async (ev) => void events.push(ev), signal);
  return events;
}

const phases = (events: RunJobEventBody[]) => events.flatMap((e) => (e.case === "phase" ? [e.value.name] : []));
const finished = (events: RunJobEventBody[]) => {
  const last = events.at(-1);
  if (last?.case !== "finished") throw new Error(`last event is ${last?.case}`);
  return last.value;
};

describe("runJob", () => {
  it("投入→前処理→実行→回収→破棄の順に動き、最後にFinishedを1つ送る", async () => {
    const env = new FakeEnv();
    const hostFile = path.join(tmp, "in.txt");
    await fs.writeFile(hostFile, "input");
    env.vm.behaviors.set("make", { stdout: "built\n" });
    env.vm.files.set("/workspace/out/r.txt", { data: Buffer.from("report"), mode: 0o755 });
    const outDir = path.join(tmp, "out");
    const events = await run(env, request({
      setupShell: "prep",
      inputs: [{ source: { case: "hostFile", value: { hostPath: hostFile, guestPath: "/workspace/in.txt", mode: 0 } } }],
      outputs: ["out/**"],
      outputsHostDir: outDir,
    }));

    expect(env.log).toEqual([
      "create",
      "job:mkdir:/workspace",
      "job:write:/workspace/in.txt",
      "job:exec:prep",
      "job:exec:make",
      "job:list:/workspace:out/**",
      "job:read:/workspace/out/r.txt",
      "destroy",
    ]);
    expect(phases(events)).toEqual(["creating", "inputs", "setup", "running", "outputs", "destroying"]);
    expect(events.filter((e) => e.case === "finished")).toHaveLength(1);
    const f = finished(events);
    expect(f.setup).toEqual({ exitCode: 0, signal: "", timedOut: false });
    expect(f.exited).toEqual({ exitCode: 0, signal: "", timedOut: false });
    expect(f.outputs).toEqual(["out/r.txt"]);
    expect(f.outputsError).toBe("");
    expect(env.vm.files.get("/workspace/in.txt")?.data.toString()).toBe("input");
    expect(await fs.readFile(path.join(outDir, "out", "r.txt"), "utf8")).toBe("report");
    expect((await fs.stat(path.join(outDir, "out", "r.txt"))).mode & 0o777).toBe(0o700);
    expect(events.some((e) => e.case === "stdout" && Buffer.from(e.value as Uint8Array).toString() === "built\n")).toBe(true);
  });

  it("前処理が0以外で終わるとshellを動かさず、Finished.setupに失敗を入れてexitedは空のままにする", async () => {
    const env = new FakeEnv();
    env.vm.behaviors.set("prep", { exitCode: 3 });
    const events = await run(env, request({ setupShell: "prep" }));
    expect(env.log).not.toContain("job:exec:make");
    expect(phases(events)).not.toContain("running");
    const f = finished(events);
    expect(f.setup?.exitCode).toBe(3);
    expect(f.exited).toBeUndefined();
    expect(env.destroyed).toHaveLength(1);
  });

  it("前処理がシグナルで終わったときも失敗として扱いshellを動かさない", async () => {
    const env = new FakeEnv();
    env.vm.behaviors.set("prep", { exitCode: 0, signal: "SIGKILL" });
    await run(env, request({ setupShell: "prep" }));
    expect(env.log).not.toContain("job:exec:make");
  });

  it("shellが0以外で終わってもエラーにせず、Finished.exitedに終了コードと時間切れを入れる", async () => {
    const env = new FakeEnv();
    env.vm.behaviors.set("make", { exitCode: 137, timedOut: true });
    const f = finished(await run(env, request({ timeoutMs: 1000 })));
    expect(f.exited).toEqual({ exitCode: 137, signal: "", timedOut: true });
    expect(f.jobTimedOut).toBe(false);
  });

  describe("どの段で失敗してもVMを壊し、そのエラーで終わる", () => {
    const cases: [string, (env: FakeEnv) => void, RegExp][] = [
      ["起動", (env) => (env.createFails = true), /boot failed/],
      ["投入", (env) => (env.vm.failWrite = true), /write failed/],
      ["前処理", (env) => env.vm.behaviors.set("prep", { throws: true }), /boom/],
      ["実行", (env) => env.vm.behaviors.set("make", { throws: true }), /boom/],
    ];
    it.each(cases)("%sで失敗したとき", async (_name, breakIt, msg) => {
      const env = new FakeEnv();
      breakIt(env);
      const hostFile = path.join(tmp, "in.txt");
      await fs.writeFile(hostFile, "x");
      const events: RunJobEventBody[] = [];
      const req = request({ setupShell: "prep", inputs: [{ source: { case: "hostFile", value: { hostPath: hostFile, guestPath: "/workspace/in.txt", mode: 0 } } }] });
      await expect(runJob(env, req, async (ev) => void events.push(ev), new AbortController().signal)).rejects.toThrow(msg);
      expect(env.log.at(-1)).toBe("destroy");
      expect(env.destroyed).toHaveLength(1);
      expect(events.some((e) => e.case === "finished")).toBe(false);
    });
  });

  it("emitが例外を投げても破棄する", async () => {
    for (const failOn of ["destroying", "running", "creating"]) {
      const env = new FakeEnv();
      const emit = async (ev: RunJobEventBody) => {
        if (ev.case === "phase" && ev.value.name === failOn) throw new Error(`emit failed on ${failOn}`);
      };
      await runJob(env, request({}), emit, new AbortController().signal).catch(() => {});
      expect(env.destroyed, failOn).toHaveLength(1);
    }
  });

  it("実行中にキャンセルされるとVMを壊してCanceledで終わる", async () => {
    const env = new FakeEnv();
    env.vm.behaviors.set("make", { hang: true });
    const ac = new AbortController();
    const p = run(env, request({}), ac.signal);
    await new Promise((r) => setTimeout(r, 20));
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: Code.Canceled });
    expect(env.destroyed).toHaveLength(1);
  });

  it("起動中にキャンセルされても、起動を待ってからVMを壊す", async () => {
    const env = new FakeEnv();
    let boot!: () => void;
    env.createGate = new Promise((r) => (boot = r));
    const ac = new AbortController();
    const p = run(env, request({}), ac.signal);
    while (!env.log.includes("create")) await new Promise((r) => setImmediate(r));
    ac.abort();
    boot();
    await expect(p).rejects.toMatchObject({ code: Code.Canceled });
    expect(env.log).toEqual(["create", "destroy"]);
  });

  it("全体の期限が切れるとVMを壊し、Finished.job_timed_outで知らせる", async () => {
    const env = new FakeEnv();
    env.vm.behaviors.set("make", { hang: true });
    const events = await run(env, request({ jobTimeoutMs: 30 }));
    const f = finished(events);
    expect(f.jobTimedOut).toBe(true);
    expect(f.exited).toBeUndefined();
    expect(env.destroyed).toHaveLength(1);
    expect(phases(events).at(-1)).toBe("destroying");
  });

  it("outputsは当たらないパターン・読めないファイル・上限超えを外して、読めたものだけ回収する", async () => {
    const env = new FakeEnv();
    env.vm.files.set("/workspace/a.txt", { data: Buffer.from("a"), mode: 0o644 });
    env.vm.files.set("/workspace/b.txt", { data: Buffer.from("b"), mode: 0o644 });
    env.vm.files.set("/workspace/big.txt", { data: Buffer.alloc(100), mode: 0o644 });
    env.vm.failRead.add("/workspace/b.txt");
    const outDir = path.join(tmp, "out");
    const f = finished(await run(env, request({ outputs: ["*.txt", "missing/**"], outputsHostDir: outDir, maxOutputFileBytes: 10n })));
    expect(f.outputs).toEqual(["a.txt"]);
    expect(f.outputsError).toContain('no file matched "missing/**"');
    expect(f.outputsError).toContain("b.txt");
    expect(f.outputsError).toContain("big.txt is 100 bytes");
    expect(await fs.readdir(outDir)).toEqual(["a.txt"]);
  });

  it("outputsの合計の上限を超える分は回収しない", async () => {
    const env = new FakeEnv();
    env.vm.files.set("/workspace/a.txt", { data: Buffer.alloc(6), mode: 0o644 });
    env.vm.files.set("/workspace/b.txt", { data: Buffer.alloc(6), mode: 0o644 });
    const f = finished(await run(env, request({ outputs: ["*.txt"], outputsHostDir: path.join(tmp, "out"), maxOutputTotalBytes: 10n })));
    expect(f.outputs).toEqual(["a.txt"]);
    expect(f.outputsError).toContain("b.txt (6 bytes) would exceed the total limit of 10");
  });

  it("前処理が失敗してもoutputsは回収する", async () => {
    const env = new FakeEnv();
    env.vm.behaviors.set("prep", { exitCode: 1 });
    env.vm.files.set("/workspace/log.txt", { data: Buffer.from("why"), mode: 0o644 });
    const f = finished(await run(env, request({ setupShell: "prep", outputs: ["log.txt"], outputsHostDir: path.join(tmp, "out") })));
    expect(f.outputs).toEqual(["log.txt"]);
  });

  it("FromSandboxは写し元のVMから当たるファイルをパーミッションを保ってdest_rootの下へ写す", async () => {
    const env = new FakeEnv();
    const src = new FakeGuest("src", env.log);
    src.files.set("/workspace/.env", { data: Buffer.from("K=V"), mode: 0o600 });
    src.files.set("/workspace/bin/run", { data: Buffer.from("#!"), mode: 0o755 });
    src.files.set("/workspace/other", { data: Buffer.from("no"), mode: 0o644 });
    env.sources.set("main", src);
    await run(env, request({ inputs: [{ source: { case: "fromSandbox", value: { id: "main", root: "/workspace", patterns: [".env", "bin/**"], destRoot: "" } } }] }));
    expect(env.vm.files.get("/workspace/.env")).toEqual({ data: Buffer.from("K=V"), mode: 0o600 });
    expect(env.vm.files.get("/workspace/bin/run")?.mode).toBe(0o755);
    expect(env.vm.files.has("/workspace/other")).toBe(false);
  });

  it("FromSandboxの写し元が動いていなければVMを作らずにFailedPreconditionで終わる", async () => {
    const env = new FakeEnv();
    const p = run(env, request({ inputs: [{ source: { case: "fromSandbox", value: { id: "gone", root: "/workspace", patterns: ["x"], destRoot: "" } } }] }));
    await expect(p).rejects.toMatchObject({ code: Code.FailedPrecondition });
    expect(env.log).toEqual([]);
  });

  it.each([
    ["outputsの不正なglob", { outputs: ["../x"], outputsHostDir: "/tmp/x" }],
    ["FromSandboxの不正なglob", { inputs: [{ source: { case: "fromSandbox" as const, value: { id: "main", root: "/workspace", patterns: ["a//b"], destRoot: "" } } }] }],
    ["outputs_host_dirの無いoutputs", { outputs: ["x"] }],
    ["相対パスのhost_path", { inputs: [{ source: { case: "hostFile" as const, value: { hostPath: "rel.txt", guestPath: "/x", mode: 0 } } }] }],
    ["shellが空", { shell: "" }],
    ["不正なuser", { user: "-x" }],
  ])("%sはVMを作らずにInvalidArgumentで終わる", async (_name, r) => {
    const env = new FakeEnv();
    env.sources.set("main", new FakeGuest("src", env.log));
    await expect(run(env, request(r))).rejects.toMatchObject({ code: Code.InvalidArgument });
    expect(env.log).toEqual([]);
  });

  it("拒否した通信を流し、Finishedでは(host, reason)ごとに数をまとめる", async () => {
    const env = new FakeEnv();
    const orig = env.vm.exec.bind(env.vm);
    env.vm.exec = async function* (spec, signal) {
      env.deny("evil.example");
      env.deny("evil.example");
      env.deny("1.2.3.4:22", "protocol");
      yield* orig(spec, signal);
    };
    const events = await run(env, request({}));
    expect(events.filter((e) => e.case === "denied")).toHaveLength(3);
    expect(finished(events).deniedHosts).toEqual([
      { host: "evil.example", reason: "host-not-allowed", count: 2 },
      { host: "1.2.3.4:22", reason: "protocol", count: 1 },
    ]);
  });
});

describe("streamJob", () => {
  it("受け手がストリームを途中で閉じるとジョブを中断し、VMを壊し終えてから閉じる", async () => {
    const env = new FakeEnv();
    env.vm.behaviors.set("make", { stdout: "x", hang: true });
    const it = streamJob(env, request({}), new AbortController().signal);
    for await (const ev of it) {
      if (ev.case === "stdout") break;
    }
    expect(env.destroyed).toHaveLength(1);
  });

  it("受け手が読まない間はVMの出力を読み進めない", async () => {
    const env = new FakeEnv();
    env.vm.behaviors.set("make", { chunks: 1000 });
    const it = streamJob(env, request({}), new AbortController().signal);
    await it.next();
    await new Promise((r) => setTimeout(r, 50));
    expect(env.vm.produced).toBeLessThan(100);
    await it.return(undefined);
    expect(env.destroyed).toHaveLength(1);
  });

  it("最後まで読むとFinishedで終わる", async () => {
    const env = new FakeEnv();
    const seen: string[] = [];
    for await (const ev of streamJob(env, request({}), new AbortController().signal)) seen.push(ev.case!);
    expect(seen.at(-1)).toBe("finished");
  });
});
