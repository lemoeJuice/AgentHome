import { createHash } from "node:crypto";
import type { SqliteStore } from "../db.js";
import { newId, nowIso } from "../shared/ids.js";
import type { JsonValue, MemoryScope } from "../shared/types.js";

export interface MemoryAccessContext {
  requesterId: string;
  principalId?: string;
  trust: "OWNER" | "GUEST";
  allowedScopes: MemoryScope[];
  projectIds?: string[];
  conversationId?: string;
}

export interface MemoryRetentionPolicy {
  rawEpisodeDays: number | null;
  keepExplicitForever: boolean;
  keepProvenanceForActiveFacts: boolean;
  maxPromptBytes: number;
}

export interface MemoryEpisode {
  id: string;
  scope: MemoryScope;
  source: { type: string; platform?: string; sourceId?: string };
  actor?: { type: "user" | "agent" | "worker" | "system"; id?: string };
  content: string;
  occurredAt: string;
  ingestedAt: string;
  trust: "owner" | "guest" | "system";
  metadata?: Record<string, JsonValue>;
}

export interface MemoryRecord {
  id: string;
  type: "fact" | "episode" | "explicit" | "episodic";
  scope: MemoryScope;
  content: string;
  provenance?: string[];
  occurredAt?: string;
  status?: "active" | "superseded" | "disputed" | "deleted";
  confidence?: number;
  validFrom?: string;
  validTo?: string;
}

export interface MemoryExplanation {
  record: MemoryRecord;
  sources: MemoryEpisode[];
}

export interface MemoryExport {
  manifest: { format: "agent-memory"; version: 1; exportedAt: string; counts: Record<string, number> };
  episodes: MemoryEpisode[];
  facts: Array<Record<string, unknown>>;
  episodic: Array<Record<string, unknown>>;
  explicit: Array<Record<string, unknown>>;
  profile: Array<Record<string, unknown>>;
}

export interface MemoryJsonlExport {
  manifest: MemoryExport["manifest"] & { source: "agent-home"; checksums: Record<string, string> };
  episodes: string;
  facts: string;
  episodic: string;
  explicit: string;
  profile: string;
}

type FactProposal = { subject: string; predicate: string; object: JsonValue; confidence?: number; validFrom?: string };
type EpisodicProposal = { situation: string; action?: string; outcome?: string; lesson?: string; importance?: number };
const MAX_RETRIES = 5;
const RETRY_DELAYS_MS = [1_000, 5_000, 30_000, 300_000, 900_000];

export class MemoryService {
  private readonly db: SqliteStore;
  private readonly owners: Array<{ platform: string; accountId: string; userId: string }>;
  private readonly retention: MemoryRetentionPolicy;
  constructor(db: SqliteStore, owners?: { platform: string; accountId: string; userId: string } | Array<{ platform: string; accountId: string; userId: string }>, retention?: Partial<MemoryRetentionPolicy>) {
    this.db = db;
    this.owners = owners ? (Array.isArray(owners) ? owners : [owners]) : [];
    this.retention = { rawEpisodeDays: 30, keepExplicitForever: true, keepProvenanceForActiveFacts: true, maxPromptBytes: 24 * 1024, ...retention };
  }

  recover(): void {
    const timestamp = nowIso();
    this.db.run("UPDATE memory_inbox SET status='pending',next_attempt_at=NULL,updated_at=? WHERE status='processing'", timestamp);
    this.db.run("UPDATE memory_index_queue SET status='pending',next_attempt_at=NULL,updated_at=? WHERE status='processing'", timestamp);
  }

  isolateLegacyPrincipalScopes(): { moved: number; quarantined: number } {
    if (this.db.get("SELECT 1 AS applied FROM runtime_meta WHERE key='principal_memory_isolation_v1'")) return { moved: 0, quarantined: 0 };
    let moved = 0;
    let quarantined = 0;
    const episodePrincipals = new Map<string, string>();
    const episodeRows = this.db.all<{ id: string; scope: string; source_json: string; actor_json: string | null; trust: string }>("SELECT id,scope,source_json,actor_json,trust FROM memory_episodes WHERE scope='global_agent' OR scope LIKE 'group:%'");
    this.db.transaction(() => {
      for (const row of episodeRows) {
        if (row.trust === "system") continue;
        const principalId = this.resolveLegacyEpisodePrincipal(row.source_json, row.actor_json);
        const scope = principalId ? `user:${principalId}` : `legacy_quarantine:${row.id}`;
        if (principalId) { episodePrincipals.set(row.id, principalId); moved += 1; } else quarantined += 1;
        this.db.run("UPDATE memory_episodes SET scope=? WHERE id=?", scope, row.id);
      }
      for (const table of ["memory_facts", "memory_episodic", "memory_explicit"] as const) {
        const rows = this.db.all<{ id: string; scope: string; provenance_json: string }>(`SELECT id,scope,provenance_json FROM ${table} WHERE scope='global_agent' OR scope LIKE 'group:%'`);
        for (const row of rows) {
          let provenance: string[] = [];
          try { provenance = JSON.parse(row.provenance_json) as string[]; } catch { /* quarantine malformed history */ }
          const principals = [...new Set(provenance.map((id) => episodePrincipals.get(id)).filter((id): id is string => Boolean(id)))];
          const allResolved = provenance.length > 0 && principals.length === 1 && provenance.every((id) => episodePrincipals.has(id));
          const scope = allResolved ? `user:${principals[0]}` : `legacy_quarantine:${row.id}`;
          if (allResolved) moved += 1; else quarantined += 1;
          this.db.run(`UPDATE ${table} SET scope=? WHERE id=?`, scope, row.id);
        }
      }
      for (const row of this.db.all<{ id: string; source_memory_ids_json: string }>("SELECT id,source_memory_ids_json FROM memory_profiles WHERE scope='global_agent' OR scope LIKE 'group:%'")) {
        let sources: string[] = [];
        try { sources = JSON.parse(row.source_memory_ids_json) as string[]; } catch { /* quarantine malformed history */ }
        const scopes = new Set<string>();
        for (const sourceId of sources) {
          const source = this.db.get<{ scope: string }>("SELECT scope FROM memory_episodes WHERE id=? UNION ALL SELECT scope FROM memory_facts WHERE id=? UNION ALL SELECT scope FROM memory_episodic WHERE id=? UNION ALL SELECT scope FROM memory_explicit WHERE id=? LIMIT 1", sourceId, sourceId, sourceId, sourceId);
          if (source) scopes.add(source.scope);
        }
        const userScopes = [...scopes].filter((scope) => scope.startsWith("user:"));
        const safeScope = sources.length > 0 && userScopes.length === 1 && userScopes.length === scopes.size ? (userScopes[0] ?? `legacy_quarantine:${row.id}`) : `legacy_quarantine:${row.id}`;
        if (safeScope.startsWith("user:")) moved += 1; else quarantined += 1;
        this.db.run("UPDATE memory_profiles SET scope=? WHERE id=?", safeScope, row.id);
      }
      this.db.run("UPDATE memory_tombstones SET scope=? WHERE scope='global_agent' OR scope LIKE 'group:%'", "legacy_quarantine");
    });
    this.rebuildDerivedIndexes();
    this.db.run("INSERT INTO runtime_meta(key,value) VALUES ('principal_memory_isolation_v1','1') ON CONFLICT(key) DO UPDATE SET value='1'");
    return { moved, quarantined };
  }

