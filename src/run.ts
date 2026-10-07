import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { RunJobRequest_InputSchema, RunJobRequestSchema, SandboxService, type RunJobEvent_Finished, type RunJobRequest_Input } from "./gen/masuda/sandbox/v1/sandbox_pb.js";

export const runUsage = `usage: masuda-sandbox run --socket <path> --build-id <id> [options] -- <shell command>
  --allow-host <host>        許可する通信先（繰り返し可）。無ければ何も通さない
  --input <host>:<guest>     ホストのファイルをゲストへ写す（繰り返し可）
  --from-sandbox <id>:<root>:<pattern>
                             動いているsandboxのroot以下でpatternに当たるファイルをcwdの下へ写す（繰り返し可）
  --setup <shell>            コマンドの前に動かす前処理
  --outputs <pattern>        回収するファイル（cwdからの相対glob。繰り返し可）。--outが要る
  --out <dir>                回収したファイルを置くホストのディレクトリ
  --timeout <seconds>        コマンドの期限
  --job-timeout <seconds>    VMの作成から回収までの全体の期限
  --user <user>              既定 root
  --cwd <dir>                既定 /workspace
  --env <K=V>                環境変数（繰り返し可）
  --memory <MiB> --cpus <n> --disk <MiB>
終了コード: コマンドの終了コード（シグナルなら128+番号）。ほかに
  124 コマンドが--timeoutで時間切れ  122 前処理が失敗  123 全体の期限切れ
  125 ジョブを動かせなかった（接続・起動・投入の失敗）  2 使い方の誤り  130 中断（Ctrl-C）`;

// 終了コードの割り当て。コマンド自身の終了コードと重なりうるが、理由は必ずstderrに書く。
// 124はtimeout(1)、125はdocker runの「コマンドを動かす前の失敗」に合わせた。
export const EXIT_TIMED_OUT = 124;
export const EXIT_SETUP_FAILED = 122;
export const EXIT_JOB_TIMED_OUT = 123;
export const EXIT_JOB_FAILED = 125;
export const EXIT_USAGE = 2;
export const EXIT_INTERRUPTED = 130;

class UsageError extends Error {}

function seconds(flag: string, v: string | undefined): number {
  if (v === undefined) return 0;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new UsageError(`${flag} must be a non-negative number of seconds`);
  return Math.round(n * 1000);
}

function count(flag: string, v: string | undefined): number {
  if (v === undefined) return 0;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new UsageError(`${flag} must be a non-negative integer`);
  return n;
}

async function hostInput(spec: string): Promise<RunJobRequest_Input> {
  const i = spec.lastIndexOf(":");
  if (i <= 0 || i === spec.length - 1) throw new UsageError(`--input must be <host path>:<guest path>: ${JSON.stringify(spec)}`);
  const hostPath = path.resolve(spec.slice(0, i));
  const st = await fs.stat(hostPath).catch(() => undefined);
  if (!st?.isFile()) throw new UsageError(`--input: ${hostPath} is not a regular file`);
  return create(RunJobRequest_InputSchema, { source: { case: "hostFile", value: { hostPath, guestPath: spec.slice(i + 1), mode: st.mode & 0o777 } } });
}

function fromSandboxInput(spec: string): RunJobRequest_Input {
  const [id, root, ...rest] = spec.split(":");
  const pattern = rest.join(":");
  if (!id || !root || !pattern) throw new UsageError(`--from-sandbox must be <id>:<root>:<pattern>: ${JSON.stringify(spec)}`);
  return create(RunJobRequest_InputSchema, { source: { case: "fromSandbox", value: { id, root, patterns: [pattern], destRoot: "" } } });
}

function parseEnv(entries: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const e of entries) {
    const i = e.indexOf("=");
    if (i <= 0) throw new UsageError(`--env must be K=V: ${JSON.stringify(e)}`);
    env[e.slice(0, i)] = e.slice(i + 1);
  }
  return env;
}

function write(stream: NodeJS.WriteStream, data: Uint8Array | string): Promise<void> {
  return new Promise((resolve) => {
    if (stream.write(data)) resolve();
    else stream.once("drain", resolve);
  });
}

function signalExit(sig: string): number {
  const n = (os.constants.signals as Record<string, number>)[sig];
  return n ? 128 + n : 128;
}

export function exitCodeOf(f: RunJobEvent_Finished): number {
  if (f.jobTimedOut) return EXIT_JOB_TIMED_OUT;
  if (f.setup && (f.setup.exitCode !== 0 || f.setup.signal !== "")) return EXIT_SETUP_FAILED;
  const e = f.exited;
  if (!e) return EXIT_JOB_FAILED;
  if (e.timedOut) return EXIT_TIMED_OUT;
  if (e.signal) return signalExit(e.signal);
  return e.exitCode < 0 || e.exitCode > 255 ? EXIT_JOB_FAILED : e.exitCode;
}

