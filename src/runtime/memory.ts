import type { SqliteStore } from "../db.js";
import { newId, nowIso } from "../shared/ids.js";
import type { JsonValue, MemoryScope } from "../shared/types.js";

export interface MemoryAccessContext {
  requesterId: string;
  trust: "OWNER" | "GUEST";
  allowedScopes: MemoryScope[];
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
}

export interface MemoryExport {
  manifest: { format: "agent-memory"; version: 1; exportedAt: string; counts: Record<string, number> };
  episodes: MemoryEpisode[];
  facts: Array<Record<string, unknown>>;
  episodic: Array<Record<string, unknown>>;
  explicit: Array<Record<string, unknown>>;
  profile: Array<Record<string, unknown>>;
}

export class MemoryService {
  private readonly db: SqliteStore;
  constructor(db: SqliteStore) { this.db = db; }

  ingestEpisode(input: Omit<MemoryEpisode, "id" | "ingestedAt">): MemoryEpisode {
    const episode: MemoryEpisode = { ...input, id: newId("episode"), ingestedAt: nowIso() };
    this.assertScope({ requesterId: "system", trust: input.trust === "owner" ? "OWNER" : "GUEST", allowedScopes: [input.scope] }, input.scope);
    this.db.transaction(() => {
      this.db.run("INSERT INTO memory_episodes(id,scope,source_json,actor_json,content,occurred_at,ingested_at,trust,metadata_json) VALUES (?,?,?,?,?,?,?,?,?)", episode.id, episode.scope, JSON.stringify(episode.source), episode.actor ? JSON.stringify(episode.actor) : null, episode.content, episode.occurredAt, episode.ingestedAt, episode.trust, episode.metadata ? JSON.stringify(episode.metadata) : null);
      this.db.run("INSERT INTO memory_inbox(id,episode_id,status,retries,created_at,updated_at) VALUES (?,?,?,?,?,?)", newId("inbox"), episode.id, "pending", 0, episode.ingestedAt, episode.ingestedAt);
      this.index(episode.id, "episode", episode.scope, episode.content);
    });
    return episode;
  }

  remember(input: { access: MemoryAccessContext; scope: MemoryScope; content: string; provenance?: string[] }): MemoryRecord {
    this.assertScope(input.access, input.scope);
    const id = newId("explicit");
    const timestamp = nowIso();
    const provenance = input.provenance ?? [];
    this.db.transaction(() => {
      this.db.run("INSERT INTO memory_explicit(id,scope,content,provenance_json,created_at,updated_at) VALUES (?,?,?,?,?,?)", id, input.scope, input.content, JSON.stringify(provenance), timestamp, timestamp);
      this.index(id, "explicit", input.scope, input.content);
      this.refreshProfiles(input.access);
    });
    return { id, type: "explicit", scope: input.scope, content: input.content, provenance };
  }

  rememberFact(input: { access: MemoryAccessContext; scope: MemoryScope; subject: string; predicate: string; object: JsonValue; confidence?: number; validFrom?: string; provenance?: string[] }): MemoryRecord {
    this.assertScope(input.access, input.scope);
    const timestamp = nowIso();
    const provenance = input.provenance ?? [];
    const objectJson = JSON.stringify(input.object);
    const existing = this.db.get<{ id: string; object_json: string; provenance_json: string; confidence: number }>("SELECT id,object_json,provenance_json,confidence FROM memory_facts WHERE scope=? AND subject=? AND predicate=? AND status='active' ORDER BY updated_at DESC LIMIT 1", input.scope, input.subject, input.predicate);
    let id: string;
    let returnedProvenance = provenance;
    this.db.transaction(() => {
      if (existing && existing.object_json === objectJson) {
        id = existing.id;
        const merged = [...new Set([...(JSON.parse(existing.provenance_json) as string[]), ...provenance])];
        returnedProvenance = merged;
        this.db.run("UPDATE memory_facts SET confidence=?,provenance_json=?,updated_at=? WHERE id=?", Math.max(existing.confidence, input.confidence ?? 0.5), JSON.stringify(merged), timestamp, id);
      } else {
        if (existing) this.db.run("UPDATE memory_facts SET status='superseded',valid_to=?,updated_at=? WHERE id=?", input.validFrom ?? timestamp, timestamp, existing.id);
        id = newId("fact");
        this.db.run("INSERT INTO memory_facts(id,scope,subject,predicate,object_json,confidence,valid_from,status,provenance_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)", id, input.scope, input.subject, input.predicate, objectJson, Math.max(0, Math.min(1, input.confidence ?? 0.5)), input.validFrom ?? timestamp, "active", JSON.stringify(provenance), timestamp, timestamp);
      }
      this.index(id, "fact", input.scope, `${input.subject} ${input.predicate} ${objectJson}`);
      this.refreshProfiles(input.access);
    });
    return { id: id!, type: "fact", scope: input.scope, content: `${input.subject} ${input.predicate} ${objectJson}`, provenance: returnedProvenance };
  }

