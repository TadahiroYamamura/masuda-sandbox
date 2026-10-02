// Connection helper for the contract tests. Implemented as part of S1: must
// return a Connect client for SandboxService reachable over the given Unix
// socket with HTTP/2 (h2c). Keep it tiny; the tests own the assertions.
import type { Client as ConnectClient } from "@connectrpc/connect";
import type { SandboxService } from "../../src/gen/masuda/sandbox/v1/sandbox_pb.js";

export type Client = ConnectClient<typeof SandboxService>;

export async function connect(_socketPath: string): Promise<Client> {
  throw new Error("test/contract/client.ts: implement in S1 (h2c over Unix socket)");
}
