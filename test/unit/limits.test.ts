import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";

import { ExecSlots } from "../../src/exec.js";
import { parseVmRss } from "../../src/metrics.js";

describe("ExecSlots", () => {
  it("refuses beyond the limit with ResourceExhausted and frees on release", () => {
    const slots = new ExecSlots(2);
    const a = slots.acquire();
    slots.acquire();
    let err: unknown;
    try {
      slots.acquire();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConnectError);
    expect((err as ConnectError).code).toBe(Code.ResourceExhausted);
    a();
    a(); // releasing twice does not free a second slot
    expect(slots.inUse).toBe(1);
    slots.acquire();
    expect(() => slots.acquire()).toThrow(/limit 2/);
  });
});

describe("parseVmRss", () => {
  it("reads VmRSS in kB", () => {
    expect(parseVmRss("Name:\tqemu\nVmRSS:\t  123456 kB\nThreads:\t4\n")).toBe(123456);
    expect(parseVmRss("Name:\tkthread\n")).toBeUndefined();
  });
});