  retrieve(input: { text: string; access: MemoryAccessContext; types?: Array<"fact" | "episode" | "explicit" | "episodic" | "raw">; limit?: number }): { items: MemoryRecord[]; core: string[] } {
    const scopes = this.authorizedScopes(input.access);
    if (scopes.length === 0) return { items: [], core: [] };
    const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
    const terms = input.text.trim().split(/\s+/).filter(Boolean).slice(0, 8);
    const like = `%${terms.join(" ")}%`;
    const placeholders = scopes.map(() => "?").join(",");
    const items: MemoryRecord[] = [];
    const include = (type: string) => !input.types || input.types.includes(type as never) || (type === "episode" && input.types.includes("raw"));
    if (include("explicit")) {
      const rows = this.db.all<{ id: string; scope: MemoryScope; content: string; provenance_json: string }>(`SELECT id,scope,content,provenance_json FROM memory_explicit WHERE scope IN (${placeholders}) AND content LIKE ? ORDER BY updated_at DESC LIMIT ?`, ...scopes, like, limit);
      items.push(...rows.map((row) => ({ id: row.id, type: "explicit" as const, scope: row.scope, content: row.content, provenance: JSON.parse(row.provenance_json) as string[] })));
    }
    if (include("fact")) {
      const rows = this.db.all<{ id: string; scope: MemoryScope; subject: string; predicate: string; object_json: string; provenance_json: string }>(`SELECT id,scope,subject,predicate,object_json,provenance_json FROM memory_facts WHERE scope IN (${placeholders}) AND status='active' AND (subject LIKE ? OR predicate LIKE ? OR object_json LIKE ?) ORDER BY confidence DESC,updated_at DESC LIMIT ?`, ...scopes, like, like, like, limit);
      items.push(...rows.map((row) => ({ id: row.id, type: "fact" as const, scope: row.scope, content: `${row.subject} ${row.predicate} ${JSON.parse(row.object_json) as string}`, provenance: JSON.parse(row.provenance_json) as string[] })));
    }
    if (include("episode")) {
      const rows = this.db.all<{ id: string; scope: MemoryScope; content: string; occurred_at: string }>(`SELECT id,scope,content,occurred_at FROM memory_episodes WHERE scope IN (${placeholders}) AND content LIKE ? ORDER BY occurred_at DESC LIMIT ?`, ...scopes, like, limit);
      items.push(...rows.map((row) => ({ id: row.id, type: "episode" as const, scope: row.scope, content: row.content, occurredAt: row.occurred_at })));
    }
    return { items: items.slice(0, limit), core: this.getCoreContext(input.access) };
  }

  getCoreContext(access: MemoryAccessContext, maxItems = 20): string[] {
    const scopes = this.authorizedScopes(access);
    if (!scopes.length) return [];
    const placeholders = scopes.map(() => "?").join(",");
    return this.db.all<{ content: string }>(`SELECT content FROM memory_profiles WHERE scope IN (${placeholders}) ORDER BY version DESC,generated_at DESC LIMIT ?`, ...scopes, maxItems).map((row) => row.content);
  }

  getMemory(id: string, access: MemoryAccessContext): MemoryRecord | null {
    const explicit = this.db.get<{ id: string; scope: MemoryScope; content: string; provenance_json: string }>("SELECT id,scope,content,provenance_json FROM memory_explicit WHERE id=?", id);
    if (explicit) { this.assertScope(access, explicit.scope); return { id, type: "explicit", scope: explicit.scope, content: explicit.content, provenance: JSON.parse(explicit.provenance_json) as string[] }; }
    const episode = this.db.get<{ id: string; scope: MemoryScope; content: string; occurred_at: string }>("SELECT id,scope,content,occurred_at FROM memory_episodes WHERE id=?", id);
    if (episode) { this.assertScope(access, episode.scope); return { id, type: "episode", scope: episode.scope, content: episode.content, occurredAt: episode.occurred_at }; }
    const fact = this.db.get<{ id: string; scope: MemoryScope; subject: string; predicate: string; object_json: string; provenance_json: string }>("SELECT id,scope,subject,predicate,object_json,provenance_json FROM memory_facts WHERE id=?", id);
    if (fact) { this.assertScope(access, fact.scope); return { id, type: "fact", scope: fact.scope, content: `${fact.subject} ${fact.predicate} ${fact.object_json}`, provenance: JSON.parse(fact.provenance_json) as string[] }; }
    return null;
  }

