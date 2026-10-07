import { Code, ConnectError } from "@connectrpc/connect";
import path from "node:path";

import { baseDir, match } from "./glob.js";
import type { GuestVm } from "./vm.js";

const DEFAULT_MAX_BYTES = 64n * 1024n * 1024n;
const CHUNK_BYTES = 64 * 1024;
const DEFAULT_MODE = 0o644;
const USER_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*\$?$/;

function guestPath(p: string): string {
  if (!p.startsWith("/") || p.includes("\0")) throw new ConnectError(`path must be an absolute guest path: ${JSON.stringify(p)}`, Code.InvalidArgument);
  const norm = path.posix.normalize(p);
  if (norm === "/" || norm.endsWith("/")) throw new ConnectError(`path must name a file: ${JSON.stringify(p)}`, Code.InvalidArgument);
  return norm;
}

async function sh(vm: GuestVm, script: string, args: string[], signal: AbortSignal) {
  return vm.exec(["/bin/sh", "-c", script, "masuda-files", ...args], { signal });
}

// vm.fs.stat follows symlinks (stat -L), so the type check is our own lstat.
// The check and Gondolin's read are separate guest operations: a guest process
// that swaps the file for a symlink in between still gets it followed. The
// file op runs as root, but root-only guest files hold nothing the host does
// not already have (secret values never enter the guest), so the race was
// accepted over reimplementing the read through Exec.
export async function* readGuestFile(vm: GuestVm, rawPath: string, maxBytes: bigint, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  const p = guestPath(rawPath);
  const limit = maxBytes > 0n ? maxBytes : DEFAULT_MAX_BYTES;
  const st = await sh(vm, 'exec stat -c "%F|%s" -- "$1"', [p], signal);
  const [kind, size] = st.stdout.trim().split("|");
  if (st.exitCode !== 0 || (kind !== "regular file" && kind !== "regular empty file")) {
    throw new ConnectError(`${p} is not a regular file`, Code.NotFound);
  }
  if (BigInt(size ?? "0") > limit) throw new ConnectError(`${p} is ${size} bytes, over the limit of ${limit}`, Code.ResourceExhausted);

  const stream = await vm.fs.readFileStream(p, { chunkSize: CHUNK_BYTES, signal }).catch((e: Error) => {
    throw new ConnectError(`read ${p}: ${e.message}`, Code.Internal);
  });
  let total = 0n;
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      total += BigInt(chunk.length);
      // The file may have grown since the stat.
      if (total > limit) throw new ConnectError(`${p} grew over the limit of ${limit}`, Code.ResourceExhausted);
      yield chunk;
    }
  } finally {
    stream.destroy();
  }
}

export interface WriteHeader {
  path: string;
  mode: number;
  owner: string;
}

// Prepares a write: creates missing parent directories (handing the new ones
// to the owner, so that the owner can work in them afterwards) and a private
// root-only directory beside the target for the temporary file. The temporary
// file lives in that directory rather than directly beside the target because
// the parent is usually writable by the guest user, who could otherwise swap
// the temporary file for a symlink before chmod/chown run on it.
const PREPARE = `set -eu
target=$1; owner=$2
id -u -- "$owner" >/dev/null 2>&1 || exit 3
[ -d "$target" ] && [ ! -L "$target" ] && exit 4
dir=$(dirname -- "$target")
d=$dir; created=""
while [ ! -e "$d" ] && [ ! -L "$d" ]; do created="$d
$created"; d=$(dirname -- "$d"); done
mkdir -p -- "$dir"
printf '%s' "$created" | while IFS= read -r x; do if [ -n "$x" ]; then chown -h -- "$owner": "$x"; fi; done
mktemp -d -- "$dir/.masuda-write.XXXXXXXX"`;

// rename(2) replaces a symlink at the target instead of following it; -T keeps
// mv from moving the file into a directory that appeared at the target.
const FINISH = `set -eu
tmp=$1; target=$2; mode=$3; owner=$4
chmod -- "$mode" "$tmp/f"
chown -h -- "$owner": "$tmp/f"
mv -f -T -- "$tmp/f" "$target"
rmdir -- "$tmp"`;

