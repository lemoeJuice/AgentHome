import test from "node:test";
import assert from "node:assert/strict";
import { buildGuestEgressRules } from "../src/runtime/guest-network.ts";

test("Guest egress permits only the configured host proxy before blocking private networks", () => {
  const rules = buildGuestEgressRules(20_000, 60_000, "nameserver 10.0.2.3\n", "http://host.containers.internal:17890");
  const proxyRule = "meta skuid 20000-60000 ip daddr 169.254.1.2 tcp dport 17890 accept";
  assert.ok(rules.includes(proxyRule));
  assert.ok(rules.indexOf(proxyRule) < rules.indexOf("ip daddr { 0.0.0.0/8"));
  const noProxyRules = buildGuestEgressRules(20_000, 60_000, "nameserver 10.0.2.3\n");
  assert.equal(noProxyRules.includes(proxyRule), false);
});
