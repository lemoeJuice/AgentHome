# Memory System Design

> 独立记忆系统设计文档  
> 适用于 Agent Home，但不依赖 Agent Home 的其他内部实现  
> 目标：长期可迁移、可解释、可演化、低耦合的个人 Agent Memory

---

# 1. 设计目标

记忆系统是长期个人 Agent 的核心状态之一。

它不应绑定：

- 某个 LLM；
- 某个 Harness（Pi / Codex / OpenCode 等）；
- 某个聊天平台（QQ / Telegram / Web）；
- 某个数据库；
- 某个向量数据库；
- 某个知识图谱产品；
- 某个容器实现；
- 某个 Agent framework。

核心目标：

1. **可迁移**  
   更换 Harness、模型、容器、数据库或检索后端时，不应丢失 Agent 对用户和过去经历的长期理解。

2. **可重建**  
   向量索引、Graph、摘要、Core Profile 等派生结构应能从更基础的数据重新生成。

3. **低耦合**  
   Main / Worker / Runtime 只依赖 Memory API，不依赖 SQLite schema、embedding provider、Graphiti API 等实现细节。

4. **时间感知**  
   能表达“以前成立、现在不成立”的事实，而不是简单覆盖。

5. **可解释**  
   每条记忆应该尽可能知道：
   - 从哪里来的；
   - 为什么存在；
   - 当前是否有效；
   - 是否被更新或替代。

6. **用户可控**  
   用户能够：
   - 查看；
   - 搜索；
   - 纠正；
   - 删除；
   - 判断一条记忆从哪里来。

7. **性能可控**  
   不应每次对话都将全部长期历史放入 context。

8. **允许渐进复杂化**  
   MVP 可以只使用 SQLite + FTS；未来再加入 embeddings / Graph，而不改变上层 API。

---

# 2. 非目标

当前 Memory System 不负责：

- Task 生命周期；
- Pi Session 生命周期；
- Worker scheduling；
- QQ MessageBinding；
- Artifact 存储；
- Git / filesystem 真实状态；
- process 状态；
- container 状态；
- authorization policy；
- chat transport。

这些系统可以引用 Memory，但不应由 Memory 持有。

---

# 3. 核心设计原则

## 3.1 Canonical Data 与 Derived Data 必须分开

整个系统最重要的原则：

```text
Canonical Memory
│
├── Raw Episodes
├── Semantic Facts
├── Episodic Memories
└── Explicit User Memory
        │
        ▼
Derived Data
├── Core Profile
├── FTS index
├── embeddings
├── graph
├── summaries
└── retrieval cache
```

派生数据可以删除后重建。

如果删除某个 embedding index 或 graph 后无法恢复记忆，说明系统设计错误。

---

## 3.2 Harness History 不等于 Long-term Memory

必须区分：

```text
Harness Session History
≠
Long-term Memory
```

Harness history 可以帮助模型知道当前会话刚刚发生了什么。

Long-term Memory 表达跨 Session 的稳定知识和经历。

即使 Pi session 全部删除：

```text
Long-term Memory 仍然存在。
```

---

## 3.3 Machine Truth 不属于 Memory

例如：

- 当前 Git branch；
- 文件是否存在；
- 当前依赖版本；
- 某进程是否还在运行；
- 某服务是否启动；
- 当前磁盘使用量。

这些属于：

```text
Machine Truth
```

需要实际检查。

禁止：

```text
Memory:
"项目当前在 main 分支"

→ 不检查 git branch
```

正确：

```text
Memory:
"这个项目一般使用 main"

Machine:
git branch --show-current
```

Memory 可以记录习惯、历史和上下文，但不能替代实时状态检查。

---

# 4. 系统边界

建议整体抽象：

```text
              ┌─────────────────────┐
              │    Memory Service   │
              │                     │
Main ────────▶│                     │
Worker ──────▶│   Stable API        │
Runtime ─────▶│                     │
Future Agent ▶│                     │
              └─────────┬───────────┘
                        │
             ┌──────────┼─────────────┐
             ▼          ▼             ▼
          SQLite     Vector       Graph
          Canonical   Index        Index
```

