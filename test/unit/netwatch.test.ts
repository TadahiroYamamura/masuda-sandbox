import { describe, expect, it } from "vitest";

import { Egress } from "../../src/egress.js";
import { EventQueue } from "../../src/events.js";
import { watchConnections } from "../../src/netwatch.js";

// Stands in for Gondolin's QemuNetworkBackend: the stack calls these methods
// through `this.`, and handleTcpSend starts the asynchronous HTTP handling.
class FakeBackend {
  handled: Promise<unknown>[] = [];
  constructor(private readonly eg: Egress) {}
  handleTcpConnect(_m: { key: string }) {
    return { allowRawTcp: false };
  }
  handleTcpSend(m: { key: string; url: string }) {
    this.handled.push((async () => {
      await Promise.resolve();
      await this.eg.httpHooks.onRequest!(new Request(m.url));
    })());
  }
  handleTcpClose(_m: { key: string }) {}
  abortTcpSession(_key: string, _session: unknown, _reason: string) {}
}

function setup() {
  const events = new EventQueue();
  const eg = new Egress([], { allowedHosts: ["api.example.com"], enabledSecrets: [] }, events);
  const backend = new FakeBackend(eg);
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

  it("reports false and leaves the VM alone when the backend is not recognized", () => {
    const events = new EventQueue();
    const eg = new Egress([], { allowedHosts: [], enabledSecrets: [] }, events);
    expect(watchConnections({ server: { network: null } } as never, eg.connections)).toBe(false);
    expect(watchConnections({} as never, eg.connections)).toBe(false);
  });
});
