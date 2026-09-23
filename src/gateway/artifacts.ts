import { createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, copyFile, mkdir, readFile, realpath, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ArtifactRef } from "../shared/types.js";
import type { Logger } from "../shared/logger.js";
import { newId, nowIso } from "../shared/ids.js";
import type { SqliteStore } from "../db.js";

type GatewayArtifactRow = { id: string; canonical_path: string; filename: string; mime: string | null; size: number; conversation_id: string; requester_id: string; status: string; created_at: string; expires_at: string | null; retention_class: "temporary" | "task-lifetime" | "persistent"; owner_invocation_id: string | null; owner_plugin_id: string | null };
type TransferClaims = { artifactId: string; conversationId: string; expiresAt: number };

export class GatewayArtifactService {
  private readonly db: SqliteStore;
  private readonly root: string;
  private readonly transfer: GatewayArtifactTransferServer | undefined;

  constructor(db: SqliteStore, statePath: string, logger: Logger, options: { baseUrl?: string; secret?: string; port?: number; host?: string } = {}) {
    this.db = db;
    this.root = join(dirname(statePath), "gateway-artifacts");
    if (options.baseUrl && options.secret) this.transfer = new GatewayArtifactTransferServer(this, { baseUrl: options.baseUrl, secret: options.secret, port: options.port, host: options.host }, logger);
  }

  async start(): Promise<void> { await mkdir(this.root, { recursive: true, mode: 0o700 }); await this.transfer?.start(); }
  async stop(): Promise<void> { await this.transfer?.stop(); }
  getTransferPort(): number | undefined { return this.transfer?.getPort(); }

  hasTransfer(): boolean { return Boolean(this.transfer); }

  async issueInlineUrl(ref: ArtifactRef, conversationId: string, maxBytes = 8 * 1024 * 1024): Promise<string> {
    const artifact = this.authorize(ref, conversationId);
    if (artifact.size > maxBytes) throw new Error("GATEWAY_ARTIFACT_INLINE_LIMIT");
    if (await realpath(artifact.canonical_path) !== artifact.canonical_path) throw new Error("GATEWAY_ARTIFACT_PATH_CHANGED");
    await access(artifact.canonical_path);
    return `base64://${(await readFile(artifact.canonical_path)).toString("base64")}`;
  }

  async registerLocalArtifact(input: { path: string; allowedRoot: string; conversationId: string; requesterId: string; filename?: string; mime?: string; maxBytes?: number; expiresAt?: string; retentionClass?: GatewayArtifactRow["retention_class"]; ownerInvocationId?: string; ownerPluginId?: string }): Promise<{ ref: ArtifactRef; filename: string; mime?: string; size: number }> {
    const source = await realpath(input.path);
    const root = await realpath(input.allowedRoot);
    if (!this.isWithin(root, source)) throw new Error("GATEWAY_ARTIFACT_SOURCE_ROOT_DENIED");
    const info = await stat(source);
    if (!info.isFile()) throw new Error("GATEWAY_ARTIFACT_FILE_REQUIRED");
    if (input.maxBytes !== undefined && info.size > input.maxBytes) throw new Error("GATEWAY_ARTIFACT_TOO_LARGE");
    const artifactId = newId("gateway-artifact");
    const filename = safeFilename(input.filename ?? basename(source));
    const target = resolve(this.root, artifactId);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await copyFile(source, target);
    const createdAt = nowIso();
    const retentionClass = input.retentionClass ?? "task-lifetime";
    const expiresAt = input.expiresAt ?? (retentionClass === "temporary" ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() : undefined);
    this.db.run("INSERT INTO gateway_artifacts(id,canonical_path,filename,mime,size,conversation_id,requester_id,status,created_at,expires_at,retention_class,owner_invocation_id,owner_plugin_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", artifactId, target, filename, input.mime ?? null, info.size, input.conversationId, input.requesterId, "AVAILABLE", createdAt, expiresAt ?? null, retentionClass, input.ownerInvocationId ?? null, input.ownerPluginId ?? null);
    this.audit("artifact.publish", "ALLOW", undefined, artifactId, input.requesterId, input.conversationId);
    return { ref: { authority: "bot-gateway", artifactId }, filename, ...(input.mime ? { mime: input.mime } : {}), size: info.size };
  }

  issueUrl(ref: ArtifactRef, conversationId: string, ttlMs = 5 * 60 * 1000): string {
    if (!this.transfer) throw new Error("GATEWAY_ARTIFACT_TRANSFER_UNAVAILABLE");
    const artifact = this.authorize(ref, conversationId);
    return this.transfer.issueUrl(artifact.id, conversationId, ttlMs);
  }

  authorize(ref: ArtifactRef, conversationId: string): GatewayArtifactRow {
    if (ref.authority !== "bot-gateway") { this.audit("artifact.read", "DENY", "GATEWAY_ARTIFACT_AUTHORITY_REQUIRED", ref.artifactId, undefined, conversationId); throw new Error("GATEWAY_ARTIFACT_AUTHORITY_REQUIRED"); }
    const artifact = this.db.get<GatewayArtifactRow>("SELECT * FROM gateway_artifacts WHERE id=?", ref.artifactId);
    if (!artifact || artifact.status !== "AVAILABLE") { this.audit("artifact.read", "DENY", "GATEWAY_ARTIFACT_NOT_AVAILABLE", ref.artifactId, undefined, conversationId); throw new Error("GATEWAY_ARTIFACT_NOT_AVAILABLE"); }
    if (artifact.conversation_id !== conversationId) { this.audit("artifact.read", "DENY", "GATEWAY_ARTIFACT_DESTINATION_DENIED", ref.artifactId, undefined, conversationId); throw new Error("GATEWAY_ARTIFACT_DESTINATION_DENIED"); }
    if (artifact.expires_at && Date.parse(artifact.expires_at) <= Date.now()) { this.audit("artifact.read", "DENY", "GATEWAY_ARTIFACT_EXPIRED", ref.artifactId, undefined, conversationId); throw new Error("GATEWAY_ARTIFACT_EXPIRED"); }
    this.audit("artifact.read", "ALLOW", undefined, ref.artifactId, artifact.requester_id, conversationId);
    return artifact;
  }