function report(f: RunJobEvent_Finished): string[] {
  const lines: string[] = [];
  if (f.jobTimedOut) lines.push("the job timed out (--job-timeout); the VM was destroyed");
  if (f.setup && (f.setup.exitCode !== 0 || f.setup.signal !== "")) lines.push(`setup failed (exit ${f.setup.exitCode}${f.setup.signal ? `, ${f.setup.signal}` : ""}); the command did not run`);
  if (f.exited?.timedOut) lines.push("the command timed out (--timeout)");
  for (const o of f.outputs) lines.push(`output: ${o}`);
  if (f.outputsError) lines.push(`outputs error: ${f.outputsError}`);
  if (f.deniedHosts.length > 0) {
    lines.push("denied hosts:");
    for (const d of f.deniedHosts) lines.push(`  ${d.host} (${d.reason}) x${d.count}`);
  }
  return lines;
}

// RunJobのクライアント。サービスの中身を直接は呼ばない（同じsandboxes.json・images.jsonを
// 稼働中のサービスと別のプロセスから書き換えないため）。返り値は終了コード。
export async function runCommand(argv: string[]): Promise<number> {
  let req;
  let socket: string;
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        socket: { type: "string" },
        "build-id": { type: "string" },
        "allow-host": { type: "string", multiple: true },
        input: { type: "string", multiple: true },
        "from-sandbox": { type: "string", multiple: true },
        setup: { type: "string" },
        outputs: { type: "string", multiple: true },
        out: { type: "string" },
        timeout: { type: "string" },
        "job-timeout": { type: "string" },
        user: { type: "string" },
        cwd: { type: "string" },
        env: { type: "string", multiple: true },
        memory: { type: "string" },
        cpus: { type: "string" },
        disk: { type: "string" },
      },
    });
    if (!values.socket) throw new UsageError("--socket is required");
    if (!values["build-id"]) throw new UsageError("--build-id is required");
    const shell = positionals.join(" ");
    if (!shell) throw new UsageError("a command after -- is required");
    const outputs = values.outputs ?? [];
    if (outputs.length > 0 && !values.out) throw new UsageError("--outputs needs --out");
    socket = values.socket;
    const inputs = [...(await Promise.all((values.input ?? []).map(hostInput))), ...(values["from-sandbox"] ?? []).map(fromSandboxInput)];
    req = create(RunJobRequestSchema, {
      buildId: values["build-id"],
      allowedHosts: values["allow-host"] ?? [],
      inputs,
      setupShell: values.setup ?? "",
      shell,
      outputs,
      outputsHostDir: values.out ? path.resolve(values.out) : "",
      timeoutMs: seconds("--timeout", values.timeout),
      jobTimeoutMs: seconds("--job-timeout", values["job-timeout"]),
      user: values.user ?? "",
      cwd: values.cwd ?? "",
      env: parseEnv(values.env ?? []),
      memoryMib: count("--memory", values.memory),
      cpus: count("--cpus", values.cpus),
      diskMib: count("--disk", values.disk),
    });
  } catch (e) {
    process.stderr.write(`masuda-sandbox: ${(e as Error).message}\n${runUsage}\n`);
    return EXIT_USAGE;
  }

  const transport = createConnectTransport({
    baseUrl: "http://localhost",
    httpVersion: "2",
    nodeOptions: { createConnection: () => net.connect(socket) },
  });
  const client = createClient(SandboxService, transport);
  const ac = new AbortController();
  const onSigint = () => ac.abort();
  process.once("SIGINT", onSigint);
  let finished: RunJobEvent_Finished | undefined;
  try {
    for await (const ev of client.runJob(req, { signal: ac.signal })) {
      const e = ev.event;
      if (e.case === "stdout") await write(process.stdout, e.value);
      else if (e.case === "stderr") await write(process.stderr, e.value);
      else if (e.case === "phase") await write(process.stderr, `masuda-sandbox: ${e.value.name} (${e.value.sandboxId})\n`);
      else if (e.case === "finished") finished = e.value;
    }
  } catch (e) {
    if (ac.signal.aborted) {
      process.stderr.write("masuda-sandbox: interrupted; the service destroys the VM\n");
      return EXIT_INTERRUPTED;
    }
    const msg = e instanceof ConnectError ? `${Code[e.code]}: ${e.rawMessage}` : (e as Error).message;
    process.stderr.write(`masuda-sandbox: the job failed: ${msg}\n`);
    return EXIT_JOB_FAILED;
  } finally {
    process.off("SIGINT", onSigint);
  }
  if (!finished) {
    process.stderr.write("masuda-sandbox: the stream ended without a result\n");
    return EXIT_JOB_FAILED;
  }
  for (const l of report(finished)) process.stderr.write(`masuda-sandbox: ${l}\n`);
  return exitCodeOf(finished);
}