  cleanupRetention(reference = new Date()): number {
    if (this.retention.rawEpisodeDays === null) return 0;
    const cutoff = new Date(reference.getTime() - this.retention.rawEpisodeDays * 24 * 60 * 60 * 1000).toISOString();
    const protectedEpisodes = new Set<string>();
    if (this.retention.keepProvenanceForActiveFacts) {
      const rows = this.db.all<{ provenance_json: string }>("SELECT provenance_json FROM memory_facts WHERE status IN ('active','disputed')");
      for (const row of rows) {
        try { for (const id of JSON.parse(row.provenance_json) as unknown[]) if (typeof id === "string") protectedEpisodes.add(id); } catch { /* Ignore malformed legacy provenance during retention. */ }
      }
    }
    let removed = 0;
    this.db.transaction(() => {
      const episodes = this.db.all<{ id: string }>("SELECT id FROM memory_episodes WHERE occurred_at<? AND id NOT IN (SELECT episode_id FROM memory_inbox WHERE status IN ('pending','processing'))", cutoff);
      for (const episode of episodes) {
        if (protectedEpisodes.has(episode.id)) continue;
        this.db.run("DELETE FROM memory_fts WHERE record_id=?", episode.id);
        this.db.run("DELETE FROM memory_index_queue WHERE record_id=?", episode.id);
        this.db.run("DELETE FROM memory_inbox WHERE episode_id=?", episode.id);
        this.db.run("DELETE FROM memory_episodes WHERE id=?", episode.id);
        removed += 1;
      }
      if (!this.retention.keepExplicitForever) {
        const explicit = this.db.all<{ id: string }>("SELECT id FROM memory_explicit WHERE created_at<?", cutoff);
        for (const record of explicit) {
          this.db.run("DELETE FROM memory_fts WHERE record_id=?", record.id);
          this.db.run("DELETE FROM memory_explicit WHERE id=?", record.id);
          removed += 1;
        }
      }
    });
    return removed;
  }

  ingestEpisode(input: { access: MemoryAccessContext; episode: Omit<MemoryEpisode, "id" | "ingestedAt"> }): MemoryEpisode {
    this.assertScope(input.access, input.episode.scope);
    const expectedTrust = input.episode.source.type === "system_event" && input.access.requesterId === "system" ? "system" : input.access.trust === "OWNER" ? "owner" : "guest";
    if (expectedTrust !== input.episode.trust) throw new Error("MEMORY_EPISODE_TRUST_MISMATCH");
    if (input.episode.source.sourceId) {
      const existing = this.db.get<{ id: string; scope: MemoryScope; source_json: string; actor_json: string | null; content: string; occurred_at: string; ingested_at: string; trust: MemoryEpisode["trust"]; metadata_json: string | null }>("SELECT id,scope,source_json,actor_json,content,occurred_at,ingested_at,trust,metadata_json FROM memory_episodes WHERE scope=? AND source_json=?", input.episode.scope, JSON.stringify(input.episode.source));
      if (existing) return { id: existing.id, scope: existing.scope, source: JSON.parse(existing.source_json), ...(existing.actor_json ? { actor: JSON.parse(existing.actor_json) } : {}), content: existing.content, occurredAt: existing.occurred_at, ingestedAt: existing.ingested_at, trust: existing.trust, ...(existing.metadata_json ? { metadata: JSON.parse(existing.metadata_json) } : {}) };
    }
    const episode: MemoryEpisode = { ...input.episode, id: newId("episode"), ingestedAt: nowIso() };
    this.db.transaction(() => {
      this.db.run("INSERT INTO memory_episodes(id,scope,source_json,actor_json,content,occurred_at,ingested_at,trust,metadata_json) VALUES (?,?,?,?,?,?,?,?,?)", episode.id, episode.scope, JSON.stringify(episode.source), episode.actor ? JSON.stringify(episode.actor) : null, episode.content, episode.occurredAt, episode.ingestedAt, episode.trust, episode.metadata ? JSON.stringify(episode.metadata) : null);
      this.db.run("INSERT INTO memory_inbox(id,episode_id,status,retries,created_at,updated_at) VALUES (?,?,?,?,?,?)", newId("inbox"), episode.id, "pending", 0, episode.ingestedAt, episode.ingestedAt);
      this.enqueueIndex(episode.id, "episode", episode.scope, episode.content, "UPSERT");
    });
    return episode;
  }

  ingestTaskEpisode(input: { access: MemoryAccessContext; scope: MemoryScope; taskId: string; sourceId: string; content: string; occurredAt: string; workerId?: string; metadata?: Record<string, JsonValue> }): MemoryEpisode {
    return this.ingestEpisode({ access: input.access, episode: { scope: input.scope, source: { type: "task", sourceId: input.sourceId }, actor: input.workerId ? { type: "worker", id: input.workerId } : { type: "system", id: input.taskId }, content: input.content, occurredAt: input.occurredAt, trust: input.access.trust === "OWNER" ? "owner" : "guest", metadata: { taskId: input.taskId, ...(input.metadata ?? {}) } } });
  }

  ingestDocumentEpisode(input: { access: MemoryAccessContext; scope: MemoryScope; documentId: string; content: string; occurredAt: string; metadata?: Record<string, JsonValue> }): MemoryEpisode {
    return this.ingestEpisode({ access: input.access, episode: { scope: input.scope, source: { type: "document", sourceId: input.documentId }, actor: { type: "system", id: "document" }, content: input.content, occurredAt: input.occurredAt, trust: input.access.trust === "OWNER" ? "owner" : "guest", metadata: input.metadata } });
  }

  ingestManualEpisode(input: { access: MemoryAccessContext; scope: MemoryScope; sourceId: string; content: string; occurredAt: string; metadata?: Record<string, JsonValue> }): MemoryEpisode {
    return this.ingestEpisode({ access: input.access, episode: { scope: input.scope, source: { type: "manual", sourceId: input.sourceId }, actor: { type: "user", id: input.access.requesterId }, content: input.content, occurredAt: input.occurredAt, trust: input.access.trust === "OWNER" ? "owner" : "guest", metadata: input.metadata } });
  }

  ingestSystemEpisode(input: { access: MemoryAccessContext; scope: MemoryScope; sourceId: string; content: string; occurredAt: string; metadata?: Record<string, JsonValue> }): MemoryEpisode {
    if (input.access.requesterId !== "system") throw new Error("MEMORY_SYSTEM_INGEST_DENIED");
    return this.ingestEpisode({ access: input.access, episode: { scope: input.scope, source: { type: "system_event", sourceId: input.sourceId }, actor: { type: "system" }, content: input.content, occurredAt: input.occurredAt, trust: "system", metadata: input.metadata } });
  }

  remember(input: { access: MemoryAccessContext; scope: MemoryScope; content: string; provenance?: string[] }): MemoryRecord {
    this.assertScope(input.access, input.scope);
    const id = newId("explicit");
    const timestamp = nowIso();
    const provenance = input.provenance ?? [];
    this.db.transaction(() => {
      this.db.run("INSERT INTO memory_explicit(id,scope,content,provenance_json,created_at,updated_at) VALUES (?,?,?,?,?,?)", id, input.scope, input.content, JSON.stringify(provenance), timestamp, timestamp);
      this.enqueueIndex(id, "explicit", input.scope, input.content, "UPSERT");
      this.refreshProfiles(input.access);
    });
    return { id, type: "explicit", scope: input.scope, content: input.content, provenance };
  }

  rememberFact(input: { access: MemoryAccessContext; scope: MemoryScope; subject: string; predicate: string; object: JsonValue; confidence?: number; validFrom?: string; provenance?: string[] }): MemoryRecord {
    this.assertScope(input.access, input.scope);
    const timestamp = nowIso();
    const provenance = input.provenance ?? [];
    const objectJson = JSON.stringify(input.object);
    const existing = this.db.get<{ id: string; object_json: string; provenance_json: string; confidence: number }>("SELECT id,object_json,provenance_json,confidence FROM memory_facts WHERE scope=? AND subject=? AND predicate=? AND status IN ('active','disputed') ORDER BY updated_at DESC LIMIT 1", input.scope, input.subject, input.predicate);
    let id: string;
    let returnedProvenance = provenance;
    this.db.transaction(() => {
      if (existing && existing.object_json === objectJson) {
        id = existing.id;
        const merged = [...new Set([...(JSON.parse(existing.provenance_json) as string[]), ...provenance])];
        returnedProvenance = merged;
        this.db.run("UPDATE memory_facts SET confidence=?,provenance_json=?,updated_at=? WHERE id=?", Math.max(existing.confidence, input.confidence ?? 0.5), JSON.stringify(merged), timestamp, id);
      } else {
        if (existing) this.db.run("UPDATE memory_facts SET status=?,valid_to=?,updated_at=? WHERE id=?", input.validFrom ? "superseded" : "disputed", input.validFrom ?? timestamp, timestamp, existing.id);
        id = newId("fact");
        this.db.run("INSERT INTO memory_facts(id,scope,subject,predicate,object_json,confidence,valid_from,status,provenance_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)", id, input.scope, input.subject, input.predicate, objectJson, Math.max(0, Math.min(1, input.confidence ?? 0.5)), input.validFrom ?? timestamp, "active", JSON.stringify(provenance), timestamp, timestamp);
      }
      this.enqueueIndex(id, "fact", input.scope, `${input.subject} ${input.predicate} ${objectJson}`, "UPSERT");
      this.refreshProfiles(input.access);
    });
    return { id: id!, type: "fact", scope: input.scope, content: `${input.subject} ${input.predicate} ${objectJson}`, provenance: returnedProvenance };
  }

