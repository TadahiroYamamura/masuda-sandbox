import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { timestampNow } from "@bufbuild/protobuf/wkt";

import { SandboxEventSchema, type SandboxEvent } from "./gen/masuda/sandbox/v1/sandbox_pb.js";

export type SandboxEventBody = NonNullable<MessageInitShape<typeof SandboxEventSchema>["event"]>;

const CAPACITY = 1000;

type Listener = (ev: SandboxEvent | null) => void;

// Per-sandbox event log. Only the most recent CAPACITY events are kept so that
// a sandbox nobody watches cannot grow without bound; delivery (WatchEvents)
// reads from here. close() marks the end of the sandbox's life: watchers drain
// what is left and their streams end.
export class EventQueue {
  private seq = 0n;
  private readonly buf: SandboxEvent[] = [];
  private readonly listeners = new Set<Listener>();
  private closed = false;

  push(event: SandboxEventBody): SandboxEvent {
    this.seq += 1n;
    const ev = create(SandboxEventSchema, { seq: this.seq, time: timestampNow(), event });
    this.buf.push(ev);
    if (this.buf.length > CAPACITY) this.buf.shift();
    for (const l of this.listeners) l(ev);
    return ev;
  }

  after(seq: bigint): SandboxEvent[] {
    return this.buf.filter((e) => e.seq > seq);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const l of this.listeners) l(null);
    this.listeners.clear();
  }

  // after_seq = 0 replays everything still buffered rather than "only new
  // events": a watcher attaching right after CreateSandbox would otherwise
  // miss what happened in between, and the ring buffer bounds the replay.
  //
  // The listener is registered before the replay is read so that an event
  // pushed in between is neither lost nor (thanks to the seq check) doubled.
  async *watch(afterSeq: bigint, signal: AbortSignal): AsyncGenerator<SandboxEvent> {
    const pending: SandboxEvent[] = [];
    let ended = this.closed;
    let wake: (() => void) | undefined;
    const listener: Listener = (ev) => {
      if (ev) pending.push(ev);
      else ended = true;
      wake?.();
    };
    const onAbort = () => wake?.();
    if (!ended) this.listeners.add(listener);
    signal.addEventListener("abort", onAbort);
    try {
      let last = afterSeq;
      for (const ev of this.after(afterSeq)) {
        if (signal.aborted) return;
        last = ev.seq;
        yield ev;
      }
      for (;;) {
        while (pending.length > 0) {
          const ev = pending.shift()!;
          if (ev.seq <= last) continue;
          if (signal.aborted) return;
          last = ev.seq;
          yield ev;
        }
        if (ended || signal.aborted) return;
        await new Promise<void>((r) => (wake = r));
        wake = undefined;
      }
    } finally {
      this.listeners.delete(listener);
      signal.removeEventListener("abort", onAbort);
    }
  }
}
