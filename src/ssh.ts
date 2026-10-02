import { Code, ConnectError } from "@connectrpc/connect";
import type { SshAccess } from "@earendil-works/gondolin";
import fs from "node:fs/promises";

import type { GuestVm } from "./vm.js";

export interface SshInfo {
  host: string;
  port: number;
  user: string;
  privateKeyPem: Uint8Array;
  sshArgv: string[];
}

// Checks the user exists and, when asked, stops the guest sshd that Gondolin
// started for a different user. Gondolin starts sshd with AllowUsers=<user>;
// when one is already listening the new one fails to bind and the old
// AllowUsers stays in force, so switching users needs the old one gone.
// The guest's PID 1 (sandboxd) does not reap it, so a zombie counts as gone.
const PREPARE_SSHD = `set -u
id -u -- "$1" >/dev/null 2>&1 || exit 3
[ "$2" = stop ] && [ -f /run/sshd.pid ] || exit 0
pid=$(cat /run/sshd.pid)
kill "$pid" 2>/dev/null || exit 0
i=0
while [ -r "/proc/$pid/stat" ] && [ "$(sed 's/.*) //' "/proc/$pid/stat" | cut -d' ' -f1)" != Z ]; do
  i=$((i + 1)); [ "$i" -gt 100 ] && exit 4
  sleep 0.05
done
rm -f /run/sshd.pid`;

// One SSH access per sandbox. Gondolin keeps a single access per VM (a second
// enableSsh returns the first one unchanged, whatever the user), so a new
// EnableSsh, for the same user or another, replaces the previous access; that
// is also what rotates the key. Calls are serialized because each one closes
// what the previous one opened.
export class GuestSsh {
  private chain: Promise<unknown> = Promise.resolve();
  private access?: SshAccess;
  // The user the guest sshd currently admits; it outlives a closed access.
  private sshdUser?: string;
  private closed = false;

  constructor(private readonly vm: GuestVm) {}

  enable(user: string): Promise<SshInfo> {
    return this.serial(async () => {
      if (this.closed) throw new ConnectError("sandbox is being destroyed", Code.FailedPrecondition);
      await this.closeAccess();
      const stop = this.sshdUser !== undefined && this.sshdUser !== user;
      const check = await this.vm.exec(["/bin/sh", "-c", PREPARE_SSHD, "masuda-ssh", user, stop ? "stop" : "keep"]);
      if (check.exitCode === 3) throw new ConnectError(`guest user ${JSON.stringify(user)} does not exist`, Code.InvalidArgument);
      if (check.exitCode !== 0) throw new ConnectError(`stopping the previous guest sshd failed (exit ${check.exitCode}): ${check.stderr.trim()}`, Code.Internal);
      if (stop) this.sshdUser = undefined;
      let access: SshAccess;
      try {
        access = await this.vm.enableSsh({ user, listenHost: "127.0.0.1", listenPort: 0 });
      } catch (e) {
        throw new ConnectError(`enable ssh: ${(e as Error).message}`, Code.Internal);
      }
      this.sshdUser = user;
      if (this.closed) {
        await access.close().catch(() => {});
        throw new ConnectError("sandbox was destroyed while enabling ssh", Code.Aborted);
      }
      this.access = access;
      const privateKeyPem = await fs.readFile(access.identityFile);
      return {
        host: access.host,
        port: access.port,
        user: access.user,
        privateKeyPem,
        sshArgv: [
          "ssh", "-p", String(access.port), "-i", access.identityFile,
          "-o", "ForwardAgent=no", "-o", "ClearAllForwardings=yes", "-o", "IdentitiesOnly=yes",
          "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
          `${access.user}@${access.host}`,
        ],
      };
    });
  }

  // Closing an access stops new connections; sessions already established
  // through the forwarder keep running.
  disable(user: string): Promise<void> {
    return this.serial(async () => {
      if (this.access?.user === user) await this.closeAccess();
    });
  }

  close(): Promise<void> {
    this.closed = true;
    return this.serial(() => this.closeAccess());
  }

  private async closeAccess(): Promise<void> {
    const a = this.access;
    this.access = undefined;
    await a?.close();
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const op = this.chain.then(fn);
    this.chain = op.catch(() => {});
    return op;
  }
}