  retrieve(input: { text: string; access: MemoryAccessContext; types?: Array<"fact" | "episode" | "explicit" | "episodic" | "raw">; timeRange?: { from?: string; to?: string }; includeProvenance?: boolean; limit?: number }): { items: MemoryRecord[]; core: string[] } {
    this.drainIndexQueue();
    const scopes = this.authorizedScopes(input.access);
    if (scopes.length === 0) return { items: [], core: [] };
    const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
    const terms = input.text.trim().split(/\s+/).filter(Boolean).slice(0, 8);
    if (terms.length === 0) return { items: [], core: this.getCoreContext(input.access) };
    const query = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND ");
    const placeholders = scopes.map(() => "?").join(",");
    const items: MemoryRecord[] = [];
    const include = (type: string) => !input.types || input.types.includes(type as never) || (type === "episode" && input.types.includes("raw"));
    if (include("explicit")) {
      const filter = temporalFilter("e.created_at", input.timeRange, "e.id");
      const rows = this.db.all<{ id: string; scope: MemoryScope; content: string; provenance_json: string }>(`SELECT e.id,e.scope,e.content,e.provenance_json FROM memory_fts f JOIN memory_explicit e ON e.id=f.record_id WHERE memory_fts MATCH ? AND f.record_type='explicit' AND f.scope IN (${placeholders}) ${filter.sql} ORDER BY bm25(memory_fts),e.updated_at DESC LIMIT ?`, query, ...scopes, ...filter.args, limit);
      items.push(...rows.map((row) => ({ id: row.id, type: "explicit" as const, scope: row.scope, content: row.content, ...(input.includeProvenance ? { provenance: JSON.parse(row.provenance_json) as string[] } : {}) })));
    }
    if (include("fact")) {
      const filter = factTemporalFilter(input.timeRange, "fct");
      const rows = this.db.all<{ id: string; scope: MemoryScope; subject: string; predicate: string; object_json: string; provenance_json: string; confidence: number; valid_from: string | null; valid_to: string | null; status: MemoryRecord["status"] }>(`SELECT fct.id,fct.scope,fct.subject,fct.predicate,fct.object_json,fct.provenance_json,fct.confidence,fct.valid_from,fct.valid_to,fct.status FROM memory_fts f JOIN memory_facts fct ON fct.id=f.record_id WHERE memory_fts MATCH ? AND f.record_type='fact' AND f.scope IN (${placeholders}) AND fct.status IN ('active','disputed') ${filter.sql} ORDER BY bm25(memory_fts),fct.confidence DESC,fct.updated_at DESC LIMIT ?`, query, ...scopes, ...filter.args, limit);
      items.push(...rows.map((row) => ({ id: row.id, type: "fact" as const, scope: row.scope, content: `${row.subject} ${row.predicate} ${row.object_json}`, ...(input.includeProvenance ? { provenance: JSON.parse(row.provenance_json) as string[] } : {}), status: row.status, confidence: row.confidence, ...(row.valid_from ? { validFrom: row.valid_from } : {}), ...(row.valid_to ? { validTo: row.valid_to } : {}) })));
    }
    if (include("episode")) {
      const filter = temporalFilter("e.occurred_at", input.timeRange, "e.id");
      const rows = this.db.all<{ id: string; scope: MemoryScope; content: string; occurred_at: string; source_json: string }>(`SELECT e.id,e.scope,e.content,e.occurred_at,e.source_json FROM memory_fts f JOIN memory_episodes e ON e.id=f.record_id WHERE memory_fts MATCH ? AND f.record_type='episode' AND f.scope IN (${placeholders}) ${filter.sql} ORDER BY bm25(memory_fts),e.occurred_at DESC LIMIT ?`, query, ...scopes, ...filter.args, limit);
      items.push(...rows.map((row) => ({ id: row.id, type: "episode" as const, scope: row.scope, content: row.content, occurredAt: row.occurred_at, ...(input.includeProvenance ? { provenance: sourceProvenance(row.source_json) } : {}) })));
    }
    if (include("episodic")) {
      const filter = temporalFilter("e.occurred_at", input.timeRange, "e.id");
      const rows = this.db.all<{ id: string; scope: MemoryScope; situation: string; action: string | null; outcome: string | null; lesson: string | null; occurred_at: string | null; provenance_json: string }>(`SELECT e.id,e.scope,e.situation,e.action,e.outcome,e.lesson,e.occurred_at,e.provenance_json FROM memory_fts f JOIN memory_episodic e ON e.id=f.record_id WHERE memory_fts MATCH ? AND f.record_type='episodic' AND f.scope IN (${placeholders}) ${filter.sql} ORDER BY bm25(memory_fts),e.updated_at DESC LIMIT ?`, query, ...scopes, ...filter.args, limit);
      items.push(...rows.map((row) => ({ id: row.id, type: "episodic" as const, scope: row.scope, content: [row.situation, row.action, row.outcome, row.lesson].filter(Boolean).join("\n"), ...(row.occurred_at ? { occurredAt: row.occurred_at } : {}), ...(input.includeProvenance ? { provenance: JSON.parse(row.provenance_json) as string[] } : {}) })));
    }
    return { items: items.slice(0, limit), core: this.getCoreContext(input.access) };
  }

  getCoreContext(access: MemoryAccessContext, maxItems = 20): string[] {
    const scopes = this.authorizedScopes(access);
    if (!scopes.length) return [];
    const placeholders = scopes.map(() => "?").join(",");
    return this.db.all<{ content: string }>(`SELECT content FROM memory_profiles WHERE scope IN (${placeholders}) ORDER BY version DESC,generated_at DESC LIMIT ?`, ...scopes, maxItems).map((row) => row.content);
  }

  promptContext(input: { core: string[]; items: MemoryRecord[] }, maxBytes = this.retention.maxPromptBytes): { core: string[]; items: MemoryRecord[] } {
    const budget = Math.max(1, maxBytes);
    let used = 0;
    const append = (value: string): string | undefined => {
      const remaining = budget - used;
      if (remaining <= 0) return undefined;
      const text = truncateUtf8(value, remaining);
      if (!text) return undefined;
      used += Buffer.byteLength(text, "utf8");
      return text;
    };
    const core: string[] = [];
    for (const value of input.core) {
      const bounded = append(value);
      if (bounded) core.push(bounded);
      if (used >= budget) return { core, items: [] };
    }
    const items: MemoryRecord[] = [];
    for (const item of input.items) {
      const content = append(item.content);
      if (!content) break;
      items.push({ ...item, content });
      if (used >= budget) break;
    }
    return { core, items };
  }

