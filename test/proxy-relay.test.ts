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

test("proxy relay transparently forwards an HTTP CONNECT tunnel", async () => {
  const upstream = createServer((socket) => {
    socket.once("data", (request) => {
      assert.match(request.toString(), /^CONNECT example\.com:443 HTTP\/1\.1\r\n/);
      socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
      socket.pipe(socket);
    });
  });
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
  assert.match(response.toString(), /^HTTP\/1\.1 200 Connection established\r\n/);
  const hello = Buffer.from([0x16, 0x03, 0x01, 0x00, 0x04, 0x01, 0x00, 0x00, 0x00]);
  const echoed = once(client, "data");
  client.write(hello);
  assert.deepEqual((await echoed)[0], hello);
  client.destroy();
  await Promise.all([new Promise<void>((resolve) => relay.close(() => resolve())), new Promise<void>((resolve) => upstream.close(() => resolve()))]);
});

test("proxy relay reconnects and safely replays only a ClientHello after an early TLS reset", async () => {
  let upstreamConnections = 0;
  const upstream = createServer((socket) => {
    upstreamConnections += 1;
    let proxyHeader = false;
    socket.on("data", (chunk) => {
      if (!proxyHeader) {
        proxyHeader = true;
        assert.match(chunk.toString(), /^CONNECT example\.com:443 HTTP\/1\.1\r\n/);
        socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
        return;
      }
      if (upstreamConnections === 1) {
        socket.destroy();
        return;
      }
      socket.write(Buffer.from([0x16, 0x03, 0x03, 0x00, 0x01, 0x02]));
    });
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const upstreamPort = (upstream.address() as import("node:net").AddressInfo).port;
  const relay = createProxyRelay({ listenPort: 0, upstreamPort, retryDelayMs: 5, handshakeTimeoutMs: 1000 });
  await once(relay, "listening");
  const relayPort = (relay.address() as import("node:net").AddressInfo).port;
  const client = connect(relayPort, "127.0.0.1");
  await once(client, "connect");
  client.write("CONNECT example.com:443 HTTP/1.1\r\n\r\n");
  const [connectResponse] = await once(client, "data");
  assert.match(connectResponse.toString(), /^HTTP\/1\.1 200 Connection established\r\n/);
  const serverHello = once(client, "data");
  client.write(Buffer.from([0x16, 0x03, 0x01, 0x00, 0x04, 0x01, 0x00, 0x00, 0x00]));
  assert.deepEqual((await serverHello)[0], Buffer.from([0x16, 0x03, 0x03, 0x00, 0x01, 0x02]));
  assert.equal(upstreamConnections, 2);
  client.destroy();
  await Promise.all([new Promise<void>((resolve) => relay.close(() => resolve())), new Promise<void>((resolve) => upstream.close(() => resolve()))]);
});

test("proxy relay does not replay a TLS stream after client data extends beyond ClientHello", async () => {
  let upstreamConnections = 0;
  const upstream = createServer((socket) => {
    upstreamConnections += 1;
    let proxyHeader = false;
    socket.on("data", (chunk) => {
      if (!proxyHeader) {
        proxyHeader = true;
        socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
      } else socket.destroy();
      void chunk;
    });
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const upstreamPort = (upstream.address() as import("node:net").AddressInfo).port;
  const relay = createProxyRelay({ listenPort: 0, upstreamPort, retryDelayMs: 5, handshakeTimeoutMs: 1000 });
  await once(relay, "listening");
  const relayPort = (relay.address() as import("node:net").AddressInfo).port;
  const client = connect(relayPort, "127.0.0.1");
  await once(client, "connect");
  client.write("CONNECT example.com:443 HTTP/1.1\r\n\r\n");
  await once(client, "data");
  const closed = once(client, "close");
  client.write(Buffer.from([0x16, 0x03, 0x01, 0x00, 0x04, 0x01, 0x00, 0x00, 0x00, 0x17, 0x03, 0x03, 0x00, 0x01, 0x00]));
  await closed;
  assert.equal(upstreamConnections, 1);
  await Promise.all([new Promise<void>((resolve) => relay.close(() => resolve())), new Promise<void>((resolve) => upstream.close(() => resolve()))]);
});