  async cleanupExpired(now = Date.now()): Promise<number> {
    const rows = this.db.all<GatewayArtifactRow>("SELECT * FROM gateway_artifacts WHERE status='AVAILABLE'");
    const expired = rows.filter((row) => (row.expires_at && Date.parse(row.expires_at) <= now) || (row.retention_class === "temporary" && Date.parse(row.created_at) + 24 * 60 * 60 * 1000 <= now));
    for (const row of expired) {
      try { await unlink(row.canonical_path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      this.db.run("UPDATE gateway_artifacts SET status='EXPIRED' WHERE id=? AND status='AVAILABLE'", row.id);
    }
    return expired.length;
  }

  private isWithin(root: string, candidate: string): boolean {
    const path = relative(root, candidate);
    return path === "" || (path !== ".." && !path.startsWith("../") && !path.startsWith("..\\"));
  }

  private audit(operation: string, decision: "ALLOW" | "DENY", reason: string | undefined, resource: string, requesterId: string | undefined, conversationId: string): void {
    this.db.run("INSERT INTO authorization_audit_events(id,operation,decision,reason,resource,requester_id,conversation_id,metadata_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)", newId("authz"), operation, decision, reason ?? null, resource, requesterId ?? null, conversationId, null, nowIso());
  }
}

function safeFilename(value: string): string {
  const filename = basename(value).replace(/[\u0000-\u001f]/g, "_").slice(0, 180);
  return filename || "artifact";
}

class GatewayArtifactTransferServer {
  private readonly artifacts: GatewayArtifactService;
  private readonly baseUrl: string;
  private readonly secret: Buffer;
  private readonly port: number;
  private readonly host: string;
  private readonly logger: Logger;
  private server: Server | undefined;

  constructor(artifacts: GatewayArtifactService, options: { baseUrl: string; secret: string; port?: number; host?: string }, logger: Logger) {
    this.artifacts = artifacts; this.baseUrl = options.baseUrl.replace(/\/$/, ""); this.secret = Buffer.from(options.secret); this.port = options.port ?? 8791; this.host = options.host ?? "0.0.0.0"; this.logger = logger.child("gateway-artifact-transfer");
  }

  async start(): Promise<void> {
    this.server = createServer((request, response) => { void this.handle(request, response); });
    await new Promise<void>((resolve, reject) => { this.server?.once("error", reject); this.server?.listen(this.port, this.host, resolve); });
    this.logger.info("Gateway artifact transfer ready", { host: this.host, port: this.port });
  }

  async stop(): Promise<void> { await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve()); this.server = undefined; }

  getPort(): number | undefined { const address = this.server?.address(); return address && typeof address === "object" ? address.port : undefined; }

  issueUrl(artifactId: string, conversationId: string, ttlMs: number): string {
    const claims: TransferClaims = { artifactId, conversationId, expiresAt: Date.now() + Math.min(Math.max(ttlMs, 1000), 10 * 60 * 1000) };
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const signature = createHmac("sha256", this.secret).update(payload).digest("base64url");
    const base = new URL(this.baseUrl);
    if (base.port === "0") {
      const port = this.getPort();
      if (port) base.port = String(port);
    }
    return `${base.toString().replace(/\/$/, "")}/artifact/${encodeURIComponent(artifactId)}?token=${encodeURIComponent(`${payload}.${signature}`)}`;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "GET") { response.statusCode = 405; response.end(); return; }
    const url = new URL(request.url ?? "/", "http://gateway-artifact.local");
    if (!url.pathname.startsWith("/artifact/")) { response.statusCode = 404; response.end(); return; }
    const artifactId = decodeURIComponent(url.pathname.slice("/artifact/".length));
    const claims = this.decode(url.searchParams.get("token") ?? "");
    if (!claims || claims.artifactId !== artifactId || claims.expiresAt <= Date.now()) { response.statusCode = 403; response.end("GATEWAY_ARTIFACT_TRANSFER_DENIED"); return; }
    try {
      const artifact = this.artifacts.authorize({ authority: "bot-gateway", artifactId }, claims.conversationId);
      if (await realpath(artifact.canonical_path) !== artifact.canonical_path) throw new Error("GATEWAY_ARTIFACT_PATH_CHANGED");
      await access(artifact.canonical_path);
      response.statusCode = 200; response.setHeader("content-type", artifact.mime ?? "application/octet-stream"); response.setHeader("content-length", String(artifact.size)); response.setHeader("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(artifact.filename)}`);
      createReadStream(artifact.canonical_path).on("error", (error) => { this.logger.warn("Gateway artifact stream failed", { artifactId, error: String(error) }); response.destroy(error); }).pipe(response);
    } catch (error) { if (!response.headersSent) { response.statusCode = 404; response.end(String(error)); } }
  }

  private decode(value: string): TransferClaims | undefined {
    const [payload, signature] = value.split(".");
    if (!payload || !signature) return undefined;
    const expected = createHmac("sha256", this.secret).update(payload).digest();
    const presented = Buffer.from(signature, "base64url");
    if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) return undefined;
    try {
      const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as TransferClaims;
      return typeof claims.artifactId === "string" && typeof claims.conversationId === "string" && Number.isSafeInteger(claims.expiresAt) ? claims : undefined;
    } catch { return undefined; }
  }
}