  getMemory(id: string, access: MemoryAccessContext): MemoryRecord | null {
    if (this.db.get("SELECT 1 AS found FROM memory_tombstones WHERE id=? AND mode='hide'", id)) return null;
    const explicit = this.db.get<{ id: string; scope: MemoryScope; content: string; provenance_json: string }>("SELECT id,scope,content,provenance_json FROM memory_explicit WHERE id=?", id);
    if (explicit) { this.assertScope(access, explicit.scope); return { id, type: "explicit", scope: explicit.scope, content: explicit.content, provenance: JSON.parse(explicit.provenance_json) as string[] }; }
    const episode = this.db.get<{ id: string; scope: MemoryScope; content: string; occurred_at: string; source_json: string }>("SELECT id,scope,content,occurred_at,source_json FROM memory_episodes WHERE id=?", id);
    if (episode) { this.assertScope(access, episode.scope); return { id, type: "episode", scope: episode.scope, content: episode.content, occurredAt: episode.occurred_at, provenance: sourceProvenance(episode.source_json) }; }
    const fact = this.db.get<{ id: string; scope: MemoryScope; subject: string; predicate: string; object_json: string; provenance_json: string; confidence: number; valid_from: string | null; valid_to: string | null; status: MemoryRecord["status"] }>("SELECT id,scope,subject,predicate,object_json,provenance_json,confidence,valid_from,valid_to,status FROM memory_facts WHERE id=? AND status IN ('active','disputed')", id);
    if (fact) { this.assertScope(access, fact.scope); return { id, type: "fact", scope: fact.scope, content: `${fact.subject} ${fact.predicate} ${fact.object_json}`, provenance: JSON.parse(fact.provenance_json) as string[], status: fact.status, confidence: fact.confidence, ...(fact.valid_from ? { validFrom: fact.valid_from } : {}), ...(fact.valid_to ? { validTo: fact.valid_to } : {}) }; }
    const episodic = this.db.get<{ id: string; scope: MemoryScope; situation: string; action: string | null; outcome: string | null; lesson: string | null; occurred_at: string | null; provenance_json: string }>("SELECT id,scope,situation,action,outcome,lesson,occurred_at,provenance_json FROM memory_episodic WHERE id=?", id);
    if (episodic) { this.assertScope(access, episodic.scope); return { id, type: "episodic", scope: episodic.scope, content: [episodic.situation, episodic.action, episodic.outcome, episodic.lesson].filter(Boolean).join("\n"), occurredAt: episodic.occurred_at ?? undefined, provenance: JSON.parse(episodic.provenance_json) as string[] }; }
    return null;
  }

  forget(input: { id: string; access: MemoryAccessContext; mode?: "hide" | "supersede" | "delete" | "purge"; purge?: boolean }): { deleted: boolean; mode?: string } {
    const record = this.getMemory(input.id, input.access);
    if (!record) return { deleted: false };
    const mode = input.mode ?? (input.purge ? "purge" : "delete");
    const timestamp = nowIso();
    this.db.transaction(() => {
      this.db.run("INSERT OR REPLACE INTO memory_tombstones(id,record_type,scope,deleted_at,mode) VALUES (?,?,?,?,?)", input.id, record.type, record.scope, timestamp, mode);
      if (mode === "hide") {
        this.db.run("DELETE FROM memory_fts WHERE record_id=?", input.id);
      } else if (mode === "supersede" && record.type === "fact") {
        this.db.run("UPDATE memory_facts SET status='superseded',valid_to=?,updated_at=? WHERE id=?", timestamp, timestamp, input.id);
        this.enqueueIndex(input.id, record.type, record.scope, "", "DELETE");
      } else if (mode === "purge" || record.type === "fact") {
        if (record.type === "explicit") this.db.run("DELETE FROM memory_explicit WHERE id=?", input.id);
        else if (record.type === "episode") { this.db.run("DELETE FROM memory_episodes WHERE id=?", input.id); this.db.run("DELETE FROM memory_inbox WHERE episode_id=?", input.id); }
        else if (record.type === "fact") this.db.run("DELETE FROM memory_facts WHERE id=?", input.id);
        else if (record.type === "episodic") this.db.run("DELETE FROM memory_episodic WHERE id=?", input.id);
      } else if (record.type === "explicit") {
        this.db.run("DELETE FROM memory_explicit WHERE id=?", input.id);
      } else if (record.type === "episode") {
        this.db.run("DELETE FROM memory_episodes WHERE id=?", input.id);
        this.db.run("DELETE FROM memory_inbox WHERE episode_id=?", input.id);
      } else if (record.type === "episodic") {
        this.db.run("DELETE FROM memory_episodic WHERE id=?", input.id);
      }
      if (mode !== "hide" && mode !== "supersede") this.removeProvenance(input.id);
      if (mode !== "hide" && !(mode === "supersede" && record.type === "fact")) this.enqueueIndex(input.id, record.type, record.scope, "", "DELETE");
      this.refreshProfiles(input.access);
    });
    return { deleted: true, ...(input.mode ? { mode } : {}) };
  }

  explain(id: string, access: MemoryAccessContext): MemoryExplanation | null {
    const record = this.getMemory(id, access);
    if (!record) return null;
    const sources = (record.provenance ?? []).flatMap((sourceId) => {
      const episode = this.db.get<{ id: string; scope: MemoryScope; source_json: string; actor_json: string | null; content: string; occurred_at: string; ingested_at: string; trust: MemoryEpisode["trust"]; metadata_json: string | null }>("SELECT id,scope,source_json,actor_json,content,occurred_at,ingested_at,trust,metadata_json FROM memory_episodes WHERE id=?", sourceId);
      if (!episode) return [];
      this.assertScope(access, episode.scope);
      return [{ id: episode.id, scope: episode.scope, source: JSON.parse(episode.source_json), ...(episode.actor_json ? { actor: JSON.parse(episode.actor_json) } : {}), content: episode.content, occurredAt: episode.occurred_at, ingestedAt: episode.ingested_at, trust: episode.trust, ...(episode.metadata_json ? { metadata: JSON.parse(episode.metadata_json) } : {}) } as MemoryEpisode];
    });
    return { record, sources };
  }

  consolidate(): { processed: number; failed: number } {
    const timestamp = nowIso();
    const rows = this.db.all<{ id: string; episode_id: string; retries: number }>("SELECT id,episode_id,retries FROM memory_inbox WHERE status IN ('pending','failed') AND retries<? AND (next_attempt_at IS NULL OR next_attempt_at<=?) ORDER BY created_at LIMIT 100", MAX_RETRIES, timestamp);
    let processed = 0;
    let failed = 0;
    for (const row of rows) {
      const claimed = this.db.run("UPDATE memory_inbox SET status='processing',updated_at=? WHERE id=? AND status IN ('pending','failed')", nowIso(), row.id);
      if (claimed.changes !== 1) continue;
      try {
        const episode = this.db.get<{ id: string; scope: MemoryScope; content: string; occurred_at: string; metadata_json: string | null }>("SELECT id,scope,content,occurred_at,metadata_json FROM memory_episodes WHERE id=?", row.episode_id);
        if (!episode) throw new Error("MEMORY_EPISODE_NOT_FOUND");
        const metadata = this.parseConsolidationMetadata(episode.metadata_json);
        this.db.transaction(() => {
          for (const fact of metadata.facts) this.upsertDerivedFact(episode.scope, fact, episode.id);
          const proposals = metadata.episodic.length ? metadata.episodic : [{ situation: episode.content.slice(0, 2000), lesson: "Derived from a conversation episode." }];
          for (const proposal of proposals) this.upsertDerivedEpisode(episode.scope, proposal, episode.id, episode.occurred_at);
          this.db.run("UPDATE memory_inbox SET status='done',next_attempt_at=NULL,last_error=NULL,updated_at=? WHERE id=?", nowIso(), row.id);
          this.refreshProfilesForScopes([episode.scope]);
        });
        processed++;
      } catch (error) {
        failed++;
        const retries = row.retries + 1;
        this.db.run("UPDATE memory_inbox SET status='failed',retries=?,next_attempt_at=?,last_error=?,updated_at=? WHERE id=?", retries, retryAt(retries), String(error).slice(0, 2000), nowIso(), row.id);
      }
    }
    this.drainIndexQueue();
    return { processed, failed };
  }