  forget(input: { id: string; access: MemoryAccessContext; purge?: boolean }): { deleted: boolean } {
    const record = this.getMemory(input.id, input.access);
    if (!record) return { deleted: false };
    this.db.transaction(() => {
      if (record.type === "explicit") this.db.run("DELETE FROM memory_explicit WHERE id=?", input.id);
      else if (record.type === "episode") this.db.run("DELETE FROM memory_episodes WHERE id=?", input.id);
      else if (record.type === "fact") this.db.run("DELETE FROM memory_facts WHERE id=?", input.id);
      this.db.run("DELETE FROM memory_fts WHERE record_id=?", input.id);
      if (record.type === "episode") this.db.run("DELETE FROM memory_inbox WHERE episode_id=?", input.id);
    });
    return { deleted: true };
  }

  explain(id: string, access: MemoryAccessContext): MemoryRecord | null { return this.getMemory(id, access); }

  consolidate(): { processed: number; failed: number } {
    const rows = this.db.all<{ id: string; episode_id: string }>("SELECT id,episode_id FROM memory_inbox WHERE status='pending' ORDER BY created_at LIMIT 100");
    let processed = 0;
    for (const row of rows) {
      try {
        this.db.transaction(() => { this.db.run("UPDATE memory_inbox SET status='done',updated_at=? WHERE id=?", nowIso(), row.id); });
        processed++;
      } catch { this.db.run("UPDATE memory_inbox SET status='failed',retries=retries+1,updated_at=? WHERE id=?", nowIso(), row.id); }
    }
    return { processed, failed: rows.length - processed };
  }

  rebuildDerivedIndexes(): { records: number } {
    this.db.transaction(() => {
      this.db.exec("DELETE FROM memory_fts; DELETE FROM memory_profiles;");
      for (const row of this.db.all<{ id: string; scope: MemoryScope; content: string }>("SELECT id,scope,content FROM memory_episodes")) this.index(row.id, "episode", row.scope, row.content);
      for (const row of this.db.all<{ id: string; scope: MemoryScope; content: string }>("SELECT id,scope,content FROM memory_explicit")) this.index(row.id, "explicit", row.scope, row.content);
      for (const row of this.db.all<{ id: string; scope: MemoryScope; subject: string; predicate: string; object_json: string }>("SELECT id,scope,subject,predicate,object_json FROM memory_facts")) this.index(row.id, "fact", row.scope, `${row.subject} ${row.predicate} ${row.object_json}`);
      for (const row of this.db.all<{ id: string; scope: MemoryScope; situation: string; action: string | null; outcome: string | null; lesson: string | null }>("SELECT id,scope,situation,action,outcome,lesson FROM memory_episodic")) this.index(row.id, "episodic", row.scope, [row.situation, row.action, row.outcome, row.lesson].filter(Boolean).join("\n"));
      this.refreshProfiles({ requesterId: "system", trust: "OWNER", allowedScopes: ["owner_private", "global_agent"] });
    });
    return { records: Number(this.db.get<{ count: number }>("SELECT count(*) AS count FROM memory_fts")?.count ?? 0) };
  }

  exportMemory(access?: MemoryAccessContext): MemoryExport {
    const context = access ?? { requesterId: "system", trust: "OWNER" as const, allowedScopes: ["owner_private", "global_agent"] as MemoryScope[] };
    const scopes = this.authorizedScopes(context);
    const placeholders = scopes.map(() => "?").join(",");
    const episodes = this.db.all<Record<string, unknown>>(`SELECT * FROM memory_episodes WHERE scope IN (${placeholders})`, ...scopes).map((row) => ({ id: row.id as string, scope: row.scope as MemoryScope, source: JSON.parse(row.source_json as string), ...(row.actor_json ? { actor: JSON.parse(row.actor_json as string) } : {}), content: row.content as string, occurredAt: row.occurred_at as string, ingestedAt: row.ingested_at as string, trust: row.trust as MemoryEpisode["trust"], ...(row.metadata_json ? { metadata: JSON.parse(row.metadata_json as string) } : {}) }));
    const facts = this.db.all<Record<string, unknown>>(`SELECT * FROM memory_facts WHERE scope IN (${placeholders})`, ...scopes);
    const episodic = this.db.all<Record<string, unknown>>(`SELECT * FROM memory_episodic WHERE scope IN (${placeholders})`, ...scopes);
    const explicit = this.db.all<Record<string, unknown>>(`SELECT * FROM memory_explicit WHERE scope IN (${placeholders})`, ...scopes);
    const profile = this.db.all<Record<string, unknown>>(`SELECT * FROM memory_profiles WHERE scope IN (${placeholders})`, ...scopes);
    return { manifest: { format: "agent-memory", version: 1, exportedAt: nowIso(), counts: { episodes: episodes.length, facts: facts.length, episodic: episodic.length, explicit: explicit.length } }, episodes, facts, episodic, explicit, profile };
  }

