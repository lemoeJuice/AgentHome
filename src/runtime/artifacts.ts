import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, copyFile, mkdir, realpath, stat, unlink } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import { once } from "node:events";
import type { SqliteStore } from "../db.js";
import { newId, nowIso } from "../shared/ids.js";
import type { ArtifactRef } from "../shared/types.js";

export interface ArtifactMetadata {
  ref: ArtifactRef;
  ownerTaskId?: string;
  producerWorkerId?: string;
  sourceConversationId?: string;
  sourceRequesterId?: string;
  sourceEventId?: string;
  filename: string;
  mime?: string;
  size: number;
  sha256: string;
  status: "AVAILABLE" | "PUBLISHED" | "EXPIRED" | "DELETED";
  retentionClass: "temporary" | "task-lifetime" | "persistent";
  ownerInvocationId?: string;
  ownerPluginId?: string;
  expiresAt?: string;
}

export interface ArtifactCapability {
  publishTaskIds: string[];
  allowedDestinations: string[];
}

export interface ArtifactReadCapability {
  readableArtifactAuthorities: string[];
}

export class ArtifactService {
  private readonly db: SqliteStore;
  private readonly stateRoot: string;
  constructor(db: SqliteStore, stateRoot: string) { this.db = db; this.stateRoot = stateRoot; }

  async registerLocalArtifact(input: {
    path: string;
    taskId: string;
    workerId?: string;
    mime?: string;
    sourceType?: "QQ_INBOUND" | "WORKER_OUTPUT" | "MAIN_OUTPUT" | "IMPORTED";
    allowedRoots: string[];
    capability: ArtifactCapability;
    maxBytes: number;
    expiresAt?: string;
    retentionClass?: ArtifactMetadata["retentionClass"];
    ownerInvocationId?: string;
    ownerPluginId?: string;
  }): Promise<ArtifactMetadata> {
    if (!input.capability.publishTaskIds.includes(input.taskId) && !input.capability.publishTaskIds.includes("*")) {
      this.audit("artifact.publish", "DENY", "ARTIFACT_PUBLISH_DENIED", input.taskId, input.workerId ? `worker:${input.workerId}` : undefined, input.taskId);
      throw new Error("ARTIFACT_PUBLISH_DENIED");
    }
    if (input.expiresAt && Date.parse(input.expiresAt) <= Date.now()) throw new Error("ARTIFACT_EXPIRED");
    const candidate = await realpath(resolve(input.path));
    const roots = await Promise.all(input.allowedRoots.map((root) => realpath(resolve(root))));
    if (!roots.some((root) => this.isWithin(root, candidate))) throw new Error("ARTIFACT_SOURCE_ROOT_DENIED");
    if (this.isSensitive(candidate)) throw new Error("ARTIFACT_SENSITIVE_PATH_DENIED");
    const info = await stat(candidate);
    if (!info.isFile()) throw new Error("ARTIFACT_NOT_REGULAR_FILE");
    if (info.size > input.maxBytes) throw new Error("ARTIFACT_SIZE_LIMIT");
    const id = newId("artifact");
    const filename = basename(candidate).replace(/[\u0000-\u001f]/g, "_").slice(0, 180) || "artifact";
    const retentionClass = input.retentionClass ?? "task-lifetime";
    const artifactDirectory = resolve(this.stateRoot, "artifacts");
    const target = resolve(artifactDirectory, `${id}-${filename}`);
    await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
    await copyFile(candidate, target);
    const targetInfo = await stat(target);
    const digest = await this.sha256(target);
    const createdAt = nowIso();
    const expiresAt = input.expiresAt ?? (retentionClass === "temporary" ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() : undefined);
    this.db.run("INSERT INTO artifacts(id,owner_task_id,producer_worker_id,source_type,canonical_path,filename,mime,size,sha256,status,created_at,expires_at,retention_class,owner_invocation_id,owner_plugin_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", id, input.taskId, input.workerId ?? null, input.sourceType ?? "WORKER_OUTPUT", target, filename, input.mime ?? null, targetInfo.size, digest, "AVAILABLE", createdAt, expiresAt ?? null, retentionClass, input.ownerInvocationId ?? null, input.ownerPluginId ?? null);
    this.audit("artifact.publish", "ALLOW", undefined, id, input.workerId ? `worker:${input.workerId}` : undefined, input.taskId);
    return { ref: { authority: "agent-home", artifactId: id }, ownerTaskId: input.taskId, ...(input.workerId ? { producerWorkerId: input.workerId } : {}), filename, ...(input.mime ? { mime: input.mime } : {}), size: targetInfo.size, sha256: digest, status: "AVAILABLE", retentionClass, ...(input.ownerInvocationId ? { ownerInvocationId: input.ownerInvocationId } : {}), ...(input.ownerPluginId ? { ownerPluginId: input.ownerPluginId } : {}), ...(expiresAt ? { expiresAt } : {}) };
  }

