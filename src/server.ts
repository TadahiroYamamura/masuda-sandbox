import fs from "node:fs/promises";
import http2 from "node:http2";
import net from "node:net";
import path from "node:path";

import { connectNodeAdapter } from "@connectrpc/connect-node";
import { gcSessions } from "@earendil-works/gondolin";

import { SandboxService } from "./gen/masuda/sandbox/v1/sandbox_pb.js";
import { log } from "./log.js";
import { ImageStore } from "./images.js";
import { SandboxRegistry } from "./sandboxes.js";
import { sandboxServiceImpl } from "./service.js";

export interface ServeOptions {
  socketPath: string;
}

function socketIsLive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(socketPath);
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("error", () => resolve(false));
  });
}

// A leftover socket from a crashed run is removed, but a socket another live
// instance still listens on is not: unlinking it would silently steal that
// instance's address. Anything that is not a socket is never deleted.
async function clearStaleSocket(socketPath: string): Promise<void> {
  let st;
  try {
    st = await fs.lstat(socketPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  if (!st.isSocket()) throw new Error(`${socketPath} exists and is not a socket`);
  if (await socketIsLive(socketPath)) throw new Error(`another server is listening on ${socketPath}`);
  await fs.unlink(socketPath);
  log.info("removed stale socket", { socket: socketPath });
}

export async function serve(opts: ServeOptions): Promise<void> {
  const socketPath = path.resolve(opts.socketPath);

  const removed = await gcSessions();
  log.info("gondolin sessions collected", { removed });

  await fs.mkdir(path.dirname(socketPath), { recursive: true });
  await clearStaleSocket(socketPath);

  const registry = new SandboxRegistry();
  await registry.load();
  const handler = connectNodeAdapter({
    routes: (router) => router.service(SandboxService, sandboxServiceImpl(registry, new ImageStore())),
  });
  const server = http2.createServer(handler);
  const sessions = new Set<http2.ServerHttp2Session>();
  server.on("session", (s) => {
    sessions.add(s);
    s.once("close", () => sessions.delete(s));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  // The API has no authentication; the socket's permissions are the boundary.
  await fs.chmod(socketPath, 0o600);
  log.info("listening", { socket: socketPath, pid: process.pid });

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutting down", { signal });
    server.close();
    for (const s of sessions) s.close();
    const failures = await registry.shutdown();
    for (const f of failures) log.error("closing a VM failed during shutdown", { id: f.id, error: f.error });
    await fs.unlink(socketPath).catch(() => {});
    log.info("stopped");
    process.exit(failures.length ? 1 : 0);
  };
  process.on("SIGTERM", (sig) => void shutdown(sig));
  process.on("SIGINT", (sig) => void shutdown(sig));
}
