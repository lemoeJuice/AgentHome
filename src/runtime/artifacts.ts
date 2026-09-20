import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, realpath, stat, unlink } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import { once } from "node:events";
import type { SqliteStore } from "../db.js";
import { newId, nowIso } from "../shared/ids.js";
import type { ArtifactRef } from "../shared/types.js";

export interface ArtifactMetadata {
  ref: ArtifactRef;
  ownerTaskId?: string;
  producerWorkerId?: string;
  filename: string;
  mime?: string;
  size: number;
  sha256: string;
  status: "AVAILABLE" | "PUBLISHED" | "EXPIRED" | "DELETED";
}

export interface ArtifactCapability {
  publishTaskIds: string[];
  allowedDestinations: string[];
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
  }): Promise<ArtifactMetadata> {
    if (!input.capability.publishTaskIds.includes(input.taskId)) throw new Error("ARTIFACT_PUBLISH_DENIED");
    const candidate = await realpath(resolve(input.path));
    const roots = await Promise.all(input.allowedRoots.map((root) => realpath(resolve(root))));
    if (!roots.some((root) => this.isWithin(root, candidate))) throw new Error("ARTIFACT_SOURCE_ROOT_DENIED");
    if (this.isSensitive(candidate)) throw new Error("ARTIFACT_SENSITIVE_PATH_DENIED");
    const info = await stat(candidate);
    if (!info.isFile()) throw new Error("ARTIFACT_NOT_REGULAR_FILE");
    if (info.size > input.maxBytes) throw new Error("ARTIFACT_SIZE_LIMIT");
    const digest = await this.sha256(candidate);
    const id = newId("artifact");
    const filename = basename(candidate);
    const createdAt = nowIso();
    this.db.run("INSERT INTO artifacts(id,owner_task_id,producer_worker_id,source_type,canonical_path,filename,mime,size,sha256,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)", id, input.taskId, input.workerId ?? null, input.sourceType ?? "WORKER_OUTPUT", candidate, filename, input.mime ?? null, info.size, digest, "AVAILABLE", createdAt);
    return { ref: { authority: "agent-home", artifactId: id }, ownerTaskId: input.taskId, ...(input.workerId ? { producerWorkerId: input.workerId } : {}), filename, ...(input.mime ? { mime: input.mime } : {}), size: info.size, sha256: digest, status: "AVAILABLE" };
  }

  async ingestAttachment(input: { stream: AsyncIterable<Uint8Array>; filename?: string; mime?: string; size?: number; conversationId: string; maxBytes: number }): Promise<ArtifactMetadata> {
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
    this.db.run("INSERT INTO artifacts(id,owner_task_id,producer_worker_id,source_type,canonical_path,filename,mime,size,sha256,status,created_at,source_conversation_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", id, null, null, "QQ_INBOUND", target, safeName, input.mime ?? null, size, digest, "AVAILABLE", createdAt, input.conversationId);
    return { ref: { authority: "agent-home", artifactId: id }, filename: safeName, ...(input.mime ? { mime: input.mime } : {}), size, sha256: digest, status: "AVAILABLE" };
  }

  get(ref: ArtifactRef): ArtifactMetadata & { path: string } {
    if (ref.authority !== "agent-home") throw new Error("ARTIFACT_AUTHORITY_MISMATCH");
    const row = this.db.get<{ id: string; owner_task_id: string | null; producer_worker_id: string | null; filename: string; mime: string | null; size: number; sha256: string; status: ArtifactMetadata["status"]; canonical_path: string }>("SELECT id,owner_task_id,producer_worker_id,filename,mime,size,sha256,status,canonical_path FROM artifacts WHERE id=?", ref.artifactId);
    if (!row) throw new Error("ARTIFACT_NOT_FOUND");
    return { ref, ...(row.owner_task_id ? { ownerTaskId: row.owner_task_id } : {}), ...(row.producer_worker_id ? { producerWorkerId: row.producer_worker_id } : {}), filename: row.filename, ...(row.mime ? { mime: row.mime } : {}), size: row.size, sha256: row.sha256, status: row.status, path: row.canonical_path };
  }

  async open(ref: ArtifactRef): Promise<{ metadata: ArtifactMetadata; stream: AsyncIterable<Uint8Array> }> {
    const artifact = this.get(ref);
    if (artifact.status !== "AVAILABLE" && artifact.status !== "PUBLISHED") throw new Error("ARTIFACT_NOT_READABLE");
    if (await realpath(artifact.path) !== artifact.path) throw new Error("ARTIFACT_PATH_CHANGED");
    await access(artifact.path);
    const stream = createReadStream(artifact.path) as AsyncIterable<Uint8Array>;
    const { path: _path, ...metadata } = artifact;
    return { metadata, stream };
  }

  async delete(ref: ArtifactRef): Promise<void> {
    const artifact = this.get(ref);
    try { await unlink(artifact.path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    this.db.run("UPDATE artifacts SET status='DELETED' WHERE id=?", ref.artifactId);
  }

  private isWithin(root: string, candidate: string): boolean {
    const path = relative(root, candidate);
    return path === "" || (path !== ".." && !path.startsWith("../") && !path.startsWith("..\\"));
  }

  private isSensitive(path: string): boolean {
    const normalized = path.replaceAll("\\", "/");
    return normalized.includes("/secrets/") || normalized.includes("/.ssh/") || normalized.includes("/auth/") || normalized.startsWith(resolve(this.stateRoot, "secrets"));
  }

  private async sha256(path: string): Promise<string> {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest("hex");
  }
}
