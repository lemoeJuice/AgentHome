import { connect, createServer, type Server, type Socket } from "node:net";
import { networkInterfaces } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

export type ProxyRelayOptions = { listenPort: number; upstreamHost?: string; upstreamPort: number; maxRetries?: number; retryDelayMs?: number; handshakeTimeoutMs?: number };

const HEADER_LIMIT = 64 * 1024;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 150;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 8_000;

export function createProxyRelay(options: ProxyRelayOptions): Server {
  const upstreamHost = options.upstreamHost ?? "127.0.0.1";
  const settings = {
    upstreamHost,
    upstreamPort: options.upstreamPort,
    maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
    retryDelayMs: options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
    handshakeTimeoutMs: options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
  };
  return createServer((client) => {
    if (!isLocalHostAddress(client.remoteAddress)) {
      client.destroy();
      return;
    }
    void relaySocket(client, settings).catch(() => client.destroy());
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

type RelaySettings = { upstreamHost: string; upstreamPort: number; maxRetries: number; retryDelayMs: number; handshakeTimeoutMs: number };

async function relaySocket(client: Socket, settings: RelaySettings): Promise<void> {
  const request = await readClientHeader(client);
  if (!request) return;
  const method = request.header.toString("latin1").split(/\s+/, 1)[0]?.toUpperCase();
  if (method !== "CONNECT") {
    const upstream = await connectWithRetries(settings);
    if (request.remainder.length) upstream.write(request.remainder);
    pipeBoth(client, upstream);
    return;
  }
  await relayConnectTunnel(client, request, settings);
}

async function relayConnectTunnel(client: Socket, request: HeaderResult, settings: RelaySettings): Promise<void> {
  let clientBytes = request.remainder;
  let clientHelloEnd: number | undefined;
  let currentUpstream: Socket | undefined;
  let bytesSent = 0;
  let tunnelEstablished = false;
  let connectResponseSent = false;
  let waitingForClientHello: (() => void) | undefined;

  const onClientData = (chunk: Buffer) => {
    clientBytes = Buffer.concat([clientBytes, chunk]);
    const parsedHelloEnd = completeClientHelloLength(clientBytes);
    if (parsedHelloEnd !== null) clientHelloEnd = parsedHelloEnd;
    if (waitingForClientHello && clientHelloEnd !== undefined) waitingForClientHello();
    if (currentUpstream && clientHelloEnd !== undefined && !tunnelEstablished) {
      const pending = clientBytes.subarray(bytesSent);
      if (pending.length) {
        currentUpstream.write(pending);
        bytesSent = clientBytes.length;
      }
    }
  };
  client.on("data", onClientData);
  client.on("error", () => currentUpstream?.destroy());

  try {
    for (let attempt = 0; attempt <= settings.maxRetries && !client.destroyed; attempt += 1) {
      if (attempt > 0) await delay(settings.retryDelayMs * attempt);
      let upstream: Socket;
      try {
        upstream = await connectUpstream(settings);
        currentUpstream = upstream;
        bytesSent = 0;
        upstream.write(request.header);
        const proxyResponse = await readProxyHeader(upstream, settings.handshakeTimeoutMs);
        const responseLine = proxyResponse.header.toString("latin1").split("\r\n", 1)[0] ?? "";
        const status = Number(responseLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})\b/i)?.[1]);
        if (!Number.isInteger(status)) throw new Error("PROXY_RELAY_INVALID_CONNECT_RESPONSE");

        if (status !== 200) {
          if (connectResponseSent) throw new Error("PROXY_RELAY_RECONNECT_REJECTED");
          if (!connectResponseSent) client.write(proxyResponse.header);
          if (proxyResponse.remainder.length) client.write(proxyResponse.remainder);
          pipeBoth(client, upstream);
          return;
        }
        if (!connectResponseSent) {
          client.write(proxyResponse.header);
          connectResponseSent = true;
        }
        if (proxyResponse.remainder.length) {
          client.write(proxyResponse.remainder);
          tunnelEstablished = true;
          pipeBoth(client, upstream);
          return;
        }

        if (clientHelloEnd === undefined) {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("PROXY_RELAY_CLIENT_HELLO_TIMEOUT")), settings.handshakeTimeoutMs);
            waitingForClientHello = () => { clearTimeout(timer); resolve(); };
          });
          waitingForClientHello = undefined;
        }
        if (client.destroyed) return;
        const helloBytes = clientBytes.subarray(bytesSent);
        if (helloBytes.length) {
          upstream.write(helloBytes);
          bytesSent = clientBytes.length;
        }

        const firstServerData = await waitForUpstreamData(upstream, settings.handshakeTimeoutMs);
        if (firstServerData.kind === "data") {
          tunnelEstablished = true;
          client.write(firstServerData.data);
          // Client bytes collected after ClientHello are already buffered. Only
          // tunnelEstablished lets subsequent bytes flow directly through pipe.
          const unsent = clientBytes.subarray(bytesSent);
          if (unsent.length) upstream.write(unsent);
          pipeBoth(client, upstream);
          return;
        }
        if (!canReplayClientHello(clientBytes, clientHelloEnd)) throw new Error("PROXY_RELAY_TLS_INTERRUPTED_AFTER_CLIENT_DATA");
        currentUpstream.destroy();
        currentUpstream = undefined;
      } catch (error) {
        currentUpstream?.destroy();
        currentUpstream = undefined;
        if (attempt >= settings.maxRetries || client.destroyed) throw error;
        // A CONNECT/TLS handshake has no application side effects. Retrying is
        // safe until an upstream TLS response is received, but only the exact
        // initial ClientHello may be replayed after the proxy accepted CONNECT.
        if (connectResponseSent && !canReplayClientHello(clientBytes, clientHelloEnd)) throw error;
        logRetry(attempt + 1, settings.maxRetries, error);
      }
    }
  } finally {
    client.off("data", onClientData);
    if (!client.destroyed && !tunnelEstablished) client.destroy();
    if (!tunnelEstablished) currentUpstream?.destroy();
  }
}

