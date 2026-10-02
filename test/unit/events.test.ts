import { describe, expect, it } from "vitest";

import { EventQueue } from "../../src/events.js";

const denied = (host: string) => ({ case: "httpDenied" as const, value: { host, reason: "host-not-allowed" } });

async function collect(q: EventQueue, afterSeq: bigint, signal: AbortSignal): Promise<bigint[]> {
  const seqs: bigint[] = [];
  for await (const ev of q.watch(afterSeq, signal)) seqs.push(ev.seq);
  return seqs;
}

describe("EventQueue.watch", () => {
  it("replays from after_seq (0 = everything buffered), then delivers live until closed", async () => {
    const q = new EventQueue();
    q.push(denied("a"));
    q.push(denied("b"));
    const ac = new AbortController();
    const all = collect(q, 0n, ac.signal);
    const tail = collect(q, 1n, ac.signal);
    await new Promise((r) => setTimeout(r, 0));
    q.push(denied("c"));
    q.close();
    expect(await all).toEqual([1n, 2n, 3n]);
    expect(await tail).toEqual([2n, 3n]);
  });

  it("ends the stream when the signal aborts", async () => {
    const q = new EventQueue();
    const ac = new AbortController();
    const p = collect(q, 0n, ac.signal);
    q.push(denied("a"));
    await new Promise((r) => setTimeout(r, 0));
    ac.abort();
    expect(await p).toEqual([1n]);
  });

  it("ends immediately after the replay on a closed queue", async () => {
    const q = new EventQueue();
    q.push(denied("a"));
    q.close();
    expect(await collect(q, 0n, new AbortController().signal)).toEqual([1n]);
  });
});