  rebuildDerivedIndexes(): { records: number } {
    this.db.transaction(() => {
      this.db.exec("DELETE FROM memory_fts; DELETE FROM memory_profiles;");
      this.db.run("DELETE FROM memory_index_queue");
      for (const row of this.db.all<{ id: string; scope: MemoryScope; content: string }>("SELECT id,scope,content FROM memory_episodes")) this.index(row.id, "episode", row.scope, row.content);
      for (const row of this.db.all<{ id: string; scope: MemoryScope; content: string }>("SELECT id,scope,content FROM memory_explicit")) this.index(row.id, "explicit", row.scope, row.content);
      for (const row of this.db.all<{ id: string; scope: MemoryScope; subject: string; predicate: string; object_json: string }>("SELECT id,scope,subject,predicate,object_json FROM memory_facts")) this.index(row.id, "fact", row.scope, `${row.subject} ${row.predicate} ${row.object_json}`);
      for (const row of this.db.all<{ id: string; scope: MemoryScope; situation: string; action: string | null; outcome: string | null; lesson: string | null }>("SELECT id,scope,situation,action,outcome,lesson FROM memory_episodic")) this.index(row.id, "episodic", row.scope, [row.situation, row.action, row.outcome, row.lesson].filter(Boolean).join("\n"));
      const scopes = this.db.all<{ scope: MemoryScope }>("SELECT scope FROM memory_episodes UNION SELECT scope FROM memory_facts UNION SELECT scope FROM memory_episodic UNION SELECT scope FROM memory_explicit").map((row) => row.scope);
      this.refreshProfilesForScopes(scopes);
    });
    return { records: Number(this.db.get<{ count: number }>("SELECT count(*) AS count FROM memory_fts")?.count ?? 0) };
  }

  drainIndexQueue(): { processed: number; failed: number } {
    const timestamp = nowIso();
    const rows = this.db.all<{ id: string; record_id: string; record_type: string; scope: string; operation: "UPSERT" | "DELETE"; content: string | null; retries: number }>("SELECT id,record_id,record_type,scope,operation,content,retries FROM memory_index_queue WHERE status IN ('pending','failed') AND retries<? AND (next_attempt_at IS NULL OR next_attempt_at<=?) ORDER BY created_at LIMIT 100", MAX_RETRIES, timestamp);
    let processed = 0;
    let failed = 0;
    for (const row of rows) {
      const claimed = this.db.run("UPDATE memory_index_queue SET status='processing',updated_at=? WHERE id=? AND status IN ('pending','failed')", nowIso(), row.id);
      if (claimed.changes !== 1) continue;
      try {
        this.db.transaction(() => {
          if (row.operation === "DELETE") this.db.run("DELETE FROM memory_fts WHERE record_id=?", row.record_id);
          else this.index(row.record_id, row.record_type, row.scope, row.content ?? "");
          this.db.run("UPDATE memory_index_queue SET status='done',next_attempt_at=NULL,last_error=NULL,updated_at=? WHERE id=?", nowIso(), row.id);
        });
        processed++;
      } catch (error) {
        failed++;
        const retries = row.retries + 1;
        this.db.run("UPDATE memory_index_queue SET status='failed',retries=?,next_attempt_at=?,last_error=?,updated_at=? WHERE id=?", retries, retryAt(retries), String(error).slice(0, 2000), nowIso(), row.id);
      }
    }
    return { processed, failed };
  }

  exportMemory(access?: MemoryAccessContext): MemoryExport {
    const context = access ?? { requesterId: "system", trust: "OWNER" as const, allowedScopes: ["owner_private", "global_agent"] as MemoryScope[] };
    const scopes = this.authorizedScopes(context);
    if (!scopes.length) return { manifest: { format: "agent-memory", version: 1, exportedAt: nowIso(), counts: { episodes: 0, facts: 0, episodic: 0, explicit: 0, profile: 0 } }, episodes: [], facts: [], episodic: [], explicit: [], profile: [] };
    const placeholders = scopes.map(() => "?").join(",");
    const episodes = this.db.all<Record<string, unknown>>(`SELECT * FROM memory_episodes WHERE scope IN (${placeholders})`, ...scopes).map((row) => ({ id: row.id as string, scope: row.scope as MemoryScope, source: JSON.parse(row.source_json as string), ...(row.actor_json ? { actor: JSON.parse(row.actor_json as string) } : {}), content: row.content as string, occurredAt: row.occurred_at as string, ingestedAt: row.ingested_at as string, trust: row.trust as MemoryEpisode["trust"], ...(row.metadata_json ? { metadata: JSON.parse(row.metadata_json as string) } : {}) }));
    const facts = this.db.all<Record<string, unknown>>(`SELECT * FROM memory_facts WHERE scope IN (${placeholders})`, ...scopes).map((row) => ({ id: row.id, scope: row.scope, subject: row.subject, predicate: row.predicate, object: JSON.parse(row.object_json as string), confidence: row.confidence, validity: { ...(row.valid_from ? { validFrom: row.valid_from } : {}), ...(row.valid_to ? { validTo: row.valid_to } : {}) }, status: row.status, provenance: JSON.parse(row.provenance_json as string), createdAt: row.created_at, updatedAt: row.updated_at }));
    const episodic = this.db.all<Record<string, unknown>>(`SELECT * FROM memory_episodic WHERE scope IN (${placeholders})`, ...scopes).map((row) => ({ id: row.id, scope: row.scope, situation: row.situation, ...(row.action ? { action: row.action } : {}), ...(row.outcome ? { outcome: row.outcome } : {}), ...(row.lesson ? { lesson: row.lesson } : {}), provenance: JSON.parse(row.provenance_json as string), ...(row.occurred_at ? { occurredAt: row.occurred_at } : {}), ...(row.importance !== null ? { importance: row.importance } : {}), createdAt: row.created_at, updatedAt: row.updated_at }));
    const explicit = this.db.all<Record<string, unknown>>(`SELECT * FROM memory_explicit WHERE scope IN (${placeholders})`, ...scopes).map((row) => ({ id: row.id, scope: row.scope, content: row.content, provenance: JSON.parse(row.provenance_json as string), createdAt: row.created_at, updatedAt: row.updated_at }));
    const profile = this.db.all<Record<string, unknown>>(`SELECT * FROM memory_profiles WHERE scope IN (${placeholders})`, ...scopes).map((row) => ({ id: row.id, scope: row.scope, label: row.label, content: row.content, sourceMemoryIds: JSON.parse(row.source_memory_ids_json as string), generatedAt: row.generated_at, version: row.version }));
    return { manifest: { format: "agent-memory", version: 1, exportedAt: nowIso(), counts: { episodes: episodes.length, facts: facts.length, episodic: episodic.length, explicit: explicit.length, profile: profile.length } }, episodes, facts, episodic, explicit, profile };
  }

  exportMemoryJsonl(access?: MemoryAccessContext): MemoryJsonlExport {
    const structured = this.exportMemory(access);
    const files = {
      episodes: toJsonl(structured.episodes),
      facts: toJsonl(structured.facts),
      episodic: toJsonl(structured.episodic),
      explicit: toJsonl(structured.explicit),
      profile: toJsonl(structured.profile),
    };
    const checksums = Object.fromEntries(Object.entries(files).map(([name, content]) => [`${name}.jsonl`, sha256(content)]));
    return { manifest: { ...structured.manifest, source: "agent-home", checksums }, ...files };
  }