上层不允许直接访问：

```text
memory.db
embedding table
Graphiti client
Mem0 client
```

---

# 5. MemoryService 公共接口

建议以稳定接口作为唯一入口。

示意 TypeScript：

```ts
export interface MemoryService {
  ingestEpisode(input: IngestEpisodeInput): Promise<MemoryEpisode>;

  remember(input: ExplicitRememberInput): Promise<MemoryRecord>;

  retrieve(query: MemoryQuery): Promise<MemoryRetrievalResult>;

  getCoreContext(input: CoreContextRequest): Promise<CoreContext>;

  getMemory(id: string): Promise<MemoryRecord | null>;

  updateMemory(
    id: string,
    patch: MemoryUpdate
  ): Promise<MemoryRecord>;

  forget(input: ForgetRequest): Promise<ForgetResult>;

  explain(id: string): Promise<MemoryExplanation>;

  consolidate(input?: ConsolidationRequest): Promise<ConsolidationResult>;

  rebuildDerivedIndexes(
    input?: RebuildRequest
  ): Promise<RebuildResult>;

  exportMemory(input?: ExportRequest): Promise<MemoryExport>;

  importMemory(input: MemoryImport): Promise<ImportResult>;
}
```

这里的类型代表语义，不强制最终命名。

---

# 6. 数据层级

Memory System 分成四种主要 Canonical Memory。

---

# 6.1 Raw Episode

Raw Episode 是记忆系统最重要的迁移基础。

它记录：

> “发生过什么”。

不是：

> “LLM 认为其中什么值得记”。

示例：

```ts
interface MemoryEpisode {
  id: string;

  scope: MemoryScope;

  source: {
    type:
      | "chat_message"
      | "task"
      | "worker_result"
      | "document"
      | "manual"
      | "system_event";

    platform?: string;
    sourceId?: string;
  };

  actor?: {
    type: "user" | "agent" | "worker" | "system";
    id?: string;
  };

  content: string;

  occurredAt: string;
  ingestedAt: string;

  trust: "owner" | "guest" | "system";

  metadata?: Record<string, unknown>;
}
```

## Episode 规则

Episode 必须尽量保留原始语义。

禁止只保存：

```text
summary = "用户喜欢蓝色"
```

然后丢掉来源对话。

应该同时保留：

```text
Raw Episode
+
Extracted Fact
```

---

# 6.2 Semantic Fact

Semantic Fact 表达：

> “我们认为当前或过去成立的事实”。

示例：

```ts
interface MemoryFact {
  id: string;

  scope: MemoryScope;

  subject: string;
  predicate: string;
  object: JsonValue;

  confidence: number;

  validity: {
    validFrom?: string;
    validTo?: string;
  };

  status:
    | "active"
    | "superseded"
    | "disputed"
    | "deleted";

  provenance: string[];

  createdAt: string;
  updatedAt: string;
}
```

例如：

```json
{
  "subject": "user",
  "predicate": "preferred_language",
  "object": "zh-CN",
  "confidence": 0.99,
  "status": "active",
  "provenance": ["ep_1001"]
}
```

---

# 6.3 Episodic Memory

Episodic Memory 表达：

> “过去发生过一次值得以后参考的经历”。

它不是完整对话，也不是单个 Fact。

例如：

```ts
interface EpisodicMemory {
  id: string;

  scope: MemoryScope;

  situation: string;
  action?: string;
  outcome?: string;
  lesson?: string;

  provenance: string[];

  occurredAt?: string;

  importance?: number;

  createdAt: string;
  updatedAt: string;
}
```

例：

```text
Situation:
设计 Agent Home 容器边界。

Action:
最初将 Runtime 放在 Host，后来改为把 Runtime/Main/Pi/Worker
全部放入持久 Agent Home Container。

Outcome:
Host 和 Agent 的系统边界更清晰。

Lesson:
Agent Home 是同一个持久 runtime；Guest 是其中不同 Principal/ExecutionContext，不是另一套 Pi/model execution 架构或 nested container。
```

