import type { VM } from "@earendil-works/gondolin";

import type { GuestConnections } from "./egress.js";
import { log } from "./log.js";

interface TcpMessage {
  key: string;
}

type Handler = (message: TcpMessage, ...rest: unknown[]) => unknown;

const HANDLERS = ["handleTcpConnect", "handleTcpSend", "handleTcpClose", "abortTcpSession"] as const;

// Reports the guest's TCP connections to GuestConnections by wrapping four
// methods of Gondolin's network backend (QemuNetworkBackend, reached as
// vm.server.network). None of this is public API: it is the only place where
// Gondolin learns that the guest closed a connection, and nothing about it is
// emitted (checked against 0.12.0). The backend calls these methods through
// `this.` from its stack callbacks, so replacing them on the instance takes
// effect. abortTcpSession takes (key, session, reason) rather than a message.
//
// If a later Gondolin renames them, this returns false and the service runs
// as before S11: requests are paired by method and URL, and a request whose
// response never comes is dropped from inflight only by the 10-minute rule.
export function watchConnections(vm: VM, conns: GuestConnections): boolean {
  const network = (vm as unknown as { server?: { network?: Record<string, unknown> | null } }).server?.network;
  if (!network || HANDLERS.some((h) => typeof network[h] !== "function")) {
    log.warn("gondolin network backend not recognized; HTTP requests ended without a response are only expired after 10 minutes");
    return false;
  }
  const orig = Object.fromEntries(HANDLERS.map((h) => [h, (network[h] as Handler).bind(network)])) as Record<(typeof HANDLERS)[number], Handler>;
  network.handleTcpConnect = (m: TcpMessage) => {
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