  importMemoryJsonl(input: MemoryJsonlExport, access?: MemoryAccessContext): { imported: number; counts: Record<string, number> } {
    if (input.manifest?.format !== "agent-memory" || input.manifest.version !== 1 || input.manifest.source !== "agent-home" || !input.manifest.checksums || typeof input.manifest.checksums !== "object" || !input.manifest.counts || typeof input.manifest.counts !== "object") throw new Error("MEMORY_IMPORT_VERSION_UNSUPPORTED");
    const files = { episodes: input.episodes, facts: input.facts, episodic: input.episodic, explicit: input.explicit, profile: input.profile };
    for (const [name, content] of Object.entries(files)) {
      if (typeof content !== "string" || typeof input.manifest.checksums[`${name}.jsonl`] !== "string" || sha256(content) !== input.manifest.checksums[`${name}.jsonl`]) throw new Error(`MEMORY_IMPORT_CHECKSUM_INVALID:${name}`);
    }
    const parsed = Object.fromEntries(Object.entries(files).map(([name, content]) => [name, parseJsonl(content, name)])) as Record<keyof typeof files, unknown[]>;
    for (const [name, records] of Object.entries(parsed)) {
      const expected = input.manifest.counts[name];
      if (expected !== undefined && expected !== records.length) throw new Error(`MEMORY_IMPORT_COUNT_INVALID:${name}`);
    }
    const structured: MemoryExport = {
      manifest: { format: "agent-memory", version: 1, exportedAt: input.manifest.exportedAt, counts: input.manifest.counts },
      episodes: parsed.episodes as MemoryEpisode[],
      facts: parsed.facts as Array<Record<string, unknown>>,
      episodic: parsed.episodic as Array<Record<string, unknown>>,
      explicit: parsed.explicit as Array<Record<string, unknown>>,
      profile: parsed.profile as Array<Record<string, unknown>>,
    };
    return { imported: this.importMemory(structured, access).imported, counts: input.manifest.counts };
  }

  importMemory(input: MemoryExport, access?: MemoryAccessContext): { imported: number } {
    if (input.manifest?.format !== "agent-memory" || input.manifest.version !== 1) throw new Error("MEMORY_IMPORT_VERSION_UNSUPPORTED");
    validateImportRecords(input, access, (scope) => this.assertScope(access!, scope));
    let imported = 0;
    this.db.transaction(() => {
      for (const episode of input.episodes ?? []) {
        if (access) this.assertScope(access, episode.scope);
        const inserted = this.db.run("INSERT OR IGNORE INTO memory_episodes(id,scope,source_json,actor_json,content,occurred_at,ingested_at,trust,metadata_json) VALUES (?,?,?,?,?,?,?,?,?)", episode.id, episode.scope, JSON.stringify(episode.source), episode.actor ? JSON.stringify(episode.actor) : null, episode.content, episode.occurredAt, episode.ingestedAt, episode.trust, episode.metadata ? JSON.stringify(episode.metadata) : null);
        if (inserted.changes > 0) imported += 1;
        this.db.run("INSERT OR IGNORE INTO memory_inbox(id,episode_id,status,retries,created_at,updated_at) VALUES (?,?,?,?,?,?)", `inbox-${episode.id}`, episode.id, "pending", 0, episode.ingestedAt, nowIso());
      }
      for (const fact of input.facts ?? []) {
        const scope = fact.scope as MemoryScope; if (access) this.assertScope(access, scope);
        const validity = (fact.validity as Record<string, unknown> | undefined) ?? {};
        const objectJson = "object" in fact ? JSON.stringify(fact.object) : String(fact.object_json ?? "null");
        const provenance = "provenance" in fact ? JSON.stringify(fact.provenance ?? []) : String(fact.provenance_json ?? "[]");
        const inserted = this.db.run("INSERT OR IGNORE INTO memory_facts(id,scope,subject,predicate,object_json,confidence,valid_from,valid_to,status,provenance_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", fact.id as string, scope, fact.subject as string, fact.predicate as string, objectJson, fact.confidence as number, (validity.validFrom ?? fact.valid_from ?? null) as string | null, (validity.validTo ?? fact.valid_to ?? null) as string | null, fact.status as string, provenance, (fact.createdAt ?? fact.created_at) as string, (fact.updatedAt ?? fact.updated_at) as string); if (inserted.changes > 0) imported += 1;
      }
      for (const episodic of input.episodic ?? []) {
        const scope = episodic.scope as MemoryScope; if (access) this.assertScope(access, scope);
        const inserted = this.db.run("INSERT OR IGNORE INTO memory_episodic(id,scope,situation,action,outcome,lesson,provenance_json,occurred_at,importance,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)", episodic.id as string, scope, episodic.situation as string, episodic.action as string | null, episodic.outcome as string | null, episodic.lesson as string | null, JSON.stringify(episodic.provenance ?? (episodic.provenance_json ? JSON.parse(episodic.provenance_json as string) : [])), (episodic.occurredAt ?? episodic.occurred_at ?? null) as string | null, episodic.importance as number | null, (episodic.createdAt ?? episodic.created_at) as string, (episodic.updatedAt ?? episodic.updated_at) as string); if (inserted.changes > 0) imported += 1;
      }
      for (const explicit of input.explicit ?? []) {
        const scope = explicit.scope as MemoryScope; if (access) this.assertScope(access, scope);
        const inserted = this.db.run("INSERT OR IGNORE INTO memory_explicit(id,scope,content,provenance_json,created_at,updated_at) VALUES (?,?,?,?,?,?)", explicit.id as string, scope, explicit.content as string, JSON.stringify(explicit.provenance ?? (explicit.provenance_json ? JSON.parse(explicit.provenance_json as string) : [])), (explicit.createdAt ?? explicit.created_at) as string, (explicit.updatedAt ?? explicit.updated_at) as string); if (inserted.changes > 0) imported += 1;
      }
    });
    this.rebuildDerivedIndexes();
    return { imported };
  }

  private authorizedScopes(access: MemoryAccessContext): MemoryScope[] {
    if (!access.requesterId || !["OWNER", "GUEST"].includes(access.trust) || !Array.isArray(access.allowedScopes)) throw new Error("MEMORY_ACCESS_INVALID");
    const principalScope = access.principalId ?? access.requesterId;
    const canonical: MemoryScope[] = [`user:${principalScope}`, ...((access.projectIds ?? []).filter((id) => typeof id === "string" && id).map((id) => `project:${id}` as MemoryScope))];
    if (access.trust === "OWNER") canonical.push("global_agent");
    if (this.owners.length && access.conversationId) {
      const conversation = this.db.get<{ kind: "private" | "group"; trust: "OWNER" | "GUEST" }>("SELECT kind,trust FROM conversations WHERE conversation_id=?", access.conversationId);
      const isOwner = access.principalId ? access.principalId === "principal:owner" : this.owners.some((owner) => access.requesterId === owner.userId);
      if (conversation?.kind === "private" && conversation.trust === "OWNER" && access.trust === "OWNER" && isOwner) canonical.push("owner_private");
    }
    return canonical.filter((scope) => access.allowedScopes.includes(scope));
  }

  private resolveLegacyEpisodePrincipal(sourceJson: string, actorJson: string | null): string | undefined {
    let source: Record<string, unknown> = {};
    let actor: Record<string, unknown> = {};
    try { source = JSON.parse(sourceJson) as Record<string, unknown>; } catch { /* quarantine below */ }
    try { actor = actorJson ? JSON.parse(actorJson) as Record<string, unknown> : {}; } catch { /* quarantine below */ }
    const eventId = typeof source.sourceId === "string" ? source.sourceId : undefined;
    if (eventId) {
      const row = this.db.get<{ envelope_json: string }>("SELECT envelope_json FROM ingress_events WHERE event_id=?", eventId);
      if (row) {
        try {
          const envelope = JSON.parse(row.envelope_json) as { source?: { platform?: string; accountId?: string }; trustedIdentity?: { userId?: string; principalId?: string } };
          if (envelope.trustedIdentity?.principalId) {
            const principal = this.db.get<{ principal_id: string }>("SELECT principal_id FROM principals WHERE principal_id=?", envelope.trustedIdentity.principalId);
            if (principal) return principal.principal_id;
          }
          if (envelope.source?.platform && envelope.source.accountId && envelope.trustedIdentity?.userId) {
            const identity = this.db.get<{ principal_id: string }>("SELECT principal_id FROM platform_identities WHERE platform=? AND account_id=? AND user_id=?", envelope.source.platform, envelope.source.accountId, envelope.trustedIdentity.userId);
            if (identity) return identity.principal_id;
          }
        } catch { /* quarantine below */ }
      }
    }
    const platform = typeof source.platform === "string" ? source.platform : undefined;
    const userId = typeof actor.id === "string" ? actor.id : undefined;
    if (platform && userId) {
      const identities = this.db.all<{ principal_id: string }>("SELECT DISTINCT principal_id FROM platform_identities WHERE platform=? AND user_id=?", platform, userId);
      if (identities.length === 1) return identities[0]?.principal_id;
    }
    return undefined;
  }

