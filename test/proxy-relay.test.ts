import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { connect, createServer } from "node:net";
import { createProxyRelay, isLocalHostAddress } from "../src/proxy-relay.ts";

test("proxy relay accepts loopback and local-interface clients, not remote LAN addresses", () => {
  const interfaces = { eth0: [{ address: "192.168.31.236" }] } as NodeJS.Dict<import("node:os").NetworkInterfaceInfo[]>;
  assert.equal(isLocalHostAddress("192.168.31.236", interfaces), true);
  assert.equal(isLocalHostAddress("::ffff:192.168.31.236", interfaces), true);
  assert.equal(isLocalHostAddress("127.0.0.1", interfaces), true);
  assert.equal(isLocalHostAddress("192.168.31.9", interfaces), false);
});

test("proxy relay transparently forwards TCP bytes to the local upstream", async () => {
  const upstream = createServer((socket) => socket.pipe(socket));
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const upstreamPort = (upstream.address() as import("node:net").AddressInfo).port;
  const relay = createProxyRelay({ listenPort: 0, upstreamPort });
  await once(relay, "listening");
  const relayPort = (relay.address() as import("node:net").AddressInfo).port;
  const client = connect(relayPort, "127.0.0.1");
  await once(client, "connect");
  client.write("CONNECT example.com:443 HTTP/1.1\r\n\r\n");
  const [response] = await once(client, "data");
  assert.equal(response.toString(), "CONNECT example.com:443 HTTP/1.1\r\n\r\n");
  client.destroy();
  await Promise.all([new Promise<void>((resolve) => relay.close(() => resolve())), new Promise<void>((resolve) => upstream.close(() => resolve()))]);
});
