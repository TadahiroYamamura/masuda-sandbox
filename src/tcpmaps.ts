import { Code, ConnectError } from "@connectrpc/connect";
import net from "node:net";

import type { TcpMapRecord } from "./sandboxes.js";

const HOST_NAME = /^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/;

const loopback = new net.BlockList();
loopback.addSubnet("127.0.0.0", 8, "ipv4");
loopback.addAddress("::1", "ipv6");

function invalid(msg: string): ConnectError {
  return new ConnectError(msg, Code.InvalidArgument);
}

function parseUpstream(raw: string): { host: string; port: number } {
  const m = /^(?:\[([^\]]+)\]|([^:\[\]]+)):([0-9]+)$/.exec(raw.trim());
  const port = m ? Number(m[3]) : 0;
  if (!m || port < 1 || port > 65535) throw invalid(`tcp_maps upstream must be host:port: ${JSON.stringify(raw)}`);
  return { host: (m[1] ?? m[2]!).toLowerCase(), port };
}

function isLoopback(host: string): boolean {
  if (host === "localhost") return true;
  const family = net.isIP(host);
  if (family === 4) return loopback.check(host, "ipv4");
  if (family === 6) return loopback.check(host, "ipv6");
  return false;
}

// tcp.hosts flows bypass the HTTP policy layer entirely, so the upstream is
// confined to the host's loopback: tcp_maps exist to reach host-local services
// (masuda's MCP endpoint), and an arbitrary upstream would be an egress hole
// that SetPolicy could not close.
export function validateTcpMaps(maps: TcpMapRecord[]): TcpMapRecord[] {
  const seen = new Set<string>();
  return maps.map((m) => {
    const host = m.host.trim().toLowerCase().replace(/\.+$/, "");
    if (!HOST_NAME.test(host) || net.isIP(host)) throw invalid(`tcp_maps host must be a host name: ${JSON.stringify(m.host)}`);
    if (!Number.isInteger(m.port) || m.port < 0 || m.port > 65535) throw invalid(`tcp_maps port out of range: ${m.port}`);
    const up = parseUpstream(m.upstream);
    if (!isLoopback(up.host)) throw invalid(`tcp_maps upstream must be a loopback address: ${JSON.stringify(m.upstream)}`);
    const key = m.port ? `${host}:${m.port}` : host;
    if (seen.has(key)) throw invalid(`duplicate tcp_maps entry for ${key}`);
    seen.add(key);
    const upstream = net.isIP(up.host) === 6 ? `[${up.host}]:${up.port}` : `${up.host}:${up.port}`;
    return { host, port: m.port, upstream };
  });
}

// Gondolin's tcp.hosts: "host" (all ports) or "host:port" -> "upstream".
export function toTcpHosts(maps: TcpMapRecord[]): Record<string, string> {
  return Object.fromEntries(maps.map((m) => [m.port ? `${m.host}:${m.port}` : m.host, m.upstream]));
}
