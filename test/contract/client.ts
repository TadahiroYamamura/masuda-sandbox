// Connection helper for the contract tests. Implemented as part of S1: must
// return a Connect client for SandboxService reachable over the given Unix
// socket with HTTP/2 (h2c). Keep it tiny; the tests own the assertions.
import net from "node:net";
import { createClient, type Client as ConnectClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { SandboxService } from "../../src/gen/masuda/sandbox/v1/sandbox_pb.js";

export type Client = ConnectClient<typeof SandboxService>;

export async function connect(socketPath: string): Promise<Client> {
  // The host part of baseUrl is only the :authority header; the bytes go to the socket.
  const transport = createConnectTransport({
    baseUrl: "http://localhost",
    httpVersion: "2",
    nodeOptions: { createConnection: () => net.connect(socketPath) },
  });
  return createClient(SandboxService, transport);
}