  importMemory(input: MemoryExport): { imported: number } {
    if (input.manifest?.format !== "agent-memory" || input.manifest.version !== 1) throw new Error("MEMORY_IMPORT_VERSION_UNSUPPORTED");
    let imported = 0;
    this.db.transaction(() => {
      for (const episode of input.episodes ?? []) {
        this.db.run("INSERT OR IGNORE INTO memory_episodes(id,scope,source_json,actor_json,content,occurred_at,ingested_at,trust,metadata_json) VALUES (?,?,?,?,?,?,?,?,?)", episode.id, episode.scope, JSON.stringify(episode.source), episode.actor ? JSON.stringify(episode.actor) : null, episode.content, episode.occurredAt, episode.ingestedAt, episode.trust, episode.metadata ? JSON.stringify(episode.metadata) : null);
        imported += 1;
      }
      for (const fact of input.facts ?? []) { this.db.run("INSERT OR IGNORE INTO memory_facts(id,scope,subject,predicate,object_json,confidence,valid_from,valid_to,status,provenance_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", fact.id as string, fact.scope as string, fact.subject as string, fact.predicate as string, fact.object_json as string, fact.confidence as number, fact.valid_from as string | null, fact.valid_to as string | null, fact.status as string, fact.provenance_json as string, fact.created_at as string, fact.updated_at as string); imported += 1; }
      for (const episodic of input.episodic ?? []) { this.db.run("INSERT OR IGNORE INTO memory_episodic(id,scope,situation,action,outcome,lesson,provenance_json,occurred_at,importance,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)", episodic.id as string, episodic.scope as string, episodic.situation as string, episodic.action as string | null, episodic.outcome as string | null, episodic.lesson as string | null, episodic.provenance_json as string, episodic.occurred_at as string | null, episodic.importance as number | null, episodic.created_at as string, episodic.updated_at as string); imported += 1; }
      for (const explicit of input.explicit ?? []) { this.db.run("INSERT OR IGNORE INTO memory_explicit(id,scope,content,provenance_json,created_at,updated_at) VALUES (?,?,?,?,?,?)", explicit.id as string, explicit.scope as string, explicit.content as string, explicit.provenance_json as string, explicit.created_at as string, explicit.updated_at as string); imported += 1; }
    });
    this.rebuildDerivedIndexes();
    return { imported };
  }

  private authorizedScopes(access: MemoryAccessContext): MemoryScope[] {
    if (access.trust === "GUEST") return access.allowedScopes.filter((scope) => scope !== "owner_private");
    return [...new Set(access.allowedScopes)];
  }

  private assertScope(access: MemoryAccessContext, scope: MemoryScope): void {
    if (!this.authorizedScopes(access).includes(scope)) throw new Error(`MEMORY_SCOPE_DENIED:${scope}`);
  }

  private index(id: string, type: string, scope: string, content: string): void { this.db.run("INSERT OR REPLACE INTO memory_fts(record_id,record_type,scope,content) VALUES (?,?,?,?)", id, type, scope, content); }

  private refreshProfiles(access: MemoryAccessContext): void {
    const timestamp = nowIso();
    for (const scope of this.authorizedScopes(access)) {
      const explicit = this.db.all<{ content: string }>("SELECT content FROM memory_explicit WHERE scope=? ORDER BY updated_at DESC LIMIT 20", scope).map((row) => row.content);
      const facts = this.db.all<{ subject: string; predicate: string; object_json: string }>("SELECT subject,predicate,object_json FROM memory_facts WHERE scope=? AND status='active' ORDER BY confidence DESC LIMIT 20", scope).map((row) => `${row.subject} ${row.predicate} ${row.object_json}`);
      const content = [...explicit, ...facts].join("\n");
      if (content) this.db.run("INSERT INTO memory_profiles(id,scope,label,content,source_memory_ids_json,generated_at,version) VALUES (?,?,?,?,?,?,?)", newId("profile"), scope, "context", content, "[]", timestamp, 1);
    }
  }
}