不要保存 LLM 私有 chain-of-thought。

只保存：

```text
situation
decision/action
outcome
lesson
```

---

# 6.4 Explicit Memory

用户明确要求：

```text
“记住……”
“以后都……”
“从现在开始……”
```

属于 Explicit Memory。

这种记忆的优先级高于自动推断。

建议：

```ts
interface ExplicitMemory {
  id: string;
  scope: MemoryScope;
  content: string;
  structuredFactIds?: string[];
  provenance: string[];
  createdAt: string;
  updatedAt: string;
}
```

自动 consolidation 不应擅自删除或改变显式用户记忆。

如果发生冲突，应标记：

```text
disputed
```

或提示 Main 在合适时机处理。

---

# 7. Memory Scope


## 多平台 Scope Identity

Memory scope 不直接使用未经 namespace 的平台原始 user/group ID。

多平台时：

```text
user:<principalId>
```

表示经过显式 identity binding 后的 Principal scope。

Conversation / group scoped memory 使用 Runtime 内部稳定 Conversation ID，例如：

```text
group:<conversationId>
```

这里的 `conversationId` 是内部 ID，不是裸 QQ group_id / Telegram chat_id。

因此：

- QQ 与 Telegram 原始 ID 不会碰撞；
- 显式绑定到同一 Principal 的多个平台账号可以共享允许的 user-scoped Memory；
- Conversation-specific Memory 仍保持平台/会话隔离；
- 不根据昵称等信息自动合并 Principal。


最少支持：

```ts
type MemoryScope =
  | "owner_private"
  | "global_agent"
  | `user:${string}`
  | `group:${string}`
  | `project:${string}`;
```

语义：

## owner_private

Owner 的私人长期记忆。

Guest 永远不能读取。

## global_agent

Agent 本身的跨用户稳定经验，例如：

```text
某个工具怎么使用
某种任务如何处理
```

不要把 Owner 的隐私放这里。

## user:<id>

某个用户的独立偏好和上下文。

## group:<id>

群组共享上下文。

## project:<id>

项目相关知识：

- 架构决策；
- 历史问题；
- 项目偏好；
- 过去的解决方式。

---

# 8. Scope 访问策略

Memory Service 接收的不是裸 query，而是带安全上下文的查询。

```ts
interface MemoryAccessContext {
  requesterId: string;
  trust: "OWNER" | "GUEST";
  groupId?: string;
  projectId?: string;
  allowedScopes: MemoryScope[];
}
```

MemoryService 必须在内部执行 scope filter。

禁止：

```text
Main 先查所有 memory
再由 LLM 判断哪些能给 Guest 看
```

正确：

```text
Runtime
↓
MemoryAccessContext
↓
MemoryService
↓
只返回允许 scope
```

---

# 9. Core Memory / Core Profile

Core Profile 是高频、稳定、重要记忆的 materialized view。

它用于解决：

> “为什么 Agent 每次对话都像第一次认识用户？”

示意：

```ts
interface CoreProfileBlock {
  id: string;

  scope: MemoryScope;

  label:
    | "user_profile"
    | "interaction_preferences"
    | "current_context"
    | "agent_identity"
    | string;

  content: string;

  sourceMemoryIds: string[];

  generatedAt: string;
  version: number;
}
```

---

## 9.1 Core Profile 不是 Source of Truth

必须满足：

```text
删除 Core Profile
→ 可以从 Canonical Memory 重建
```

Core Profile 只是：

```text
Materialized View
```

---

## 9.2 Core Profile 内容约束

适合：

- 稳定语言偏好；
- 用户明确表达的交互偏好；
- 长期活跃项目；
- Agent 身份原则；
- 高频需要知道的上下文。

不适合：

- 每次聊天细节；
- 临时状态；
- 低置信度猜测；
- 几小时后就失效的信息。

---

## 9.3 Context Budget

Core Profile 必须有预算。

例如：

```ts
interface CoreContextRequest {
  maxTokens?: number;
  scopes: MemoryScope[];
}
```

