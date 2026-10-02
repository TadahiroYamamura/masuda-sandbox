import type { VM } from "@earendil-works/gondolin";

import type { GuestConnections } from "./egress.js";
import { log } from "./log.js";

interface TcpMessage {
  key: string;
}

type Handler = (message: TcpMessage, ...rest: unknown[]) => unknown;
type Write = (chunk: unknown, ...rest: unknown[]) => unknown;

interface TlsSession {
  socket?: { write?: Write };
}

const HANDLERS = ["handleTcpConnect", "handleTcpSend", "handleTcpClose", "abortTcpSession"] as const;

// Reports the guest's TCP connections to GuestConnections by wrapping four
// methods of Gondolin's network backend (QemuNetworkBackend, reached as
// vm.server.network). None of this is public API: it is the only place where
// Gondolin learns that the guest closed a connection, and nothing about it is
// emitted (checked against 0.12.0). The backend calls these methods through
// `this.` from its stack callbacks, so replacing them on the instance takes
// effect. abortTcpSession takes (key, session, reason) rather than a message.
//
// If a later Gondolin renames them, this returns false and the caller falls
// back to onResponse (Egress.useResponseHook), as before S12: responses are
// buffered, requests are paired by method and URL, and a request whose
// response never comes is dropped from inflight only by the 10-minute rule.
export function watchConnections(vm: VM, conns: GuestConnections): boolean {
  const network = (vm as unknown as { server?: { network?: Record<string, unknown> | null } }).server?.network;
  if (!network || HANDLERS.some((h) => typeof network[h] !== "function")) {
    log.warn("gondolin network backend not recognized; HTTP responses are buffered and requests ended without a response are only expired after 10 minutes");
    return false;
  }
  const orig = Object.fromEntries(HANDLERS.map((h) => [h, (network[h] as Handler).bind(network)])) as Record<(typeof HANDLERS)[number], Handler>;
  const watchStack = watchResponses(network, conns);
  network.handleTcpConnect = (m: TcpMessage) => {
    watchStack?.();
    conns.opened(m.key);
    return orig.handleTcpConnect(m);
  };
  network.handleTcpSend = (m: TcpMessage) => conns.run(m.key, () => orig.handleTcpSend(m));
  network.handleTcpClose = (m: TcpMessage) => {
    try {
      return orig.handleTcpClose(m);
    } finally {
      conns.closed(m.key);
    }
  };
  network.abortTcpSession = (key: unknown, ...rest: unknown[]) => {
    try {
      return (orig.abortTcpSession as unknown as (...a: unknown[]) => unknown)(key, ...rest);
    } finally {
      if (typeof key === "string") conns.closed(key);
    }
  };
  return true;
}

// Shows GuestConnections the plaintext bytes Gondolin writes to the guest, so
// that the response's status line can be read. Plain HTTP responses are
// written straight to the network stack (stack.handleTcpData); for HTTPS
// Gondolin writes the plaintext to its MITM TLSSocket, whose encrypted output
// reaches the same stack call, so there only "http" sessions are read and
// TLS sessions are read at the TLSSocket's write, wrapped when
// ensureTlsSession creates it. Not public API either (checked against
// 0.12.0). The stack is replaced on every reset of the backend, so the
// returned function, called on each new connection, wraps the current one.
//
// If these are not there, requests still end with their connection but
// with status 0, and null is returned.
function watchResponses(network: Record<string, unknown>, conns: GuestConnections): (() => void) | null {
  const sessions = network.tcpSessions;
  if (!(sessions instanceof Map) || typeof network.ensureTlsSession !== "function") {
    log.warn("gondolin network backend not recognized; HTTP requests finish with status 0");
    return null;
  }
  const ensureTls = (network.ensureTlsSession as (key: string, session: unknown) => TlsSession | undefined).bind(network);
  network.ensureTlsSession = (key: string, session: { tls?: TlsSession }) => {
    const before = session?.tls;
    const tls = ensureTls(key, session);
    const sock = tls?.socket;
    if (tls && tls !== before && sock && typeof sock.write === "function") {
      const write = sock.write.bind(sock);
      const sink = conns.sink(key);
      sock.write = (chunk: unknown, ...rest: unknown[]) => {
        observe(sink, chunk);
        return write(chunk, ...rest);
      };
    }
    return tls;
  };
  const wrapped = new WeakSet<object>();
  let warned = false;
  return () => {
    const stack = network.stack as { handleTcpData?: (m: { key: string; data: unknown }) => unknown } | null | undefined;
    if (!stack || wrapped.has(stack)) return;
    wrapped.add(stack);
    if (typeof stack.handleTcpData !== "function") {
      if (!warned) log.warn("gondolin network stack not recognized; plain HTTP requests finish with status 0");
      warned = true;
      return;
    }
    const send = stack.handleTcpData.bind(stack);
    stack.handleTcpData = (m) => {
      if ((sessions.get(m.key) as { protocol?: unknown } | undefined)?.protocol === "http") observe(conns.sink(m.key), m.data);
      return send(m);
    };
  };
}

function observe(sink: (data: Uint8Array) => void, chunk: unknown): void {
  if (chunk instanceof Uint8Array) sink(chunk);
  else if (typeof chunk === "string") sink(Buffer.from(chunk, "latin1"));
}
