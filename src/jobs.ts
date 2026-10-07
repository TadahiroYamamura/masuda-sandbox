import { Code, ConnectError } from "@connectrpc/connect";
import type { MessageInitShape } from "@bufbuild/protobuf";
import { randomUUID } from "node:crypto";
import { constants as fsc, createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { execBaseEnv, guestArgv, parseImageEnv, runExec, type ExecOutput } from "./exec.js";
import { ensureGuestDir, guestDir, listGuestFiles, readGuestFile, writeGuestFile, type GuestFileEntry, type WriteHeader } from "./files.js";
import type { RunJobEventSchema, RunJobRequest } from "./gen/masuda/sandbox/v1/sandbox_pb.js";
import { match, patternError } from "./glob.js";
import { bootableImage, type ImageStore } from "./images.js";
import { log } from "./log.js";
import { DEFAULT_CPUS, DEFAULT_MEMORY_MIB, type RunningSandbox, type SandboxRecord, type SandboxRegistry } from "./sandboxes.js";

export type RunJobEventBody = NonNullable<MessageInitShape<typeof RunJobEventSchema>["event"]>;
type Exited = Extract<ExecOutput, { case: "exited" }>["value"];
type Denial = { host: string; reason: string };

export interface JobExec {
  shell: string;
  user: string;
  cwd: string;
  timeoutMs: number;
}

// RunJobの段取りから見たVM1つ。サービスではsandboxのレジストリとGondolinのVMの上に、
// 単体テストではフェイクで作る。
export interface JobGuest {
  exec(spec: JobExec, signal: AbortSignal): AsyncIterable<ExecOutput>;
  list(root: string, patterns: readonly string[], signal: AbortSignal): Promise<GuestFileEntry[]>;
  read(path: string, maxBytes: bigint, signal: AbortSignal): AsyncIterable<Uint8Array>;
  write(header: WriteHeader, data: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<bigint>;
  mkdir(dir: string, owner: string, signal: AbortSignal): Promise<void>;
}

export interface JobVm extends JobGuest {
  // VMのイベントのうち拒否した通信。VMを壊すか、createに渡したsignalが中断すると終わる。
  denied: AsyncIterable<Denial>;
}

export interface JobEnv {
  // VMを起動して返す。中断できない（起動を待ってから壊す）。
  create(id: string, req: RunJobRequest, user: string, watchSignal: AbortSignal): Promise<JobVm>;
  // 冪等。起動中のVMも壊す。
  destroy(id: string): Promise<void>;
  // FromSandboxの写し元。RUNNINGでなければConnectErrorを投げる。
  source(id: string): JobGuest;
}

const DEFAULT_CWD = "/workspace";
const DEFAULT_USER = "root";
const DEFAULT_MAX_OUTPUT_FILE_BYTES = 64n * 1024n * 1024n;
// 0を上限なしにしないのは、`**`のような広いglobでホストのディスクを埋めないため。
const DEFAULT_MAX_OUTPUT_TOTAL_BYTES = 1024n * 1024n * 1024n;
// 全体の期限の既定は、shellの期限より短くならないようにする（起動・投入・回収の分を足す）。
// 0を無期限にしないのは、止まったジョブがVMを持ち続けないため。
const DEFAULT_JOB_TIMEOUT_MS = 2 * 60 * 60_000;
const JOB_TIMEOUT_MARGIN_MS = 30 * 60_000;
// setTimeoutはこれを超える遅延をすぐに発火させる。
const MAX_TIMER_MS = 2 ** 31 - 1;

function invalid(msg: string): ConnectError {
  return new ConnectError(msg, Code.InvalidArgument);
}

function jobTimeoutMs(req: RunJobRequest): number {
  const ms = req.jobTimeoutMs || Math.max(DEFAULT_JOB_TIMEOUT_MS, req.timeoutMs + JOB_TIMEOUT_MARGIN_MS);
  return Math.min(ms, MAX_TIMER_MS);
}

function checkPatterns(field: string, patterns: readonly string[]): void {
  for (const p of patterns) {
    const err = patternError(p);
    if (err) throw invalid(`${field}: ${err}`);
  }
}

function absoluteGuest(field: string, p: string): string {
  if (!p.startsWith("/")) throw invalid(`${field} must be an absolute guest path: ${JSON.stringify(p)}`);
  return guestDir(p);
}

interface Plan {
  user: string;
  cwd: string;
  outputsDir: string;
}

// VMを作る前に分かる誤りは、VMを作る前に返す。
async function plan(env: JobEnv, req: RunJobRequest): Promise<Plan> {
  if (!req.buildId) throw invalid("build_id is required");
  if (!req.shell) throw invalid("shell is required");
  const user = req.user || DEFAULT_USER;
  const cwd = absoluteGuest("cwd", req.cwd || DEFAULT_CWD);
  // user・envの検査はExecと同じものを使う。
  for (const shell of [req.shell, req.setupShell].filter(Boolean)) {
    guestArgv({ argv: [], shell, user, cwd, env: req.env, stdin: new Uint8Array(), pty: false, timeoutMs: 0 }, user, {});
  }
  for (const [i, input] of req.inputs.entries()) {
    const src = input.source;
    if (src.case === "hostFile") {
      const f = src.value;
      if (!path.isAbsolute(f.hostPath)) throw invalid(`inputs[${i}].host_path must be absolute`);
      absoluteGuest(`inputs[${i}].guest_path`, f.guestPath);
      if (f.mode > 0o7777) throw invalid(`inputs[${i}].mode ${f.mode.toString(8)} is invalid`);
      const st = await fs.stat(f.hostPath).catch(() => undefined);
      if (!st?.isFile()) throw invalid(`inputs[${i}].host_path ${f.hostPath} is not a regular file`);
    } else if (src.case === "fromSandbox") {
      const f = src.value;
      if (!f.id) throw invalid(`inputs[${i}].id is required`);
      absoluteGuest(`inputs[${i}].root`, f.root);
      if (f.destRoot) absoluteGuest(`inputs[${i}].dest_root`, f.destRoot);
      if (f.patterns.length === 0) throw invalid(`inputs[${i}].patterns is empty`);
      checkPatterns(`inputs[${i}].patterns`, f.patterns);
      env.source(f.id);
    } else {
      throw invalid(`inputs[${i}] has no source`);
    }
  }
  checkPatterns("outputs", req.outputs);
  let outputsDir = "";
  if (req.outputs.length > 0) {
    if (!req.outputsHostDir || !path.isAbsolute(req.outputsHostDir)) throw invalid("outputs_host_dir must be an absolute path when outputs are given");
    outputsDir = path.resolve(req.outputsHostDir);
    await fs.mkdir(outputsDir, { recursive: true }).catch((e: Error) => {
      throw new ConnectError(`creating outputs_host_dir: ${e.message}`, Code.FailedPrecondition);
    });
  }
  return { user, cwd, outputsDir };
}

function errorMessage(e: unknown): string {
  return e instanceof ConnectError ? e.rawMessage : e instanceof Error ? e.message : String(e);
}

// 1つのジョブを動かし、イベントをemitへ渡す。最後のemitはFinished。
//
// VMは成否・キャンセル（signal）・全体の期限切れのどれでも壊す。壊すのはsignalと切り離して
// 呼び、壊し終えてからFinishedを送る（拒否した通信の購読がVMの破棄で終わり、集計が揃うため）。
// 全体の期限切れは、その時点までに分かったこと（setup・exited・回収できたoutputs）を
// Finishedで返す。キャンセルはCanceledで終わる。それ以外の失敗（起動・投入・前処理や
// 実行のExec自体の失敗）は、VMを壊してからそのエラーで終わる。
export async function runJob(env: JobEnv, req: RunJobRequest, emit: (ev: RunJobEventBody) => Promise<void>, signal: AbortSignal): Promise<void> {
  const { user, cwd, outputsDir } = await plan(env, req);
  const id = `job-${randomUUID()}`;
  const phase = (name: string) => emit({ case: "phase", value: { name, sandboxId: id } });

  const jobAc = new AbortController();
  let jobTimedOut = false;
  const timer = setTimeout(() => {
    jobTimedOut = true;
    jobAc.abort();
  }, jobTimeoutMs(req));
  const onCancel = () => jobAc.abort();
  signal.addEventListener("abort", onCancel, { once: true });
  if (signal.aborted) jobAc.abort();
  const js = jobAc.signal;

  const watchAc = new AbortController();
  let watching: Promise<void> | undefined;
  const denials = new Map<string, Denial & { count: number }>();
  let setup: Exited | undefined;
  let exited: Exited | undefined;
  const outputs: string[] = [];
  let outputsError = "";
  let failure: unknown;

  try {
    await phase("creating");
    const vm = await env.create(id, req, user, watchAc.signal);
    watching = (async () => {
      for await (const d of vm.denied) {
        const key = `${d.reason}\0${d.host}`;
        const cur = denials.get(key);
        if (cur) cur.count += 1;
        else denials.set(key, { ...d, count: 1 });
        await emit({ case: "denied", value: d });
      }
    })();
    js.throwIfAborted();

    await phase("inputs");
    await vm.mkdir(cwd, user, js);
    await putInputs(env, vm, req, user, cwd, js);

    let setupOk = true;
    if (req.setupShell) {
      await phase("setup");
      setup = await runShell(vm, { shell: req.setupShell, user, cwd, timeoutMs: 0 }, emit, js);
      setupOk = setup.exitCode === 0 && setup.signal === "";
    }
    if (setupOk) {
      await phase("running");
      exited = await runShell(vm, { shell: req.shell, user, cwd, timeoutMs: req.timeoutMs }, emit, js);
    }

    if (req.outputs.length > 0) {
      await phase("outputs");
      outputsError = await collectOutputs(vm, req, cwd, outputsDir, outputs, js);
    }
  } catch (e) {
    if (!jobTimedOut || signal.aborted) failure = e;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onCancel);
  }

  // Phaseを送れなくても破棄は飛ばさない。
  await phase("destroying").catch((e) => log.error("emitting the destroying phase failed", { id, error: e }));
  try {
    await env.destroy(id);
  } catch (e) {
    log.error("destroying a job sandbox failed", { id, error: e });
    watchAc.abort();
    failure ??= new ConnectError(`destroying the job sandbox ${id}: ${errorMessage(e)}`, Code.Internal);
  }
  await watching?.catch((e) => log.error("watching a job sandbox's events failed", { id, error: e }));

  if (signal.aborted) throw new ConnectError("job cancelled", Code.Canceled);
  if (failure !== undefined) throw failure;
  await emit({
    case: "finished",
    value: {
      setup,
      exited,
      jobTimedOut,
      outputs,
      outputsError,
      deniedHosts: [...denials.values()],
    },
  });
}

async function putInputs(env: JobEnv, vm: JobGuest, req: RunJobRequest, user: string, cwd: string, signal: AbortSignal): Promise<void> {
  for (const input of req.inputs) {
    const src = input.source;
    if (src.case === "hostFile") {
      const f = src.value;
      const stream = createReadStream(f.hostPath, { signal });
      try {
        await vm.write({ path: f.guestPath, mode: f.mode, owner: user }, stream, signal);
      } finally {
        stream.destroy();
      }
    } else if (src.case === "fromSandbox") {
      const f = src.value;
      const from = env.source(f.id);
      const root = guestDir(f.root);
      const dest = f.destRoot ? guestDir(f.destRoot) : cwd;
      for (const file of await from.list(root, f.patterns, signal)) {
        // writeGuestFileはmode 0を0644と読むので、許可ビットが全部無いファイルだけは保てない。
        await vm.write({ path: path.posix.join(dest, file.rel), mode: file.mode, owner: user }, from.read(path.posix.join(root, file.rel), 0n, signal), signal);
      }
    }
  }
}

async function runShell(vm: JobGuest, spec: JobExec, emit: (ev: RunJobEventBody) => Promise<void>, signal: AbortSignal): Promise<Exited> {
  let exited: Exited | undefined;
  for await (const ev of vm.exec(spec, signal)) {
    if (ev.case === "stdout" || ev.case === "stderr") await emit({ case: ev.case, value: ev.value });
    else if (ev.case === "exited") exited = ev.value;
  }
  if (!exited) throw new ConnectError("the exec ended without an exit status", Code.Internal);
  return exited;
}

// 当たらなかったパターンや読めなかったファイルは返り値（outputs_error）にまとめ、読めたものは
// 回収する。コマンドが失敗しても途中までの出力（テストのレポート等）は役に立つため。
// collectedは途中で全体の期限が切れても、それまでに書いたものが分かるよう呼び出し側と共有する。
async function collectOutputs(vm: JobGuest, req: RunJobRequest, cwd: string, outputsDir: string, collected: string[], signal: AbortSignal): Promise<string> {
  const perFile = req.maxOutputFileBytes || DEFAULT_MAX_OUTPUT_FILE_BYTES;
  const totalLimit = req.maxOutputTotalBytes || DEFAULT_MAX_OUTPUT_TOTAL_BYTES;
  const problems: string[] = [];
  let files: GuestFileEntry[];
  try {
    files = await vm.list(cwd, req.outputs, signal);
  } catch (e) {
    if (signal.aborted) throw e;
    return `listing outputs: ${errorMessage(e)}`;
  }
  for (const p of req.outputs) {
    if (!files.some((f) => match(p, f.rel))) problems.push(`no file matched ${JSON.stringify(p)}`);
  }
  let total = 0n;
  for (const f of files) {
    const size = BigInt(f.size);
    if (size > perFile) {
      problems.push(`${f.rel} is ${size} bytes, over the per-file limit of ${perFile}`);
      continue;
    }
    if (total + size > totalLimit) {
      problems.push(`${f.rel} (${size} bytes) would exceed the total limit of ${totalLimit}`);
      continue;
    }
    const dst = path.join(outputsDir, ...f.rel.split("/"));
    const rel = path.relative(outputsDir, dst);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
      problems.push(`${f.rel} is outside outputs_host_dir`);
      continue;
    }
    try {
      const max = totalLimit - total < perFile ? totalLimit - total : perFile;
      total += await writeHostFile(dst, vm.read(path.posix.join(cwd, f.rel), max, signal), f.mode);
      collected.push(f.rel);
    } catch (e) {
      if (signal.aborted) throw e;
      problems.push(`${f.rel}: ${errorMessage(e)}`);
    }
  }
  return problems.join("; ");
}

