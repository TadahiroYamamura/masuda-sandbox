import { describe, expect, it } from "vitest";

import { Egress } from "../../src/egress.js";
import { EventQueue } from "../../src/events.js";
import { watchConnections } from "../../src/netwatch.js";

// Stands in for Gondolin's QemuNetworkBackend: the stack calls these methods
// through `this.`, and handleTcpSend starts the asynchronous HTTP handling,
// which answers with `status` written as plaintext to the guest: to the stack
// for http, to the MITM TLSSocket (whose ciphertext goes to the stack) for tls.
class FakeBackend {
  handled: Promise<unknown>[] = [];
  tcpSessions = new Map<string, { protocol: string; tls?: { socket: { write: (c: Buffer) => boolean } } }>();
  toGuest: Record<string, string> = {};
  stack = {
    handleTcpData: (m: { key: string; data: Buffer }) => {
      this.toGuest[m.key] = (this.toGuest[m.key] ?? "") + m.data.toString("latin1");
    },
  };
  constructor(private readonly eg: Egress) {}
  handleTcpConnect(m: { key: string; protocol?: string }) {
    this.tcpSessions.set(m.key, { protocol: m.protocol ?? "tls" });
    return { allowRawTcp: false };
  }
  ensureTlsSession(key: string, session: { tls?: { socket: { write: (c: Buffer) => boolean } } }) {
    session.tls ??= { socket: { write: (c: Buffer) => (this.stack.handleTcpData({ key, data: Buffer.from(c.toString("base64")) }), true) } };
    return session.tls;
  }
  handleTcpSend(m: { key: string; url: string; status?: number }) {
    const session = this.tcpSessions.get(m.key)!;
    const write = session.protocol === "tls"
      ? (c: Buffer) => this.ensureTlsSession(m.key, session).socket.write(c)
      : (c: Buffer) => this.stack.handleTcpData({ key: m.key, data: c });
    this.handled.push((async () => {
      await Promise.resolve();
      await this.eg.httpHooks.onRequest!(new Request(m.url));
      if (m.status === undefined) return;
      this.eg.onDebug("net", `http bridge response ${m.status} X`);
      write(Buffer.from(`HTTP/1.1 ${m.status} X\r\n\r\n`));
    })());
  }
  handleTcpClose(_m: { key: string }) {}
  abortTcpSession(_key: string, _session: unknown, _reason: string) {}
}

function setup(alter: (b: FakeBackend) => void = () => {}) {
  const events = new EventQueue();
  const eg = new Egress([], { allowedHosts: ["api.example.com"], enabledSecrets: [] }, events);
  const backend = new FakeBackend(eg);
  alter(backend);
  const vm = { server: { network: backend } };
  return { events, eg, backend, ok: watchConnections(vm as never, eg.connections) };
}

const statuses = (q: EventQueue) => q.after(0n).flatMap((e) => (e.event.case === "httpFinished" ? [e.event.value.status] : []));

describe("watchConnections", () => {
  it("finishes a request when its connection is closed or aborted", async () => {
    const { events, eg, backend, ok } = setup();
    expect(ok).toBe(true);
    expect(backend.handleTcpConnect({ key: "a" })).toEqual({ allowRawTcp: false });
    backend.handleTcpSend({ key: "a", url: "https://api.example.com/1" } as never);
    backend.handleTcpConnect({ key: "b" });
    backend.handleTcpSend({ key: "b", url: "https://api.example.com/2" } as never);
    await Promise.all(backend.handled);
    expect(eg.activity().inflight).toBe(2);
    backend.handleTcpClose({ key: "a" });
    backend.abortTcpSession("b", {}, "test");
    expect(statuses(events)).toEqual([0, 0]);
    expect(eg.activity().inflight).toBe(0);
  });

  it("reads the status from the plaintext written to the guest, over http and tls", async () => {
    const { events, backend } = setup();
    backend.handleTcpConnect({ key: "p", protocol: "http" });
    backend.handleTcpSend({ key: "p", url: "http://api.example.com/1", status: 418 } as never);
    backend.handleTcpConnect({ key: "t" });
    backend.handleTcpSend({ key: "t", url: "https://api.example.com/2", status: 201 } as never);
    await Promise.all(backend.handled);
    expect(backend.toGuest.p).toBe("HTTP/1.1 418 X\r\n\r\n");
    expect(backend.toGuest.t).toBe(Buffer.from("HTTP/1.1 201 X\r\n\r\n").toString("base64"));
    backend.handleTcpClose({ key: "p" });
    backend.handleTcpClose({ key: "t" });
    expect(statuses(events)).toEqual([418, 201]);
  });

  it("still ends requests, with status 0, when the response writers are not recognized", async () => {
    const { events, backend } = setup((b) => Object.assign(b, { ensureTlsSession: undefined }));
    backend.handleTcpConnect({ key: "t", protocol: "http" });
    backend.handleTcpSend({ key: "t", url: "http://api.example.com/", status: 200 } as never);
    await Promise.all(backend.handled);
    backend.handleTcpClose({ key: "t" });
    expect(statuses(events)).toEqual([0]);
  });

  it("reports false and leaves the VM alone when the backend is not recognized", () => {
    const events = new EventQueue();
    const eg = new Egress([], { allowedHosts: [], enabledSecrets: [] }, events);
    expect(watchConnections({ server: { network: null } } as never, eg.connections)).toBe(false);
    expect(watchConnections({} as never, eg.connections)).toBe(false);
  });
});