  async ingestAttachment(input: { stream: AsyncIterable<Uint8Array>; filename?: string; mime?: string; size?: number; conversationId: string; requesterId?: string; eventId?: string; maxBytes: number }): Promise<ArtifactMetadata> {
    if (input.size !== undefined && input.size > input.maxBytes) throw new Error("ARTIFACT_SIZE_LIMIT");
    const id = newId("artifact");
    const safeName = (basename(input.filename ?? "attachment").replace(/[\u0000-\u001f]/g, "_") || "attachment").slice(0, 180);
    const target = resolve(this.stateRoot, "inbox", `${id}-${safeName}`);
    await mkdir(resolve(this.stateRoot, "inbox"), { recursive: true });
    const output = createWriteStream(target, { mode: 0o600 });
    const hash = createHash("sha256");
    let size = 0;
    try {
      for await (const chunk of input.stream) {
        size += chunk.byteLength;
        if (size > input.maxBytes) throw new Error("ARTIFACT_SIZE_LIMIT");
        hash.update(chunk);
        if (!output.write(chunk)) await once(output, "drain");
      }
      await new Promise<void>((resolve, reject) => {
        output.once("error", reject);
        output.once("close", resolve);
        output.end();
      });
    } catch (error) {
      output.destroy();
      await unlink(target).catch(() => undefined);
      throw error;
    }
    const createdAt = nowIso();
    const digest = hash.digest("hex");
    this.db.run("INSERT INTO artifacts(id,owner_task_id,producer_worker_id,source_type,canonical_path,filename,mime,size,sha256,status,created_at,source_conversation_id,source_requester_id,source_event_id,retention_class,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", id, null, null, "QQ_INBOUND", target, safeName, input.mime ?? null, size, digest, "AVAILABLE", createdAt, input.conversationId, input.requesterId ?? null, input.eventId ?? null, "task-lifetime", null);
    return { ref: { authority: "agent-home", artifactId: id }, filename: safeName, ...(input.mime ? { mime: input.mime } : {}), size, sha256: digest, status: "AVAILABLE", retentionClass: "task-lifetime" };
  }

  get(ref: ArtifactRef): ArtifactMetadata & { path: string } {
    if (ref.authority !== "agent-home") throw new Error("ARTIFACT_AUTHORITY_MISMATCH");
    const row = this.db.get<{ id: string; owner_task_id: string | null; producer_worker_id: string | null; source_conversation_id: string | null; source_requester_id: string | null; source_event_id: string | null; filename: string; mime: string | null; size: number; sha256: string; status: ArtifactMetadata["status"]; canonical_path: string; expires_at: string | null; retention_class: ArtifactMetadata["retentionClass"]; owner_invocation_id: string | null; owner_plugin_id: string | null }>("SELECT id,owner_task_id,producer_worker_id,source_conversation_id,source_requester_id,source_event_id,filename,mime,size,sha256,status,canonical_path,expires_at,retention_class,owner_invocation_id,owner_plugin_id FROM artifacts WHERE id=?", ref.artifactId);
    if (!row) throw new Error("ARTIFACT_NOT_FOUND");
    return { ref, ...(row.owner_task_id ? { ownerTaskId: row.owner_task_id } : {}), ...(row.producer_worker_id ? { producerWorkerId: row.producer_worker_id } : {}), ...(row.source_conversation_id ? { sourceConversationId: row.source_conversation_id } : {}), ...(row.source_requester_id ? { sourceRequesterId: row.source_requester_id } : {}), ...(row.source_event_id ? { sourceEventId: row.source_event_id } : {}), filename: row.filename, ...(row.mime ? { mime: row.mime } : {}), size: row.size, sha256: row.sha256, status: row.status, retentionClass: row.retention_class, ...(row.owner_invocation_id ? { ownerInvocationId: row.owner_invocation_id } : {}), ...(row.owner_plugin_id ? { ownerPluginId: row.owner_plugin_id } : {}), path: row.canonical_path, ...(row.expires_at ? { expiresAt: row.expires_at } : {}) };
  }

