import { createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Logger } from "../shared/logger.js";
import type { ArtifactRef } from "../shared/types.js";
import { ArtifactService, type ArtifactCapability } from "./artifacts.js";

type TransferClaims = { artifactId: string; taskId: string; destination: string; expiresAt: number };

export class ArtifactTransferServer {
  private readonly artifacts: ArtifactService;
  private readonly baseUrl: string;
  private readonly secret: Buffer;
  private readonly port: number;
  private readonly host: string;
  private readonly logger: Logger;
  private server: Server | undefined;

  constructor(artifacts: ArtifactService, options: { baseUrl: string; secret: string; port?: number; host?: string }, logger: Logger) {
    if (!options.secret) throw new Error("ARTIFACT_TRANSFER_SECRET_REQUIRED");
    this.artifacts = artifacts;
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.secret = Buffer.from(options.secret, "utf8");
    this.port = options.port ?? 8790;
    this.host = options.host ?? "0.0.0.0";
    this.logger = logger.child("artifact-transfer");
  }

  async start(): Promise<void> {
    this.server = createServer((request, response) => { void this.handle(request, response); });
    await new Promise<void>((resolve, reject) => { this.server?.once("error", reject); this.server?.listen(this.port, this.host, resolve); });
    this.logger.info("Artifact transfer ready", { host: this.host, port: this.getPort() });
  }

  async stop(): Promise<void> { await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve()); this.server = undefined; }

  getPort(): number | undefined {
    const address = this.server?.address();
    return address && typeof address === "object" ? address.port : undefined;
  }

  issueUrl(ref: ArtifactRef, input: { taskId: string; destination: string; capability: ArtifactCapability; ttlMs?: number }): string {
    this.artifacts.authorizeOutbound(ref, input);
    const claims: TransferClaims = { artifactId: ref.artifactId, taskId: input.taskId, destination: input.destination, expiresAt: Date.now() + Math.min(Math.max(input.ttlMs ?? 5 * 60 * 1000, 1000), 10 * 60 * 1000) };
    const encoded = this.encode(claims);
    return `${this.baseUrl}/artifact/${encodeURIComponent(ref.artifactId)}?token=${encodeURIComponent(encoded)}`;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "GET") { response.statusCode = 405; response.end(); return; }
    const url = new URL(request.url ?? "/", "http://artifact-transfer.local");
    const prefix = "/artifact/";
    if (!url.pathname.startsWith(prefix)) { response.statusCode = 404; response.end(); return; }
    const artifactId = decodeURIComponent(url.pathname.slice(prefix.length));
    const claims = this.decode(url.searchParams.get("token") ?? "");
    if (!claims || claims.artifactId !== artifactId || claims.expiresAt <= Date.now()) { response.statusCode = 403; response.end("ARTIFACT_TRANSFER_DENIED"); return; }
    try {
      const artifact = this.artifacts.authorizeTransfer({ authority: "agent-home", artifactId }, { taskId: claims.taskId, destination: claims.destination });
      if (await realpath(artifact.path) !== artifact.path) throw new Error("ARTIFACT_PATH_CHANGED");
      await access(artifact.path);
      response.statusCode = 200;
      response.setHeader("content-type", artifact.mime ?? "application/octet-stream");
      response.setHeader("content-length", String(artifact.size));
      response.setHeader("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(artifact.filename)}`);
      createReadStream(artifact.path).on("error", (error) => { this.logger.warn("Artifact transfer stream failed", { artifactId, error: String(error) }); response.destroy(error); }).pipe(response);
    } catch (error) {
      if (!response.headersSent) { response.statusCode = 404; response.end(String(error)); }
    }
  }

  private encode(claims: TransferClaims): string {
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const signature = createHmac("sha256", this.secret).update(payload).digest("base64url");
    return `${payload}.${signature}`;
  }

  private decode(value: string): TransferClaims | undefined {
    const [payload, signature] = value.split(".");
    if (!payload || !signature) return undefined;
    const expected = createHmac("sha256", this.secret).update(payload).digest();
    const presented = Buffer.from(signature, "base64url");
    if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) return undefined;
    try {
      const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as TransferClaims;
       if (typeof claims.artifactId !== "string" || typeof claims.taskId !== "string" || typeof claims.destination !== "string" || !Number.isSafeInteger(claims.expiresAt)) return undefined;
      return claims;
    } catch { return undefined; }
  }
}
