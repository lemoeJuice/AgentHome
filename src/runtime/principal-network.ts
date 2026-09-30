import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

export function installPrincipalEgressFilter(uidMin: number, uidMax: number, resolverConfig = "/etc/resolv.conf", proxyUrl?: string, additionalUids: number[] = []): void {
  if (process.getuid?.() !== 0) throw new Error("PRINCIPAL_EGRESS_FILTER_REQUIRES_SYSTEM_ROOT");
  const rules = buildPrincipalEgressRules(uidMin, uidMax, readFileSync(resolverConfig, "utf8"), proxyUrl, additionalUids);
  const nft = process.env.AGENT_HOME_NFT_COMMAND ?? "nft";
  const remove = spawnSync(nft, ["delete", "table", "inet", "agent_home_principal"], { encoding: "utf8" });
  if (remove.error && (remove.error as NodeJS.ErrnoException).code !== "ENOENT") throw remove.error;
  const result = spawnSync(nft, ["-f", "-"], { input: rules, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`PRINCIPAL_EGRESS_FILTER_INSTALL_FAILED:${(result.stderr || result.stdout).trim()}`);
}

export function buildPrincipalEgressRules(uidMin: number, uidMax: number, resolverConfiguration: string, proxyUrl?: string, additionalUids: number[] = []): string {
  const resolvers = parseResolvers(resolverConfiguration);
  if (resolvers.ipv4.length === 0 && resolvers.ipv6.length === 0) throw new Error("PRINCIPAL_EGRESS_DNS_RESOLVER_REQUIRED");
  if (!Number.isSafeInteger(uidMin) || !Number.isSafeInteger(uidMax) || uidMin < 1 || uidMax < uidMin) throw new Error("PRINCIPAL_EGRESS_UID_RANGE_INVALID");
  const extra = [...new Set(additionalUids)].filter((uid) => {
    if (!Number.isSafeInteger(uid) || uid < 1) throw new Error("PRINCIPAL_EGRESS_UID_RANGE_INVALID");
    return uid < uidMin || uid > uidMax;
  });
  const range = extra.length ? `{ ${[...extra, `${uidMin}-${uidMax}`].join(", ")} }` : `${uidMin}-${uidMax}`;
  return [
    "table inet agent_home_principal {",
    "  chain output {",
    "    type filter hook output priority filter; policy accept;",
    ...resolvers.ipv4.flatMap((resolver) => [
      `    meta skuid ${range} ip daddr ${resolver} udp dport 53 accept`,
      `    meta skuid ${range} ip daddr ${resolver} tcp dport 53 accept`,
    ]),
    ...resolvers.ipv6.flatMap((resolver) => [
      `    meta skuid ${range} ip6 daddr ${resolver} udp dport 53 accept`,
      `    meta skuid ${range} ip6 daddr ${resolver} tcp dport 53 accept`,
    ]),
    ...principalProxyEgressRules(range, proxyUrl),
    `    meta skuid ${range} ip daddr { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16, 224.0.0.0/4, 240.0.0.0/4 } reject`,
    `    meta skuid ${range} ip6 daddr { ::/128, ::1, ::ffff:0:0/96, 64:ff9b::/96, fc00::/7, fe80::/10, ff00::/8 } reject`,
    "  }",
    "}",
    "",
  ].join("\n");
}

function principalProxyEgressRules(uidRange: string, proxyUrl?: string): string[] {
  if (!proxyUrl) return [];
  let proxy: URL;
  try { proxy = new URL(proxyUrl); }
  catch { throw new Error("PRINCIPAL_EGRESS_PROXY_URL_INVALID"); }
  if (proxy.hostname.toLowerCase() !== "host.containers.internal") return [];
  const port = proxy.port || (proxy.protocol === "https:" ? "443" : "80");
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error("PRINCIPAL_EGRESS_PROXY_PORT_INVALID");
  return [`    meta skuid ${uidRange} ip daddr 169.254.1.2 tcp dport ${port} accept`];
}

function parseResolvers(content: string): { ipv4: string[]; ipv6: string[] } {
  const ipv4 = new Set<string>();
  const ipv6 = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    const match = /^\s*nameserver\s+([^\s#]+)/.exec(line);
    if (!match?.[1]) continue;
    const value = match[1].replace(/^\[|\]$/g, "");
    if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)) ipv4.add(value);
    else if (value.includes(":")) ipv6.add(value);
  }
  return { ipv4: [...ipv4], ipv6: [...ipv6] };
}