  bindToTask(ref: ArtifactRef, input: { taskId: string; conversationId: string; requesterId: string }): void {
    const artifact = this.get(ref);
    if (artifact.ref.authority !== "agent-home" || artifact.sourceConversationId !== input.conversationId || (artifact.sourceRequesterId && artifact.sourceRequesterId !== input.requesterId)) throw new Error("ARTIFACT_TASK_BIND_DENIED");
    if (artifact.ownerTaskId && artifact.ownerTaskId !== input.taskId) throw new Error("ARTIFACT_TASK_BIND_DENIED");
    this.db.run("UPDATE artifacts SET owner_task_id=? WHERE id=? AND owner_task_id IS NULL", input.taskId, ref.artifactId);
  }

  authorizeRead(ref: ArtifactRef, input: { conversationId?: string; requesterId?: string; taskId?: string; sourceEventId?: string; readCapability: ArtifactReadCapability }): ArtifactMetadata & { path: string } {
    const artifact = this.get(ref);
    if (!input.readCapability.readableArtifactAuthorities.includes(ref.authority)) { this.audit("artifact.read", "DENY", "ARTIFACT_READ_DENIED", ref.artifactId, input.requesterId, input.taskId); throw new Error("ARTIFACT_READ_DENIED"); }
    if (artifact.status !== "AVAILABLE" && artifact.status !== "PUBLISHED") throw new Error("ARTIFACT_NOT_READABLE");
    this.assertNotExpired(artifact);
    if (artifact.ownerTaskId && input.taskId !== artifact.ownerTaskId) throw new Error("ARTIFACT_TASK_READ_DENIED");
    if (artifact.sourceConversationId && input.conversationId !== artifact.sourceConversationId) throw new Error("ARTIFACT_CONVERSATION_READ_DENIED");
    if (artifact.sourceEventId && !artifact.ownerTaskId && input.sourceEventId !== artifact.sourceEventId) throw new Error("ARTIFACT_EVENT_BIND_DENIED");
    if (artifact.sourceRequesterId && input.requesterId !== artifact.sourceRequesterId && !artifact.ownerTaskId) throw new Error("ARTIFACT_REQUESTER_READ_DENIED");
    return artifact;
  }

  authorizeOutbound(ref: ArtifactRef, input: { taskId: string; destination: string; capability: ArtifactCapability }): ArtifactMetadata & { path: string } {
    const artifact = this.get(ref);
    if (artifact.status !== "AVAILABLE" && artifact.status !== "PUBLISHED") throw new Error("ARTIFACT_NOT_SENDABLE");
    this.assertNotExpired(artifact);
    if (!artifact.ownerTaskId || artifact.ownerTaskId !== input.taskId) { this.audit("artifact.send", "DENY", "ARTIFACT_OWNER_DENIED", ref.artifactId, undefined, input.taskId); throw new Error("ARTIFACT_OWNER_DENIED"); }
    if (!input.capability.allowedDestinations.includes(input.destination)) { this.audit("artifact.send", "DENY", "ARTIFACT_DESTINATION_DENIED", ref.artifactId, input.destination, input.taskId); throw new Error("ARTIFACT_DESTINATION_DENIED"); }
    this.audit("artifact.send", "ALLOW", undefined, ref.artifactId, input.destination, input.taskId);
    return artifact;
  }

  async openAuthorized(ref: ArtifactRef, input: { conversationId?: string; requesterId?: string; taskId?: string; sourceEventId?: string; readCapability: ArtifactReadCapability }): Promise<{ metadata: ArtifactMetadata; stream: AsyncIterable<Uint8Array> }> {
    const artifact = this.authorizeRead(ref, input);
    if (await realpath(artifact.path) !== artifact.path) throw new Error("ARTIFACT_PATH_CHANGED");
    await access(artifact.path);
    const stream = createReadStream(artifact.path) as AsyncIterable<Uint8Array>;
    const { path: _path, ...metadata } = artifact;
    return { metadata, stream };
  }