export async function writeGuestFile(vm: GuestVm, header: WriteHeader, defaultUser: string, data: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<bigint> {
  const p = guestPath(header.path);
  const mode = header.mode || DEFAULT_MODE;
  if (mode > 0o7777) throw new ConnectError(`invalid mode ${mode.toString(8)}`, Code.InvalidArgument);
  const owner = header.owner || defaultUser;
  if (!USER_NAME.test(owner)) throw new ConnectError(`invalid owner ${JSON.stringify(owner)}`, Code.InvalidArgument);

  const prep = await sh(vm, PREPARE, [p, owner], signal);
  if (prep.exitCode === 3) throw new ConnectError(`guest user ${JSON.stringify(owner)} does not exist`, Code.InvalidArgument);
  if (prep.exitCode === 4) throw new ConnectError(`${p} is a directory`, Code.FailedPrecondition);
  if (prep.exitCode !== 0) throw new ConnectError(`prepare ${p}: ${prep.stderr.trim()}`, Code.Internal);
  const tmp = prep.stdout.trim();

  let written = 0n;
  // Gondolin rewraps whatever the input throws as a plain Error; keeping it
  // here lets the caller's own status (e.g. InvalidArgument) through.
  let inputError: unknown;
  async function* counted(): AsyncGenerator<Buffer> {
    try {
      for await (const chunk of data) {
        written += BigInt(chunk.length);
        yield Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      }
    } catch (e) {
      inputError = e;
      throw e;
    }
  }
  try {
    try {
      await vm.fs.writeFile(`${tmp}/f`, counted(), { signal });
    } catch (e) {
      if (inputError !== undefined) throw inputError;
      throw new ConnectError(`write ${p}: ${(e as Error).message}`, signal.aborted ? Code.Canceled : Code.Internal);
    }
    const fin = await sh(vm, FINISH, [tmp, p, mode.toString(8), owner], signal);
    if (fin.exitCode !== 0) throw new ConnectError(`finish ${p}: ${fin.stderr.trim()}`, Code.Internal);
  } catch (e) {
    await sh(vm, 'rm -rf -- "$1"', [tmp], AbortSignal.timeout(30_000)).catch(() => {});
    throw e;
  }
  return written;
}

export interface GuestFileEntry {
  rel: string;
  mode: number;
  size: number;
}

// 各パターンのワイルドカードを含まない先頭のディレクトリからfindし、`.git`の下は見ない。
// findは開始点を含めてシンボリックリンクを辿らず、-type fで通常ファイルだけを返すので、
// rootの外を指すリンクの先は読まない。
const LIST = `cd -- "$1" 2>/dev/null || exit 3
shift
for b in "$@"; do
  [ -e "$b" ] || continue
  find "$b" -name .git -prune -o -type f -printf '%m %s %p\\0'
done`;

export async function listGuestFiles(vm: GuestVm, root: string, patterns: readonly string[], signal: AbortSignal): Promise<GuestFileEntry[]> {
  if (patterns.length === 0) return [];
  const dir = guestDir(root);
  const bases = [...new Set(patterns.map(baseDir))].sort();
  const r = await sh(vm, LIST, [dir, ...bases], signal);
  if (r.exitCode === 3) throw new ConnectError(`${dir} is not a directory in the guest`, Code.FailedPrecondition);
  if (r.exitCode !== 0) throw new ConnectError(`listing files under ${dir}: ${r.stderr.trim()}`, Code.Internal);
  return selectFiles(r.stdout, patterns);
}

export function selectFiles(out: string, patterns: readonly string[]): GuestFileEntry[] {
  const seen = new Set<string>();
  const files: GuestFileEntry[] = [];
  for (const rec of out.split("\0")) {
    const m = /^([0-7]+) (\d+) (.+)$/s.exec(rec);
    if (!m) continue;
    const rel = path.posix.normalize(m[3]!).replace(/^\.\//, "");
    if (seen.has(rel) || rel === "." || rel.startsWith("/") || rel === ".." || rel.startsWith("../")) continue;
    if (!patterns.some((p) => match(p, rel))) continue;
    seen.add(rel);
    files.push({ rel, mode: parseInt(m[1]!, 8) & 0o777, size: Number(m[2]) });
  }
  return files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

export function guestDir(p: string): string {
  if (!p.startsWith("/") || p.includes("\0")) throw new ConnectError(`path must be an absolute guest path: ${JSON.stringify(p)}`, Code.InvalidArgument);
  return path.posix.normalize(p).replace(/(.)\/$/, "$1");
}

export async function ensureGuestDir(vm: GuestVm, dir: string, owner: string, signal: AbortSignal): Promise<void> {
  const d = guestDir(dir);
  if (!USER_NAME.test(owner)) throw new ConnectError(`invalid owner ${JSON.stringify(owner)}`, Code.InvalidArgument);
  const r = await sh(vm, '[ -d "$1" ] && exit 0; mkdir -p -- "$1" && chown -- "$2": "$1"', [d, owner], signal);
  if (r.exitCode !== 0) throw new ConnectError(`creating ${d}: ${r.stderr.trim()}`, Code.FailedPrecondition);
}