// 既存のシンボリックリンクを辿らない（O_NOFOLLOW）。許可ビットはゲストの所有者の分だけを
// 引き継ぎ、ほかのユーザーには読ませない（ホストの共有ディレクトリに置かれることを考えて）。
async function writeHostFile(dst: string, data: AsyncIterable<Uint8Array>, guestMode: number): Promise<bigint> {
  await fs.mkdir(path.dirname(dst), { recursive: true, mode: 0o700 });
  const mode = (guestMode & 0o700) | 0o600;
  const fh = await fs.open(dst, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_TRUNC | fsc.O_NOFOLLOW, mode);
  let n = 0n;
  try {
    for await (const chunk of data) {
      await fh.write(chunk);
      n += BigInt(chunk.length);
    }
    await fh.chmod(mode);
  } catch (e) {
    await fh.close();
    await fs.rm(dst, { force: true });
    throw e;
  }
  await fh.close();
  return n;
}

const HIGH_WATER = 64;

// runJobをConnectのサーバーストリームの形にする。emitは溜まりすぎると待たされる
// （VMの出力をクライアントの速さに合わせる）。クライアントが去ると（ジェネレーターが
// 閉じられる、またはsignalが中断する）ジョブを中断し、VMを壊し終えるまで待ってから閉じる。
export async function* streamJob(env: JobEnv, req: RunJobRequest, signal: AbortSignal): AsyncGenerator<RunJobEventBody> {
  const queue: RunJobEventBody[] = [];
  let waiters: (() => void)[] = [];
  let wake: (() => void) | undefined;
  let done = false;
  let gone = false;
  let error: unknown;
  const release = () => {
    const ws = waiters;
    waiters = [];
    for (const w of ws) w();
  };
  const emit = async (ev: RunJobEventBody) => {
    if (gone) return;
    queue.push(ev);
    wake?.();
    if (queue.length >= HIGH_WATER) await new Promise<void>((r) => waiters.push(r));
  };
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) ac.abort();
  const task = runJob(env, req, emit, ac.signal).then(
    () => {
      done = true;
      wake?.();
    },
    (e: unknown) => {
      error = e;
      done = true;
      wake?.();
    },
  );
  try {
    for (;;) {
      while (queue.length > 0) {
        const ev = queue.shift()!;
        if (queue.length < HIGH_WATER) release();
        yield ev;
      }
      if (done) break;
      await new Promise<void>((r) => (wake = r));
      wake = undefined;
    }
    if (error !== undefined) throw error;
  } finally {
    gone = true;
    release();
    ac.abort();
    await task;
    signal.removeEventListener("abort", onAbort);
  }
}

