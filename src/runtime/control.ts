import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function controlToken(): string | undefined {
  try { return readFileSync(join(process.env.AGENT_HOME_STATE ?? "/state", "secrets/control-token"), "utf8").trim() || undefined; } catch { return process.env.AGENT_HOME_CONTROL_TOKEN || undefined; }
}

export async function runControlStream(socketPath: string): Promise<void> {
  const socket = createConnection(socketPath);
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", reject);
  });
}

export async function runControlPing(socketPath: string): Promise<void> {
  const socket = createConnection(socketPath);
  const lines = createInterface({ input: socket });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => { const token = controlToken(); socket.write(`${JSON.stringify({ type: "hello", protocolVersion: 1, ...(token ? { controlToken: token } : {}) })}\n`); });
    lines.once("line", (line) => { process.stdout.write(`${line}\n`); socket.end(); resolve(); });
    socket.once("error", reject);
  });
}

export async function runControlRequest(socketPath: string, request: Record<string, unknown>): Promise<void> {
  const socket = createConnection(socketPath);
  const lines = createInterface({ input: socket });
  await new Promise<void>((resolve, reject) => {
    let authenticated = false;
    socket.once("connect", () => { const token = controlToken(); socket.write(`${JSON.stringify({ type: "hello", protocolVersion: 1, ...(token ? { controlToken: token } : {}) })}\n`); });
    lines.on("line", (line) => {
      process.stdout.write(`${line}\n`);
      if (!authenticated) {
        authenticated = true;
        const hello = JSON.parse(line) as { status?: string };
        if (hello.status !== "ready") { socket.end(); reject(new Error("CONTROL_AUTH_FAILED")); return; }
        socket.write(`${JSON.stringify(request)}\n`);
        return;
      }
      const response = JSON.parse(line) as { status?: string };
      socket.end();
      if (response.status === "failed") reject(new Error("CONTROL_REQUEST_FAILED")); else resolve();
    });
    socket.once("error", reject);
  });
}
