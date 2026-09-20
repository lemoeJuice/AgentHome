import { createConnection } from "node:net";
import { createInterface } from "node:readline";

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
    socket.once("connect", () => socket.write(`${JSON.stringify({ type: "hello", protocolVersion: 1 })}\n`));
    lines.once("line", (line) => { process.stdout.write(`${line}\n`); socket.end(); resolve(); });
    socket.once("error", reject);
  });
}