  private assertScope(access: MemoryAccessContext, scope: MemoryScope): void {
    if (!this.authorizedScopes(access).includes(scope)) throw new Error(`MEMORY_SCOPE_DENIED:${scope}`);
  }

  private index(id: string, type: string, scope: string, content: string): void { this.db.run("INSERT OR REPLACE INTO memory_fts(record_id,record_type,scope,content) VALUES (?,?,?,?)", id, type, scope, content); }

  private enqueueIndex(recordId: string, recordType: string, scope: string, content: string, operation: "UPSERT" | "DELETE"): void {
    const timestamp = nowIso();
    this.db.run("UPDATE memory_index_queue SET status='done',last_error='SUPERSEDED',updated_at=? WHERE record_id=? AND status IN ('pending','processing','failed')", timestamp, recordId);
    this.db.run("INSERT INTO memory_index_queue(id,record_id,record_type,scope,operation,content,status,retries,created_at,updated_at) VALUES (?,?,?,?,?,?,?,0,?,?)", newId("memory-index"), recordId, recordType, scope, operation, operation === "UPSERT" ? content : null, "pending", timestamp, timestamp);
  }

  private removeProvenance(recordId: string): void {
    for (const row of this.db.all<{ id: string; scope: MemoryScope; provenance_json: string }>("SELECT id,scope,provenance_json FROM memory_facts")) {
      const provenance = (JSON.parse(row.provenance_json) as string[]).filter((item) => item !== recordId);
        if (provenance.length === 0) { this.db.run("DELETE FROM memory_facts WHERE id=?", row.id); this.enqueueIndex(row.id, "fact", row.scope, "", "DELETE"); }
      else if (provenance.length !== (JSON.parse(row.provenance_json) as string[]).length) this.db.run("UPDATE memory_facts SET provenance_json=?,updated_at=? WHERE id=?", JSON.stringify(provenance), nowIso(), row.id);
    }
    for (const row of this.db.all<{ id: string; scope: MemoryScope; provenance_json: string }>("SELECT id,scope,provenance_json FROM memory_episodic")) {
      const provenance = (JSON.parse(row.provenance_json) as string[]).filter((item) => item !== recordId);
        if (provenance.length === 0) { this.db.run("DELETE FROM memory_episodic WHERE id=?", row.id); this.enqueueIndex(row.id, "episodic", row.scope, "", "DELETE"); }
      else if (provenance.length !== (JSON.parse(row.provenance_json) as string[]).length) this.db.run("UPDATE memory_episodic SET provenance_json=?,updated_at=? WHERE id=?", JSON.stringify(provenance), nowIso(), row.id);
    }
  }

  private refreshProfiles(access: MemoryAccessContext): void {
    this.refreshProfilesForScopes(this.authorizedScopes(access));
  }

  private refreshProfilesForScopes(scopes: MemoryScope[]): void {
    const timestamp = nowIso();
    for (const scope of [...new Set(scopes)]) {
       const explicitRows = this.db.all<{ id: string; content: string }>("SELECT id,content FROM memory_explicit WHERE scope=? AND NOT EXISTS (SELECT 1 FROM memory_tombstones t WHERE t.id=memory_explicit.id AND t.mode='hide') ORDER BY updated_at DESC LIMIT 20", scope);
       const explicit = explicitRows.map((row) => row.content);
       const facts = this.db.all<{ id: string; subject: string; predicate: string; object_json: string }>("SELECT id,subject,predicate,object_json FROM memory_facts WHERE scope=? AND status='active' AND NOT EXISTS (SELECT 1 FROM memory_tombstones t WHERE t.id=memory_facts.id AND t.mode='hide') ORDER BY confidence DESC LIMIT 20", scope).map((row) => `${row.subject} ${row.predicate} ${row.object_json}`);
       const content = [...explicit, ...facts].join("\n");
       const sourceIds = [...explicitRows.map((row) => row.id), ...this.db.all<{ id: string }>("SELECT id FROM memory_facts WHERE scope=? AND status='active' AND NOT EXISTS (SELECT 1 FROM memory_tombstones t WHERE t.id=memory_facts.id AND t.mode='hide') ORDER BY confidence DESC LIMIT 20", scope).map((row) => row.id)];
      const version = Number(this.db.get<{ version: number }>("SELECT COALESCE(MAX(version),0) AS version FROM memory_profiles WHERE scope=?", scope)?.version ?? 0) + 1;
      this.db.run("DELETE FROM memory_profiles WHERE scope=?", scope);
      if (content) {
         this.db.run("INSERT INTO memory_profiles(id,scope,label,content,source_memory_ids_json,generated_at,version) VALUES (?,?,?,?,?,?,?)", newId("profile"), scope, "context", content, JSON.stringify(sourceIds), timestamp, version);
      }
    }
  }

  private parseConsolidationMetadata(metadataJson: string | null): { facts: FactProposal[]; episodic: EpisodicProposal[] } {
    if (!metadataJson) return { facts: [], episodic: [] };
    try {
      const value = JSON.parse(metadataJson) as { facts?: unknown; episodic?: unknown };
      const facts = Array.isArray(value.facts) ? value.facts.filter((item): item is FactProposal => Boolean(item && typeof item === "object" && typeof (item as Record<string, unknown>).subject === "string" && typeof (item as Record<string, unknown>).predicate === "string" && "object" in (item as Record<string, unknown>))).map((item) => ({ subject: item.subject, predicate: item.predicate, object: item.object, ...(typeof item.confidence === "number" ? { confidence: item.confidence } : {}), ...(typeof item.validFrom === "string" ? { validFrom: item.validFrom } : {}) })) : [];
      const episodic = Array.isArray(value.episodic) ? value.episodic.filter((item): item is EpisodicProposal => Boolean(item && typeof item === "object" && typeof (item as Record<string, unknown>).situation === "string")).map((item) => ({ situation: item.situation, ...(typeof item.action === "string" ? { action: item.action } : {}), ...(typeof item.outcome === "string" ? { outcome: item.outcome } : {}), ...(typeof item.lesson === "string" ? { lesson: item.lesson } : {}), ...(typeof item.importance === "number" ? { importance: item.importance } : {}) })) : [];
      return { facts, episodic };
    } catch { return { facts: [], episodic: [] }; }
  }

  private upsertDerivedFact(scope: MemoryScope, proposal: FactProposal, episodeId: string): void {
    const timestamp = nowIso();
    const objectJson = JSON.stringify(proposal.object);
    const existing = this.db.get<{ id: string; object_json: string; provenance_json: string; confidence: number }>("SELECT id,object_json,provenance_json,confidence FROM memory_facts WHERE scope=? AND subject=? AND predicate=? AND status IN ('active','disputed') ORDER BY updated_at DESC LIMIT 1", scope, proposal.subject, proposal.predicate);
    if (existing && existing.object_json === objectJson) {
      const provenance = [...new Set([...(JSON.parse(existing.provenance_json) as string[]), episodeId])];
      this.db.run("UPDATE memory_facts SET confidence=?,provenance_json=?,updated_at=? WHERE id=?", Math.max(existing.confidence, proposal.confidence ?? 0.5), JSON.stringify(provenance), timestamp, existing.id);
      this.index(existing.id, "fact", scope, `${proposal.subject} ${proposal.predicate} ${objectJson}`);
      return;
    }
    if (existing) this.db.run("UPDATE memory_facts SET status=?,valid_to=?,updated_at=? WHERE id=?", proposal.validFrom ? "superseded" : "disputed", proposal.validFrom ?? timestamp, timestamp, existing.id);
    const id = newId("fact");
    this.db.run("INSERT INTO memory_facts(id,scope,subject,predicate,object_json,confidence,valid_from,status,provenance_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)", id, scope, proposal.subject, proposal.predicate, objectJson, Math.max(0, Math.min(1, proposal.confidence ?? 0.5)), proposal.validFrom ?? timestamp, "active", JSON.stringify([episodeId]), timestamp, timestamp);
    this.index(id, "fact", scope, `${proposal.subject} ${proposal.predicate} ${objectJson}`);
  }