不能无限增长。

需要定期压缩和重建。

---

# 10. Memory Formation

Memory Formation 分两条路径。

---

# 10.1 Hot Path

用于：

- 用户明确“记住”；
- 非常重要的身份/偏好改变；
- 必须立即影响后续对话的事实。

路径：

```text
Conversation
↓
MemoryService.remember()
↓
Canonical store
↓
Core refresh（必要时）
```

目标：

> 几乎立即生效。

---

# 10.2 Background Consolidation

普通聊天默认走：

```text
Raw Episode
↓
Memory Inbox
↓
Background Memory Worker
↓
Extract facts / episodic memory
↓
Deduplicate
↓
Resolve update / supersede
↓
Update indexes
↓
Refresh core profile if needed
```

不要阻塞 Main 正常回复。

---

# 11. Memory Inbox

为了降低耦合，建议把 ingestion 和 consolidation 分开。

例如：

```ts
interface MemoryInboxItem {
  id: string;
  episodeId: string;
  status:
    | "pending"
    | "processing"
    | "done"
    | "failed";

  retries: number;

  createdAt: string;
  updatedAt: string;
}
```

这样 Memory Worker 崩溃也不会丢待处理内容。

---

# 12. Consolidation

Consolidation 负责：

```text
新 Episode
↓
候选事实
↓
与已有事实比较
↓
决定：
  insert
  merge
  reinforce
  supersede
  dispute
  ignore
```

---

## 12.1 禁止简单覆盖

错误：

```text
user.os = Windows

后来：
user.os = Arch

UPDATE user.os = Arch
```

正确：

```text
Fact A:
Windows
valid_to = 2026-06

Fact B:
Arch
valid_from = 2026-06
```

---

## 12.2 Reinforcement

如果同一事实多次出现：

```text
user prefers Chinese
```

不应该创建 15 条重复 Fact。

应该：

```text
same semantic fact
+
additional provenance
+
possibly confidence increase
```

---

## 12.3 Conflict

出现冲突：

```text
Fact A:
用户喜欢浅色

Fact B:
用户现在更喜欢深色
```

系统应该考虑：

- 时间；
- explicitness；
- provenance；
- confidence；
- scope。

可能：

```text
A → superseded
B → active
```

或：

```text
A/B → disputed
```

---

# 13. Provenance

每条自动形成的记忆尽量保留来源。

```ts
type MemoryProvenance = {
  episodeIds: string[];
  extractionModel?: string;
  extractionVersion?: string;
};
```

必须能够支持：

```text
/memory why <id>
```

返回：

- 记忆内容；
- 来源 Episode；
- 创建时间；
- 当前状态；
- 是否被替代；
- 置信度。

---

# 14. Time Model

必须区分：

```text
event time
ingestion time
validity time
```

例如：

```text
occurredAt:
用户什么时候说的

ingestedAt:
系统什么时候写入数据库

validFrom / validTo:
这个事实什么时候成立
```

不要把这三个概念混在一个 `created_at` 中。

---

# 15. Retrieval

Memory retrieval 不应只是：

```text
vectorSearch(query)
```

完整过程建议：

```text
User Context
↓
Query Interpretation
↓
Scope Filtering
↓
Query Expansion
↓
Multi-source Retrieval
↓
Ranking
↓
Deduplication
↓
Context Packaging
```

---

# 16. MemoryQuery

示意：

```ts
interface MemoryQuery {
  text: string;

  access: MemoryAccessContext;

  types?: Array<
    | "fact"
    | "episode"
    | "explicit"
    | "raw"
  >;

  timeRange?: {
    from?: string;
    to?: string;
  };

  limit?: number;

  includeProvenance?: boolean;
}
```

---

# 17. Query Expansion

用户真实对话经常是：

```text
“这个是不是还是浅一点比较好？”
```

不能只 embedding 这句话。

Main 或 Memory Query Planner 应扩展为：

```text
当前话题：衣服/颜色
用户颜色偏好
最近穿搭讨论
浅色 vs 深色
相关身体/版型偏好
```

