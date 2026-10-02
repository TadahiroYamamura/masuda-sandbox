import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { timestampNow } from "@bufbuild/protobuf/wkt";

import { SandboxEventSchema, type SandboxEvent } from "./gen/masuda/sandbox/v1/sandbox_pb.js";

export type SandboxEventBody = NonNullable<MessageInitShape<typeof SandboxEventSchema>["event"]>;

const CAPACITY = 1000;

// Per-sandbox event log. Only the most recent CAPACITY events are kept so that
// a sandbox nobody watches cannot grow without bound; delivery (WatchEvents)
// reads from here.
export class EventQueue {
  private seq = 0n;
  private readonly buf: SandboxEvent[] = [];

  push(event: SandboxEventBody): SandboxEvent {
    this.seq += 1n;
    const ev = create(SandboxEventSchema, { seq: this.seq, time: timestampNow(), event });
    this.buf.push(ev);
    if (this.buf.length > CAPACITY) this.buf.shift();
    return ev;
  }

  after(seq: bigint): SandboxEvent[] {
    return this.buf.filter((e) => e.seq > seq);
  }
}