  private upsertDerivedEpisode(scope: MemoryScope, proposal: EpisodicProposal, episodeId: string, occurredAt: string): void {
    const existing = this.db.get<{ id: string; provenance_json: string }>("SELECT id,provenance_json FROM memory_episodic WHERE scope=? AND situation=? AND COALESCE(action,'')=COALESCE(?, '') AND COALESCE(outcome,'')=COALESCE(?, '') AND COALESCE(lesson,'')=COALESCE(?, '') LIMIT 1", scope, proposal.situation, proposal.action ?? null, proposal.outcome ?? null, proposal.lesson ?? null);
    if (existing) {
      const provenance = [...new Set([...(JSON.parse(existing.provenance_json) as string[]), episodeId])];
      this.db.run("UPDATE memory_episodic SET provenance_json=?,updated_at=? WHERE id=?", JSON.stringify(provenance), nowIso(), existing.id);
      return;
    }
    const timestamp = nowIso();
    const id = newId("episodic");
    this.db.run("INSERT INTO memory_episodic(id,scope,situation,action,outcome,lesson,provenance_json,occurred_at,importance,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)", id, scope, proposal.situation, proposal.action ?? null, proposal.outcome ?? null, proposal.lesson ?? null, JSON.stringify([episodeId]), occurredAt, Math.max(0, Math.min(1, proposal.importance ?? 0.5)), timestamp, timestamp);
    this.index(id, "episodic", scope, [proposal.situation, proposal.action, proposal.outcome, proposal.lesson].filter(Boolean).join("\n"));
  }
}

function toJsonl(records: unknown[]): string {
  return records.length ? `${records.map((record) => JSON.stringify(record)).join("\n")}\n` : "";
}

function parseJsonl(content: string, name: string): unknown[] {
  const lines = content.split(/\r?\n/).filter((line) => line.length > 0);
  try {
    return lines.map((line) => {
      const value = JSON.parse(line) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("record must be an object");
      return value;
    });
  } catch (error) {
    throw new Error(`MEMORY_IMPORT_JSONL_INVALID:${name}:${String(error)}`);
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function temporalFilter(field: string, range: { from?: string; to?: string } | undefined, idField: string): { sql: string; args: string[] } {
  const clauses = [`AND NOT EXISTS (SELECT 1 FROM memory_tombstones t WHERE t.id=${idField} AND t.mode='hide')`];
  const args: string[] = [];
  if (range?.from) { clauses.push(`AND ${field} >= ?`); args.push(range.from); }
  if (range?.to) { clauses.push(`AND ${field} <= ?`); args.push(range.to); }
  return { sql: clauses.join(" "), args };
}

function factTemporalFilter(range: { from?: string; to?: string } | undefined, alias: string): { sql: string; args: string[] } {
  const clauses = [`AND NOT EXISTS (SELECT 1 FROM memory_tombstones t WHERE t.id=${alias}.id AND t.mode='hide')`];
  const args: string[] = [];
  if (range?.from) { clauses.push(`AND (${alias}.valid_to IS NULL OR ${alias}.valid_to >= ?)`); args.push(range.from); }
  if (range?.to) { clauses.push(`AND (${alias}.valid_from IS NULL OR ${alias}.valid_from <= ?)`); args.push(range.to); }
  return { sql: clauses.join(" "), args };
}

function sourceProvenance(sourceJson: string): string[] {
  try {
    const source = JSON.parse(sourceJson) as { sourceId?: unknown };
    return typeof source.sourceId === "string" && source.sourceId ? [source.sourceId] : [];
  } catch {
    return [];
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const suffix = maxBytes >= 3 ? "..." : "";
  const limit = Math.max(0, maxBytes - Buffer.byteLength(suffix, "utf8"));
  const characters = [...value];
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(characters.slice(0, middle).join(""), "utf8") <= limit) low = middle;
    else high = middle - 1;
  }
  return `${characters.slice(0, low).join("")}${suffix}`;
}

function retryAt(retries: number): string {
  const delay = RETRY_DELAYS_MS[Math.min(Math.max(retries - 1, 0), RETRY_DELAYS_MS.length - 1)] ?? 0;
  return new Date(Date.now() + delay).toISOString();
}

function validateImportRecords(input: MemoryExport, access: MemoryAccessContext | undefined, assertScope: (scope: MemoryScope) => void): void {
  if (!input || !Array.isArray(input.episodes) || !Array.isArray(input.facts) || !Array.isArray(input.episodic) || !Array.isArray(input.explicit) || !Array.isArray(input.profile)) throw new Error("MEMORY_IMPORT_RECORDS_INVALID");
  for (const episode of input.episodes) {
    if (!episode || typeof episode !== "object" || typeof episode.id !== "string" || !episode.id || !isMemoryScope(episode.scope) || !episode.source || typeof episode.source !== "object" || typeof episode.source.type !== "string" || typeof episode.content !== "string" || typeof episode.occurredAt !== "string" || typeof episode.ingestedAt !== "string" || !["owner", "guest", "system"].includes(episode.trust)) throw new Error("MEMORY_IMPORT_EPISODE_INVALID");
    if (access) assertScope(episode.scope);
  }
  for (const fact of input.facts) {
    if (!fact || typeof fact !== "object" || typeof fact.id !== "string" || !fact.id || !isMemoryScope(fact.scope) || typeof fact.subject !== "string" || typeof fact.predicate !== "string" || !("object" in fact || "object_json" in fact) || typeof fact.confidence !== "number" || !Number.isFinite(fact.confidence) || fact.confidence < 0 || fact.confidence > 1 || !["active", "superseded", "disputed", "deleted"].includes(String(fact.status))) throw new Error("MEMORY_IMPORT_FACT_INVALID");
    if (fact.provenance !== undefined && (!Array.isArray(fact.provenance) || fact.provenance.some((item) => typeof item !== "string"))) throw new Error("MEMORY_IMPORT_FACT_INVALID");
    if (access) assertScope(fact.scope);
  }
  for (const episodic of input.episodic) {
    if (!episodic || typeof episodic !== "object" || typeof episodic.id !== "string" || !episodic.id || !isMemoryScope(episodic.scope) || typeof episodic.situation !== "string" || (episodic.provenance !== undefined && (!Array.isArray(episodic.provenance) || episodic.provenance.some((item) => typeof item !== "string")))) throw new Error("MEMORY_IMPORT_EPISODIC_INVALID");
    if (access) assertScope(episodic.scope);
  }
  for (const explicit of input.explicit) {
    if (!explicit || typeof explicit !== "object" || typeof explicit.id !== "string" || !explicit.id || !isMemoryScope(explicit.scope) || typeof explicit.content !== "string" || (explicit.provenance !== undefined && (!Array.isArray(explicit.provenance) || explicit.provenance.some((item) => typeof item !== "string")))) throw new Error("MEMORY_IMPORT_EXPLICIT_INVALID");
    if (access) assertScope(explicit.scope);
  }
  for (const profile of input.profile) {
    if (!profile || typeof profile !== "object" || typeof profile.id !== "string" || !profile.id || !isMemoryScope(profile.scope) || typeof profile.content !== "string" || !Array.isArray(profile.sourceMemoryIds) || profile.sourceMemoryIds.some((item) => typeof item !== "string")) throw new Error("MEMORY_IMPORT_PROFILE_INVALID");
    if (access) assertScope(profile.scope);
  }
}

function isMemoryScope(value: unknown): value is MemoryScope {
  return typeof value === "string" && /^(global_agent|owner_private|user:[^\s]+|group:[^\s]+|project:[^\s]+)$/.test(value);
}