// サービスでのJobEnv。CreateSandboxと同じレジストリでVMを作るが、sandboxes.jsonには書かない。
export function sandboxJobEnv(registry: SandboxRegistry, images: ImageStore): JobEnv {
  return {
    async create(id, req, user, watchSignal) {
      const { image, imageDir } = await bootableImage(images, req.buildId);
      const record: SandboxRecord = {
        id,
        buildId: req.buildId,
        createdAt: new Date().toISOString(),
        defaultUser: user,
        memoryMib: req.memoryMib || DEFAULT_MEMORY_MIB,
        cpus: req.cpus || DEFAULT_CPUS,
        diskMib: req.diskMib,
        imageEnv: parseImageEnv(image.env ?? []),
        env: { ...req.env },
        policy: { allowedHosts: [...req.allowedHosts], enabledSecrets: [] },
        secretNames: [],
        tcpMaps: [],
      };
      try {
        await registry.create(record, [], imageDir, { ephemeral: true });
      } catch (e) {
        if (e instanceof ConnectError) throw e;
        log.error("job sandbox boot failed", { id, error: e });
        throw new ConnectError(`boot failed: ${(e as Error).message}`, Code.Internal);
      }
      // 再送（after_seq 0）で起動中からのイベントも受け取る。起動直後で1000件の上限には届かない。
      const events = registry.watchEvents(id, 0n, watchSignal);
      async function* denied(): AsyncGenerator<Denial> {
        for await (const ev of events) if (ev.event.case === "httpDenied") yield { host: ev.event.value.host, reason: ev.event.value.reason };
      }
      return { ...jobGuest(registry.running(id)), denied: denied() };
    },
    destroy: (id) => registry.destroy(id),
    source: (id) => jobGuest(registry.running(id)),
  };
}

function jobGuest(sb: RunningSandbox): JobGuest {
  return {
    async *exec(spec, signal) {
      const release = sb.execSlots.acquire();
      try {
        const baseEnv = execBaseEnv(await sb.home(spec.user, signal), sb.record.imageEnv, sb.env);
        yield* runExec(sb.vm, { argv: [], shell: spec.shell, user: spec.user, cwd: spec.cwd, env: {}, stdin: new Uint8Array(), pty: false, timeoutMs: spec.timeoutMs }, sb.record.defaultUser, baseEnv, signal);
      } finally {
        release();
      }
    },
    list: (root, patterns, signal) => listGuestFiles(sb.vm, root, patterns, signal),
    read: (p, maxBytes, signal) => readGuestFile(sb.vm, p, maxBytes, signal),
    write: (header, data, signal) => writeGuestFile(sb.vm, header, sb.record.defaultUser, data, signal),
    mkdir: (dir, owner, signal) => ensureGuestDir(sb.vm, dir, owner, signal),
  };
}
