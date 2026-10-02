import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";

import { Egress, responseStatus } from "../../src/egress.js";
import { EventQueue } from "../../src/events.js";
import { SecretDeclSchema, SubstituteIn } from "../../src/gen/masuda/sandbox/v1/sandbox_pb.js";

const secrets = [
  create(SecretDeclSchema, { name: "HDR", value: "real-hdr", hosts: ["api.example.com"], substituteIn: [SubstituteIn.HEADER], placeholderPrefix: "tok_", placeholderLength: 32 }),
  create(SecretDeclSchema, { name: "BODY", value: "real-body", hosts: ["api.example.com"], substituteIn: [SubstituteIn.HEADER, SubstituteIn.BODY] }),
];

function setup(enabled: string[] = []) {
  const events = new EventQueue();
  const eg = new Egress(secrets, { allowedHosts: ["api.example.com"], enabledSecrets: enabled }, events);
  // The hooks Gondolin would call, in its order: onRequest, then isRequestAllowed on the result.
  const send = async (req: Request): Promise<Request> => {
    const out = ((await eg.httpHooks.onRequest!(req)) as Request | undefined) ?? req;
    if (!(await eg.httpHooks.isRequestAllowed!(out))) throw new Error("blocked by request policy");
    return out;
  };
  return { eg, events, send };
}

const reasons = (q: EventQueue) => q.after(0n).flatMap((e) => (e.event.case === "httpDenied" ? [e.event.value.reason] : []));

