import { connect, createServer, type Server, type Socket } from "node:net";
import { networkInterfaces } from "node:os";

export type ProxyRelayOptions = { listenPort: number; upstreamHost?: string; upstreamPort: number };

export function createProxyRelay(options: ProxyRelayOptions): Server {
  const upstreamHost = options.upstreamHost ?? "127.0.0.1";
  return createServer((client) => {
    if (!isLocalHostAddress(client.remoteAddress)) {
      client.destroy();
      return;
    }
    relaySocket(client, upstreamHost, options.upstreamPort);
  }).listen(options.listenPort, "0.0.0.0");
}

export function isLocalHostAddress(remoteAddress: string | undefined, interfaces = networkInterfaces()): boolean {
  if (!remoteAddress) return false;
  const address = normalizeAddress(remoteAddress);
  if (address === "127.0.0.1" || address === "::1") return true;
  return Object.values(interfaces).flatMap((entries) => entries ?? []).some((entry) => normalizeAddress(entry.address) === address);
}

function normalizeAddress(address: string): string {
  return address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
}

function relaySocket(client: Socket, upstreamHost: string, upstreamPort: number): void {
  const upstream = connect({ host: upstreamHost, port: upstreamPort });
  const closeBoth = () => { client.destroy(); upstream.destroy(); };
  client.on("error", closeBoth);
  upstream.on("error", closeBoth);
  client.on("close", () => upstream.destroy());
  upstream.on("close", () => client.destroy());
  client.pipe(upstream).pipe(client);
}