type HeaderResult = { header: Buffer; remainder: Buffer };

async function readClientHeader(socket: Socket): Promise<HeaderResult | undefined> {
  return readHeader(socket, HEADER_LIMIT);
}

async function readProxyHeader(socket: Socket, timeoutMs: number): Promise<HeaderResult> {
  const result = await readHeader(socket, HEADER_LIMIT, timeoutMs);
  if (!result) throw new Error("PROXY_RELAY_MISSING_RESPONSE");
  return result;
}

function readHeader(socket: Socket, maxBytes: number, timeoutMs?: number): Promise<HeaderResult | undefined> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => finish(new Error("PROXY_RELAY_HEADER_TIMEOUT")), timeoutMs);
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const boundary = buffer.indexOf("\r\n\r\n");
      if (boundary >= 0) {
        finish(undefined, { header: buffer.subarray(0, boundary + 4), remainder: buffer.subarray(boundary + 4) });
      } else if (buffer.length > maxBytes) finish(new Error("PROXY_RELAY_HEADER_TOO_LARGE"));
    };
    const onError = (error: Error) => finish(error);
    const onClose = () => finish(new Error("PROXY_RELAY_SOCKET_CLOSED"));
    const finish = (error?: Error, result?: HeaderResult) => {
      if (timer) clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
      if (error) reject(error);
      else resolve(result);
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

function connectWithRetries(settings: RelaySettings): Promise<Socket> {
  return retry(() => connectUpstream(settings), settings.maxRetries, settings.retryDelayMs);
}

function connectUpstream(settings: RelaySettings): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: settings.upstreamHost, port: settings.upstreamPort });
    const onError = (error: Error) => { socket.destroy(); reject(error); };
    socket.once("error", onError);
    socket.once("connect", () => {
      socket.off("error", onError);
      resolve(socket);
    });
  });
}

async function retry<T>(operation: () => Promise<T>, maxRetries: number, retryDelayMs: number): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (attempt > 0) await delay(retryDelayMs * attempt);
    try { return await operation(); }
    catch (error) { lastError = error; }
  }
  throw lastError;
}

function completeClientHelloLength(buffer: Buffer): number | undefined | null {
  if (buffer.length < 5) return null;
  if (buffer[0] !== 0x16) return undefined;
  const recordLength = buffer.readUInt16BE(3);
  if (recordLength < 4 || buffer.length < 5 + recordLength) return null;
  if (buffer[5] !== 0x01) return undefined;
  const helloLength = buffer.readUIntBE(6, 3);
  if (helloLength + 4 !== recordLength) return undefined;
  return 5 + recordLength;
}

function canReplayClientHello(buffer: Buffer, helloEnd: number | undefined): boolean {
  return buffer.length === 0 || (helloEnd !== undefined && buffer.length === helloEnd);
}

function logRetry(retryNumber: number, maxRetries: number, error: unknown): void {
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : error instanceof Error ? error.message : "UNKNOWN";
  process.stderr.write(`[proxy-relay] retry ${retryNumber}/${maxRetries} after ${code}\n`);
}

type UpstreamDataResult = { kind: "data"; data: Buffer } | { kind: "closed" };

function waitForUpstreamData(socket: Socket, timeoutMs: number): Promise<UpstreamDataResult> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish({ kind: "closed" }), timeoutMs);
    const onData = (data: Buffer) => finish({ kind: "data", data });
    const onClose = () => finish({ kind: "closed" });
    const onError = () => finish({ kind: "closed" });
    const finish = (result: UpstreamDataResult) => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("close", onClose);
      socket.off("error", onError);
      resolve(result);
    };
    socket.once("data", onData);
    socket.once("close", onClose);
    socket.once("error", onError);
  });
}

function pipeBoth(client: Socket, upstream: Socket): void {
  client.on("error", () => upstream.destroy());
  upstream.on("error", () => client.destroy());
  client.on("close", () => upstream.destroy());
  upstream.on("close", () => client.destroy());
  client.pipe(upstream).pipe(client);
}
