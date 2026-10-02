import type { Sandbox } from "./gen/masuda/sandbox/v1/sandbox_pb.js";

export interface SandboxEntry {
  snapshot(): Sandbox;
  destroy(): Promise<void>;
}

export class SandboxRegistry {
  private readonly entries = new Map<string, SandboxEntry>();

  list(): Sandbox[] {
    return [...this.entries.values()].map((e) => e.snapshot());
  }

  get(id: string): Sandbox | undefined {
    return this.entries.get(id)?.snapshot();
  }

  // Failures are collected rather than thrown on the first one so that a
  // single stuck VM does not leave the rest running at shutdown.
  async destroyAll(): Promise<{ id: string; error: unknown }[]> {
    const ids = [...this.entries.keys()];
    const results = await Promise.allSettled(ids.map((id) => this.entries.get(id)!.destroy()));
    this.entries.clear();
    return results.flatMap((r, i) => (r.status === "rejected" ? [{ id: ids[i]!, error: r.reason }] : []));
  }
}