describe("Egress", () => {
  it("makes placeholders in the requested shape", () => {
    const { eg } = setup();
    expect(eg.placeholders.HDR).toMatch(/^tok_[A-Za-z0-9]{32}$/);
    expect(eg.placeholders.BODY).toMatch(/^masuda_secret_[A-Za-z0-9]{40}$/);
  });

  it("denies hosts outside the policy and follows setPolicy", async () => {
    const { eg, events, send } = setup();
    await expect(send(new Request("https://other.example.org/"))).rejects.toThrow(/host-not-allowed/);
    eg.setPolicy({ allowedHosts: ["*.example.org"], enabledSecrets: [] });
    await expect(send(new Request("https://other.example.org/"))).resolves.toBeDefined();
    await expect(send(new Request("https://api.example.com/"))).rejects.toThrow(/host-not-allowed/);
    expect(reasons(events)).toEqual(["host-not-allowed", "host-not-allowed"]);
  });

  it("denies a disabled secret's placeholder in headers and bodies", async () => {
    const { eg, events, send } = setup();
    await expect(send(new Request("https://api.example.com/", { headers: { authorization: `Bearer ${eg.placeholders.HDR}` } }))).rejects.toThrow(/secret-not-enabled/);
    const basic = Buffer.from(`u:${eg.placeholders.HDR}`).toString("base64");
    await expect(send(new Request("https://api.example.com/", { headers: { authorization: `Basic ${basic}` } }))).rejects.toThrow(/secret-not-enabled/);
    await expect(send(new Request("https://api.example.com/", { method: "POST", body: `k=${eg.placeholders.HDR}` }))).rejects.toThrow(/secret-not-enabled/);
    expect(reasons(events)).toEqual(["secret-not-enabled", "secret-not-enabled", "secret-not-enabled"]);
  });

  it("substitutes in headers and, only for BODY secrets, in bodies", async () => {
    const { eg, events, send } = setup(["HDR", "BODY"]);
    const h = await send(new Request("https://api.example.com/x?q=1", { headers: { authorization: `Bearer ${eg.placeholders.HDR}` } }));
    expect(h.headers.get("authorization")).toBe("Bearer real-hdr");
    const b = await send(new Request("https://api.example.com/", { method: "POST", body: `{"a":"${eg.placeholders.BODY}","b":"${eg.placeholders.HDR}"}` }));
    expect(await b.text()).toBe(`{"a":"real-body","b":"${eg.placeholders.HDR}"}`);
    const started = events.after(0n).flatMap((e) => (e.event.case === "httpStarted" ? [e.event.value] : []));
    expect(started.map((s) => [s.method, s.host, s.path])).toEqual([["GET", "api.example.com", "/x"], ["POST", "api.example.com", "/"]]);
  });

  it("refuses a secret on a host outside its own hosts even when enabled", async () => {
    const { eg, send } = setup(["BODY"]);
    eg.setPolicy({ allowedHosts: ["api.example.com", "evil.example.net"], enabledSecrets: ["BODY"] });
    await expect(send(new Request("https://evil.example.net/", { method: "POST", body: eg.placeholders.BODY }))).rejects.toThrow(/secret-not-enabled/);
  });

  it("rejects unknown names in enabled_secrets", () => {
    const { eg } = setup();
    expect(() => eg.setPolicy({ allowedHosts: [], enabledSecrets: ["NOPE"] })).toThrow(/unknown secret/);
  });

  describe("finishing started requests", () => {
    const finished = (q: EventQueue) => q.after(0n).flatMap((e) => (e.event.case === "httpFinished" ? [[Number(e.event.value.requestId), e.event.value.status]] : []));
    const ok = (status = 200) => new Response("x", { status });
    // As Gondolin does: the hooks run inside the handling of the guest's bytes.
    const onConn = <T>(eg: Egress, key: string, fn: () => Promise<T>) => eg.connections.run(key, fn);
    // What Gondolin does once the upstream answered: log it in the
    // connection's context, then write the response head to the guest.
    const respond = (eg: Egress, key: string, status: number) => {
      eg.onDebug("net", `http bridge response ${status} X`);
      eg.connections.sink(key)(Buffer.from(`HTTP/1.1 ${status} X\r\ncontent-length: 1\r\n\r\nx`));
    };
    const until = async (cond: () => boolean) => {
      for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setImmediate(r));
      expect(cond()).toBe(true);
    };

    it("finishes with the response status on the request's connection", async () => {
      const { eg, events } = setup();
      eg.connections.opened("k1");
      await onConn(eg, "k1", async () => {
        const req = new Request("https://api.example.com/a");
        await eg.httpHooks.onRequest!(req);
        expect(eg.activity().inflight).toBe(1);
        respond(eg, "k1", 201);
      });
      expect(finished(events)).toEqual([]); // finished only when the connection ends
      eg.connections.closed("k1");
      expect(finished(events)).toEqual([[1, 201]]);
      expect(eg.activity().inflight).toBe(0);
    });

    it("finishes with status 0 when the guest closes first, and ignores the late response", async () => {
      const { eg, events } = setup();
      eg.connections.opened("k1");
      const req = new Request("https://api.example.com/slow");
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const handling = onConn(eg, "k1", async () => {
        await eg.httpHooks.onRequest!(req);
        await gate; // Gondolin keeps fetching after the guest left
        respond(eg, "k1", 200);
      });
      await until(() => eg.activity().inflight === 1);
      eg.connections.closed("k1");
      expect(finished(events)).toEqual([[1, 0]]);
      expect(eg.activity().inflight).toBe(0);

      // A new request for the same URL on another connection is not finished by the old response.
      eg.connections.opened("k2");
      await onConn(eg, "k2", async () => eg.httpHooks.onRequest!(new Request("https://api.example.com/slow")));
      release();
      await handling;
      expect(finished(events)).toEqual([[1, 0]]);
      expect(eg.activity().inflight).toBe(1);
    });

    it("keeps the late response in the closed connection's context", async () => {
      const { eg, events } = setup();
      eg.connections.opened("k1");
      const req = new Request("https://api.example.com/slow");
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const handling = onConn(eg, "k1", async () => {
        await eg.httpHooks.onRequest!(req);
        await gate; // upstream still fetching
        eg.onDebug("net", "http bridge response 200 OK");
        oldSink(Buffer.from("HTTP/1.1 200 OK\r\n\r\n"));
      });
      await until(() => eg.activity().inflight === 1);
      const oldSink = eg.connections.sink("k1");
      eg.connections.closed("k1");
      eg.connections.opened("k1"); // the key is reused by a new connection
      await onConn(eg, "k1", async () => eg.httpHooks.onRequest!(new Request("https://api.example.com/slow")));
      release();
      await handling;
      eg.connections.closed("k1");
      expect(finished(events)).toEqual([[1, 0], [2, 0]]);
    });

    it("finishes each redirect hop when the next one starts", async () => {
      const { eg, events } = setup();
      eg.connections.opened("k1");
      await onConn(eg, "k1", async () => {
        await eg.httpHooks.onRequest!(new Request("https://api.example.com/r1"));
        await eg.httpHooks.onRequest!(new Request("https://api.example.com/r2"));
        const last = new Request("https://api.example.com/final");
        await eg.httpHooks.onRequest!(last);
        respond(eg, "k1", 200);
      });
      eg.connections.closed("k1");
      expect(finished(events)).toEqual([[1, 0], [2, 0], [3, 200]]);
    });

    it("finishes with status 0 when the request fails without a response", async () => {
      const { eg, events } = setup();
      eg.connections.opened("k1");
      await onConn(eg, "k1", async () => {
        await eg.httpHooks.onRequest!(new Request("https://api.example.com/x"));
        // upstream connect or TLS failed: Gondolin answers 502 itself and closes.
        eg.connections.sink("k1")(Buffer.from("HTTP/1.1 502 Bad Gateway\r\n\r\n502 Bad Gateway\n"));
      });
      expect(finished(events)).toEqual([]);
      eg.connections.closed("k1");
      expect(finished(events)).toEqual([[1, 0]]);
    });

    it("ends a connection whose key is opened again without a close", async () => {
      const { eg, events } = setup();
      eg.connections.opened("k1");
      await onConn(eg, "k1", async () => eg.httpHooks.onRequest!(new Request("https://api.example.com/x")));
      eg.connections.opened("k1");
      expect(finished(events)).toEqual([[1, 0]]);
    });

    it("refuses further hops for a guest that already left", async () => {
      const { eg, events } = setup();
      eg.connections.opened("k1");
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const handling = onConn(eg, "k1", async () => {
        await eg.httpHooks.onRequest!(new Request("https://api.example.com/r1"));
        await gate; // the 3xx arrives after the guest left
        await eg.httpHooks.onRequest!(new Request("https://api.example.com/r2"));
      });
      await until(() => eg.activity().inflight === 1);
      eg.connections.closed("k1");
      release();
      await expect(handling).rejects.toThrow(/guest closed/);
      expect(events.after(0n).filter((e) => e.event.case === "httpStarted")).toHaveLength(1);
      expect(finished(events)).toEqual([[1, 0]]);
    });

    it("reads a status line split across writes and skips interim responses", async () => {
      const { eg, events } = setup();
      eg.connections.opened("k1");
      await onConn(eg, "k1", async () => {
        await eg.httpHooks.onRequest!(new Request("https://api.example.com/x"));
        eg.onDebug("net", "http bridge response 418 I'm a teapot");
      });
      const sink = eg.connections.sink("k1");
      sink(Buffer.from("HTTP/1.1 41"));
      sink(Buffer.from("8 I'm a teapot\r\n"));
      sink(Buffer.from("HTTP/1.1 500 later bytes are not a head\r\n"));
      eg.connections.closed("k1");
      expect(finished(events)).toEqual([[1, 418]]);
      expect(responseStatus(Buffer.from("HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 204 No Content\r\n"))).toBe(204);
      expect(responseStatus(Buffer.from("HTTP/1.1 100 Continue\r\n"))).toBeUndefined();
      expect(responseStatus(Buffer.from("garbage\r\n"))).toBe(0);
      expect(responseStatus(Buffer.alloc(70 * 1024, 0x41))).toBe(0);
    });

    it("leaves onResponse unset so that Gondolin streams responses", () => {
      expect(setup().eg.httpHooks.onResponse).toBeUndefined();
    });

    it("pairs by method and URL when the hooks run outside any connection", async () => {
      const { eg, events } = setup();
      eg.useResponseHook();
      const a = new Request("https://api.example.com/a");
      const b = new Request("https://api.example.com/b");
      await eg.httpHooks.onRequest!(a);
      await eg.httpHooks.onRequest!(b);
      await eg.httpHooks.onResponse!(ok(404), b);
      expect(finished(events)).toEqual([[2, 404]]);
      expect(eg.activity().inflight).toBe(1);
    });
  });
});