Query expansion 可以由：

- Main；
- Memory subsystem；
- 小模型；
- deterministic topic context；

实现。

但是公共 Memory API 不应要求调用方知道底层检索细节。

---

# 18. Retrieval Sources

第一版可组合：

```text
1. Core Profile
2. Structured Fact exact lookup
3. SQLite FTS
4. Recent relevant episodes
5. Episodic memories
```

未来增加：

```text
6. embedding search
7. graph traversal
```

---

# 19. Ranking

概念上：

```text
score =
semantic_similarity
+ lexical_relevance
+ recency
+ importance
+ confidence
+ scope_relevance
+ explicit_memory_bonus
```

不要求 MVP 一开始实现复杂机器学习 ranking。

第一版可以用规则加权。

重要的是：

> API 不绑定某一种 ranking 实现。

---

# 20. Retrieval Result

```ts
interface MemoryRetrievalResult {
  core?: CoreContext;

  items: Array<{
    id: string;
    type: "fact" | "episode" | "explicit" | "raw";

    content: string;

    score?: number;

    occurredAt?: string;

    provenance?: string[];
  }>;
}
```

---

# 21. Context Packaging

MemoryService 不应该直接返回一整坨数据库对象给模型。

建议：

```ts
interface MemoryContext {
  coreBlocks: string[];

  relevantFacts: string[];

  relevantEpisodes: string[];

  sourceRefs?: string[];
}
```

Main 只获得当前需要的 context。

---

# 22. Derived Index Adapter

所有检索后端都通过 Adapter。

例如：

```ts
interface LexicalIndex {
  index(record: IndexableMemory): Promise<void>;
  remove(id: string): Promise<void>;
  search(query: LexicalQuery): Promise<SearchHit[]>;
  rebuild(): Promise<void>;
}

interface VectorIndex {
  index(record: IndexableMemory): Promise<void>;
  remove(id: string): Promise<void>;
  search(query: VectorQuery): Promise<SearchHit[]>;
  rebuild(): Promise<void>;
}

interface GraphIndex {
  upsert(record: GraphRecord): Promise<void>;
  remove(id: string): Promise<void>;
  search(query: GraphQuery): Promise<SearchHit[]>;
  rebuild(): Promise<void>;
}
```

上层 MemoryService 不应该暴露：

```text
neo4j query
graphiti episode
pinecone namespace
qdrant collection
```

---

# 23. MVP Backend

第一版推荐：

```text
Canonical:
SQLite

Lexical:
SQLite FTS5

Vector:
optional / disabled

Graph:
disabled
```

原因：

- migration 简单；
- 单文件备份；
- Agent Home 内易部署；
- 足够支持初期个人数据量；
- 不增加外部服务；
- 后面可以 rebuild。

---

# 24. Vector Adapter

未来加入 embedding 时：

```ts
interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
}

interface VectorIndex {
  upsert(...): Promise<void>;
  query(...): Promise<VectorHit[]>;
  rebuild(...): Promise<void>;
}
```

禁止让 `MemoryFact` schema 直接存某 provider 专有 embedding 格式。

可以保存：

```text
embedding model/version metadata
```

但 embedding 仍是 derived data。

---

# 25. Graph Adapter

未来 Graphiti / Neo4j / FalkorDB 可作为 Derived Graph。

Graph 适合：

- person/entity relationship；
- project dependency；
- temporal relationship；
- 多跳关联；
- 因果/关联解释。

但 Graph 不成为 Canonical Memory。

必须满足：

```text
DROP GRAPH
↓
rebuildDerivedIndexes()
↓
恢复
```

---

# 26. Backend Independence

MemoryService 应支持这样的迁移：

```text
SQLite
→ PostgreSQL

FTS5
→ Tantivy / Elasticsearch

local embeddings
→ hosted embeddings

no graph
→ Graphiti

Graphiti
→ another graph engine
```

上层 Main 不修改调用方式。

---

# 27. Export / Import

迁移能力必须从第一版预留。

建议 Memory Export 使用开放格式：

