import { Code, ConnectError, type ServiceImpl } from "@connectrpc/connect";
import { create } from "@bufbuild/protobuf";

import { ListSandboxesResponseSchema, SandboxService } from "./gen/masuda/sandbox/v1/sandbox_pb.js";
import type { SandboxRegistry } from "./registry.js";

// Methods left out of the returned object are answered with Unimplemented by
// the Connect router.
export function sandboxServiceImpl(registry: SandboxRegistry): Partial<ServiceImpl<typeof SandboxService>> {
  return {
    listSandboxes() {
      return create(ListSandboxesResponseSchema, { sandboxes: registry.list() });
    },
    getSandbox(req) {
      const sb = registry.get(req.id);
      if (!sb) throw new ConnectError(`sandbox ${JSON.stringify(req.id)} not found`, Code.NotFound);
      return sb;
    },
  };
}
