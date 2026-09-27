import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

export function installGuestEgressFilter(uidMin: number, uidMax: number, resolverConfig = "/etc/resolv.conf"): void {
  if (process.getuid?.() !== 0) throw new Error("GUEST_EGRESS_FILTER_REQUIRES_SYSTEM_ROOT");
  const resolvers = parseResolvers(readFileSync(resolverConfig, "utf8"));
  if (resolvers.ipv4.length === 0 && resolvers.ipv6.length === 0) throw new Error("GUEST_EGRESS_DNS_RESOLVER_REQUIRED");
  const range = `${uidMin}-${uidMax}`;
  const rules = [
    "table inet agent_home_guest {",
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
    `    meta skuid ${range} ip daddr { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16, 224.0.0.0/4, 240.0.0.0/4 } reject`,
    `    meta skuid ${range} ip6 daddr { ::/128, ::1, ::ffff:0:0/96, 64:ff9b::/96, fc00::/7, fe80::/10, ff00::/8 } reject`,
    "  }",
    "}",
    "",
  ].join("\n");

  const nft = process.env.AGENT_HOME_NFT_COMMAND ?? "nft";
  const remove = spawnSync(nft, ["delete", "table", "inet", "agent_home_guest"], { encoding: "utf8" });
  if (remove.error && (remove.error as NodeJS.ErrnoException).code !== "ENOENT") throw remove.error;
  const result = spawnSync(nft, ["-f", "-"], { input: rules, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`GUEST_EGRESS_FILTER_INSTALL_FAILED:${(result.stderr || result.stdout).trim()}`);
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