```text
memory-export/
├── manifest.json
├── episodes.jsonl
├── facts.jsonl
├── episodic.jsonl
├── explicit.jsonl
└── profile.jsonl
```

不要把：

```text
vector index
graph db binary
SQLite file
```

作为唯一迁移格式。

SQLite 文件可以备份，但不是长期可移植规范。

---

## 27.1 Export Manifest

```json
{
  "format": "agent-memory",
  "version": 1,
  "exportedAt": "...",
  "source": "...",
  "counts": {
    "episodes": 1000,
    "facts": 200,
    "episodic": 30
  }
}
```

---

# 28. Schema Version

Canonical schema 必须有版本。

```text
memory_schema_version
```

Migration：

```text
v1 → v2 → v3
```

不允许靠：

```text
“数据库删了重新建”
```

处理长期 Memory。

---

# 29. Stable IDs

Memory Record 应使用稳定 UUID/ULID。

不要把 SQLite rowid 当公共 ID。

原因：

- export/import；
- provenance；
- graph rebuild；
- cross-store migration；
- conflict resolution。

---

# 30. User Controls

建议未来提供：

```text
/memory
/memory profile
/memory search <query>
/memory why <id>
/memory forget <id>
/memory correct <id>
```

这些命令是 UX。

底层仍然调用 MemoryService。

---

# 31. Forget

Forget 有多种语义。

建议区分：

```text
hide
supersede
delete
purge
```

例如：

## delete

删除某个 derived memory。

## purge

删除：

```text
fact
episode
provenance
derived indexes
```

适合明确隐私删除要求。

Memory API 必须能表达 purge，而不是只设置：

```text
deleted = true
```

---

# 32. Correction

用户说：

```text
“不对，我不是喜欢深色，我还是更喜欢浅色。”
```

应该形成：

```text
Old Fact:
status = superseded/disputed

New Fact:
active
provenance = correction episode
```

用户显式 correction 优先级高于自动 inference。

---

# 33. Memory Quality

每条 Memory 可以拥有：

```ts
interface MemoryQuality {
  confidence?: number;
  importance?: number;
  explicitness?: "explicit" | "inferred";
}
```

不要把所有模型抽取结果都当成确定事实。

---

# 34. Procedural Memory

长期来看，可以加入：

```text
Procedural Memory
```

表达：

> Agent 应该怎样和这个用户协作。

例如：

```text
用户希望架构讨论解释为什么这样设计。
用户偏好先做简单可运行方案，再逐步复杂化。
```

第一版可以把它作为 Semantic Fact / Core Profile 的一种 label。

不必单独创建复杂系统。

---

# 35. Worker 与 Memory

Worker 不应该默认拥有 owner_private 全部 Memory。

Worker 应获得：

```text
Task-specific context
+
project scope
+
必要的 user preference
```

Worker 可以：

```text
proposeMemory(...)
```

但默认不直接写永久长期 Memory。

推荐：

```text
Worker
↓
Memory Proposal
↓
Main / Background Memory Worker
↓
Consolidation
```

---

# 36. Memory Proposal

```ts
interface MemoryProposal {
  taskId?: string;

  type:
    | "fact"
    | "episode";

  content: unknown;

  provenance: string[];

  reason: string;
}
```

避免 Worker 做完一次任务就把大量临时信息写成长期人格状态。

---

# 37. Main 与 Memory

Main 是 Memory 的主要消费方。

每次处理用户消息时：

```text
Main input
=
recent conversation
+
Core Profile
+
retrieved memory
+
QQ lazy context
```

而不是：

```text
all historical messages
```

---

# 38. Memory Injection Budget

必须限制：

```text
Core Profile tokens
Retrieved Memory tokens
Recent History tokens
```

避免 Memory 无限膨胀导致：

- 上下文成本上升；
- instruction dilution；
- retrieval noise；
- 旧记忆压过当前意图。

---

# 39. Observability

Memory 系统应记录：

```text
ingest count
extraction count
merge count
supersede count
retrieval latency
retrieval result count
rebuild duration
failed consolidation
```