  authorizeTransfer(ref: ArtifactRef, input: { taskId: string; destination: string }): ArtifactMetadata & { path: string } {
    const artifact = this.get(ref);
    if (artifact.status !== "AVAILABLE" && artifact.status !== "PUBLISHED") throw new Error("ARTIFACT_NOT_SENDABLE");
    this.assertNotExpired(artifact);
    if (artifact.ownerTaskId !== input.taskId) throw new Error("ARTIFACT_OWNER_DENIED");
    return artifact;
  }

  async materializeForRead(ref: ArtifactRef, input: { conversationId?: string; requesterId?: string; taskId?: string; readCapability: ArtifactReadCapability }, destinationRoot: string): Promise<{ metadata: ArtifactMetadata; path: string }> {
    const opened = await this.openAuthorized(ref, input);
    const root = await realpath(destinationRoot);
    const directory = resolve(root, "inbound-artifacts");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const target = resolve(directory, `${ref.artifactId}-${basename(opened.metadata.filename)}`);
    if (!this.isWithin(root, target)) throw new Error("ARTIFACT_DESTINATION_DENIED");
    const output = createWriteStream(target, { mode: 0o600 });
    try {
      for await (const chunk of opened.stream) {
        if (!output.write(chunk)) await once(output, "drain");
      }
      await new Promise<void>((resolve, reject) => {
        output.once("error", reject);
        output.once("close", resolve);
        output.end();
      });
    } catch (error) {
      output.destroy();
      await unlink(target).catch(() => undefined);
      throw error;
    }
    return { metadata: opened.metadata, path: target };
  }

  async delete(ref: ArtifactRef): Promise<void> {
    const artifact = this.get(ref);
    try { await unlink(artifact.path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    this.db.run("UPDATE artifacts SET status='DELETED' WHERE id=?", ref.artifactId);
  }

  async cleanupExpired(now = nowIso()): Promise<number> {
    const nowMs = Date.parse(now);
    const rows = this.db.all<{ id: string; canonical_path: string; expires_at: string | null; retention_class: ArtifactMetadata["retentionClass"]; created_at: string; task_status: string | null; task_terminal_at: string | null }>("SELECT a.id,a.canonical_path,a.expires_at,a.retention_class,a.created_at,t.status AS task_status,COALESCE(t.completed_at,t.updated_at) AS task_terminal_at FROM artifacts a LEFT JOIN tasks t ON t.id=a.owner_task_id WHERE a.status IN ('AVAILABLE','PUBLISHED')");
    const eligible = rows.filter((row) => (row.expires_at && Date.parse(row.expires_at) <= nowMs)
      || (row.retention_class === "temporary" && Date.parse(row.created_at) + 24 * 60 * 60 * 1000 <= nowMs)
      || (row.retention_class === "task-lifetime" && ["COMPLETED", "PARTIAL", "FAILED", "CANCELLED"].includes(row.task_status ?? "") && row.task_terminal_at && Date.parse(row.task_terminal_at) + 7 * 24 * 60 * 60 * 1000 <= nowMs));
    for (const row of eligible) {
      try { await unlink(row.canonical_path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      this.db.run("UPDATE artifacts SET status='EXPIRED' WHERE id=? AND status IN ('AVAILABLE','PUBLISHED')", row.id);
    }
    return eligible.length;
  }

  private isWithin(root: string, candidate: string): boolean {
    const path = relative(root, candidate);
    return path === "" || (path !== ".." && !path.startsWith("../") && !path.startsWith("..\\"));
  }

  private isSensitive(path: string): boolean {
    const normalized = path.replaceAll("\\", "/");
    return normalized.includes("/secrets/") || normalized.includes("/.ssh/") || normalized.includes("/auth/") || normalized.startsWith(resolve(this.stateRoot, "secrets"));
  }

  private assertNotExpired(artifact: ArtifactMetadata): void {
    if (artifact.expiresAt && Date.parse(artifact.expiresAt) <= Date.now()) throw new Error("ARTIFACT_EXPIRED");
  }

  private async sha256(path: string): Promise<string> {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest("hex");
  }

  private audit(operation: string, decision: "ALLOW" | "DENY", reason: string | undefined, resource: string, requesterId?: string, taskId?: string): void {
    this.db.run("INSERT INTO authorization_audit_events(id,operation,decision,reason,resource,requester_id,task_id,metadata_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)", newId("authz"), operation, decision, reason ?? null, resource, requesterId ?? null, taskId ?? null, null, nowIso());
  }
}