不要记录敏感原文到普通 debug log。

Memory DB 本身已经是数据来源。

---

# 40. Failure Handling

## Extraction 失败

Raw Episode 已存在：

```text
→ retry
```

不会丢数据。

## Vector Index 失败

Canonical data 继续可用：

```text
→ fallback FTS
```

## Graph 失败

```text
→ fallback facts/episodes
```

## Core Profile 损坏

```text
→ rebuild
```

这就是 canonical / derived 分离的主要价值。

---

# 41. Consistency Model

Canonical write 优先。

建议：

```text
Episode write
↓ transaction committed
↓
return success

Derived indexing
↓
async eventual consistency
```

不应因为 embedding API 暂时不可用而导致用户消息无法写入 Memory。

---

# 42. Database Transaction Boundary

对于：

```text
Episode + Inbox
```

建议同事务：

```text
INSERT episode
INSERT inbox
COMMIT
```

避免 Episode 写成功但永远没进入 consolidation。

---

# 43. Data Retention

不要默认永久保存所有原始内容而不预留策略。

接口至少支持：

```ts
interface RetentionPolicy {
  rawEpisodeDays?: number | null;
  keepExplicitForever?: boolean;
  keepProvenanceForActiveFacts?: boolean;
}
```

Owner 默认可以选择长期保留。

Guest/group 数据可以有更短 retention。

---

# 44. Privacy Boundary

Memory Scope 是安全边界的一部分。

即使同一个 SQLite DB：

```text
owner_private
group:A
user:B
```

查询仍必须强制 scope constraint。

测试必须覆盖跨 scope 泄露。

---

# 45. Migration Strategy

Memory 系统的迁移顺序：

```text
1. export canonical JSONL
2. migrate canonical database
3. validate counts/checksums
4. rebuild FTS
5. rebuild embeddings
6. rebuild graph
7. rebuild core profile
```

不要尝试迁移所有 derived storage 的内部文件。

---

# 46. Canonical Backup

推荐备份：

```text
SQLite database
+
portable JSONL export
```

原因：

SQLite：

- 快速恢复。

JSONL：

- 长期可迁移；
- schema 可读；
- 不绑定 DB engine。

---

# 47. Testing

必须至少测试：

## Canonical

- episode insert；
- fact update；
- supersede；
- provenance；
- explicit memory。

## Scope

- owner_private 不泄露给 Guest；
- group scope 不串群；
- project scope 正确。

## Time

- old fact valid_to；
- new fact valid_from；
- retrieval 默认偏向 active fact。

## Consolidation

- 重复事实 merge；
- correction supersede；
- conflict disputed。

## Derived

- FTS 删除后可 rebuild；
- Core Profile 删除后可 rebuild。

## Migration

- export；
- fresh DB import；
- semantic record 数量一致；
- provenance 保留。

## Failure

- embedding unavailable 不影响 canonical write；
- consolidation crash 可 retry。

---

# 48. MVP

Memory MVP 不需要：

- Graphiti；
- Neo4j；
- vector DB；
- dedicated embedding service；
- complicated ontology。

MVP 需要：

```text
SQLite canonical store
SQLite FTS
Raw Episode
Semantic Fact
Episodic Memory
Explicit Memory
Scope
Provenance
Temporal validity
Core Profile
Memory Inbox
Background consolidation boundary
Export/import
Rebuild
```

如果 extraction LLM 尚未完成，可以：

```text
Episode storage + explicit memory
```

先真实工作。

但 schema 和接口必须保留后续 consolidation 能力。

---

# 49. 推荐模块边界

```text
memory/
├── api/
│   ├── memory-service.ts
│   └── types.ts
│
├── canonical/
│   ├── episode-store.ts
│   ├── fact-store.ts
│   ├── episodic-store.ts
│   └── explicit-store.ts
│
├── consolidation/
│   ├── inbox.ts
│   ├── extractor.ts
│   ├── merger.ts
│   └── temporal-resolver.ts
│
├── retrieval/
│   ├── retriever.ts
│   ├── ranker.ts
│   └── context-builder.ts
│
├── profile/
│   └── core-profile.ts
│
├── indexes/
│   ├── lexical.ts
│   ├── vector.ts
│   └── graph.ts
│
├── portability/
│   ├── export.ts
│   ├── import.ts
│   └── migrations.ts
│
└── sqlite/
    ├── schema.ts
    └── migrations/
```

目录可以不同。

边界比路径重要。

---

# 50. 与 Agent Home 的唯一耦合点

Memory System 只应该依赖少量外部上下文：

```text
Identity / Scope context
Clock
Optional LLM extraction provider
Optional index adapters
```

它不应该 import：

```text
SnowLumaClient
PiSession
TaskRuntime
DockerClient
QQEvent
WorkerRuntime
```

Agent Home 通过 Adapter 将 QQ/Task 事件转换成 Memory Episode。

例如：

```text
QQ Message
↓
Agent Runtime
↓
MemoryEpisode
↓
MemoryService
```

而不是：

```text
MemoryService
↓
读取 SnowLuma
```

---

# 51. Event Integration

Memory 可以通过事件接收信息。

例如：

```ts
type MemoryInputEvent =
  | ConversationEpisodeEvent
  | TaskCompletedEvent
  | UserExplicitRememberEvent
  | WorkerMemoryProposalEvent;
```

但是这些事件在进入 Memory boundary 前应转换为 Memory 自己的 DTO。

Memory System 不订阅业务对象内部 schema。

---

# 52. Public Dependency Rule

上层只能依赖：

```text
memory/api/*
```

禁止：

```text
main → memory/sqlite/*
worker → memory/indexes/*
runtime → memory/canonical/*
```

内部实现可以自由变化。

---

# 53. Dependency Direction

必须保持：

```text
Main / Worker / Runtime
        ↓
     Memory API
        ↓
Memory implementation
        ↓
Storage / Index adapters
```

禁止反向：

```text
Memory implementation
→ Main
→ Worker
→ QQ
```

---

# 54. Adapter Rule

未来接入：

- Mem0；
- Graphiti；
- LangMem；
- another vector DB；

都应该是：

```text
Adapter / Derived Backend
```

不是：

```text
Memory System 本身
```

例如：

```ts
class GraphitiGraphIndex implements GraphIndex {}
```

而不是：

```ts
class MemoryService extends Graphiti {}
```

---

# 55. 为什么这样设计

如果没有 Canonical Episode：

```text
换 extractor / graph
→ 原信息无法恢复
```

如果没有 Provenance：

```text
记错后无法解释来源
```

如果没有 Temporal validity：

```text
旧事实与新事实冲突
```

如果没有 Scope：

```text
群聊/Guest 可能泄露 Owner Memory
```

如果没有 Core Profile：

```text
每次对话都依赖 retrieval 命中
→ 人格连续性差
```

如果 Core Profile 是唯一 Memory：

```text
压缩时信息永久丢失
```

如果 Vector DB 是 Source of Truth：

```text
换 embedding/provider
→ migration 极其困难
```

如果 Memory 绑 Pi：

```text
换 Harness
→ Agent 失忆
```

因此这些边界并不是为了“架构完整”，而是分别解决具体长期故障模式。

---

# 56. 最终不变量

无论未来 Memory System 怎么变化，都必须满足：

1. **Harness 可以替换，长期 Memory 不丢。**
2. **Database 可以替换，Canonical Memory 可导出导入。**
3. **Vector/Graph 可以全部删除并重建。**
4. **Raw Episode 和 Provenance 不依赖某个检索后端。**
5. **事实支持时间有效性和 supersede。**
6. **用户显式记忆优先于自动推断。**
7. **Scope enforcement 由代码完成，不交给 LLM。**
8. **Core Profile 是 materialized view，不是唯一真相。**
9. **Memory 不冒充实时 Machine Truth。**
10. **Main/Worker 只依赖 Memory API。**
11. **Worker 默认不能直接污染长期 Owner Memory。**
12. **删除、纠正、解释和迁移必须从设计层面支持。**
