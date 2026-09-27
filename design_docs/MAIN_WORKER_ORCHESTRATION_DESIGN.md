# Main / Worker 多 Agent 编排设计

> 状态：详细设计基线  
> 作用范围：从 Runtime 接收到已持久化的消息事件开始，到 Main 完成理解、按需创建/协调 Worker、汇总结果，并通过 SnowLuma 能力回复用户为止。  
> 当前 Harness：Pi  
> 上位设计：`AGENT_HOME_DESIGN.md`  
> 相关详细设计：`MEMORY_SYSTEM_DESIGN.md`、`AGENT_HOME_CONTAINER_CONTROL_DESIGN.md`  
> 相关设计：`TASK_RUNTIME_DESIGN.md`、`AUTHORIZATION_CAPABILITY_DESIGN.md`（待建立）、`QQ_SNOWLUMA_INTEGRATION_DESIGN.md`（待建立）

---

# 1. 设计目标

本设计要解决的核心冲突：

1. QQ 是持续可交互入口，Main 必须随时可响应；
2. 实际工作可能持续数分钟到数小时；
3. 一个 Harness Session 在长 turn 中不能可靠承担新的独立用户交互；
4. 长任务可能需要用户补充信息；
5. 用户可能中途改变要求；
6. 同时可能存在多个独立 Task；
7. Main 必须保持“同一个长期 Agent”的连续体验；
8. Worker 应执行真实工作，但不应绕过 Main 直接成为另一个用户-facing Bot；
9. 最终回复、追问、进度和结果都应通过统一 QQ/SnowLuma 能力呈现。

因此采用：

> **一个长期 Main Agent + 动态 Worker Agents + Runtime/Task Control Plane**

而不是：

- 单 Agent 从聊天到 shell 全部自己做；
- 多个固定 Persona 同时在 QQ 中说话；
- Worker 直接操作 QQ；
- 每条消息新建一个完全独立 Agent；
- 将 Harness Session 本身当作 Task。

---

# 2. 核心拓扑

默认拓扑是星型：

```text
                         User / QQ
                             │
                             ▼
                         SnowLuma
                             │
                             ▼
                           Main
                      /      |      \
                     /       |       \
                    ▼        ▼        ▼
               Worker A  Worker B  Worker C
                    \        |        /
                     \       |       /
                      └── Task Runtime
```

用户只和 Main 建立连续关系。

Worker 是 Main 委派出来的执行实体，不是独立聊天人格。

---

# 3. 核心不变量

实现必须保持：

1. **Main 是唯一默认 user-facing Agent。**
2. **Worker 长任务不能占住 Main。**
3. **不同 QQ Conversation 必须使用 scope-safe 的独立 Main Pi Sessions；Main logical identity 可以跨 Session 保持连续。**
3. **Worker 默认不直接给任意 QQ 用户/群发消息。**
4. **Main 通过 Chat Platform Capability（当前 QQ 为 SnowLuma Adapter） 读取和回复 QQ。**
5. **Task != Worker != Pi Session。**
6. **一个 Task 的 durable 生命周期由 Runtime/Task Runtime 拥有。**
7. **Main 的语义决策不替代 Runtime 的权限检查。**
8. **Worker 的 progress/question/result 必须以结构化事件回到 Runtime/Main。**
9. **Worker 需要用户输入时由 Main 统一询问。**
10. **多个 Worker 默认不直接互相私聊；共享协调通过 Main/Task Runtime。**
11. **用户 follow-up 必须能路由到已有 Task，而不是总是创建新 Worker。**
12. **最终用户回复由 Main 基于当前对话、Memory、Task 状态和 Worker 结果生成。**
13. **Main/Worker 只通过稳定 Harness Adapter 使用 Pi，不依赖 Pi 私有存储格式。**
14. **Main 需要 QQ 上下文时按需查询 SnowLuma，不把大量历史预灌入 prompt。**
15. **LLM 不能扩大自身或 Worker 的 capability。**

---

# 4. 组件职责

## 4.1 Runtime / Orchestration Host

这里的 Runtime 指 Agent Home 内常驻 Runtime，不是 Host Controller。

负责：

- 从 durable ingress queue 取得事件；
- deterministic wake / command routing；
- trusted identity / authorization context；
- Main Session 生命周期；
- Task / Worker 生命周期；
- Main tool implementation；
- Worker event ingestion；
- Task mailbox；
- PendingQuestion；
- MessageBinding；
- cancellation；
- recovery；
- capability enforcement。

Runtime 不负责生成最终自然语言回答。

---

## 4.2 Main Agent

Main 是长期存在的 Concierge / Orchestrator。

负责：

- 与用户正常聊天；
- 理解当前请求；
- 按需查询当前 Chat Platform 上下文；
- 使用 Memory；
- 判断直接回答还是委派 Worker；
- 创建/查询/steer/cancel Task；
- 将复杂目标拆成可执行工作；
- 根据需要创建多个 Worker；
- 汇总 Worker 结果；
- 决定是否需要进一步委派；
- 将 Worker question 转成自然的用户提问；
- 向用户解释进度和结果；
- 通过 Chat Platform Capability 回复用户；当前 QQ 实现由 SnowLuma Adapter 提供。

Main 不承担长时间 shell/edit/browser 执行。

---

## 4.3 Worker Agent

Worker 是执行 Agent。

负责：

- 接受明确目标；
- 在授权 workspace 中工作；
- 使用 shell/filesystem/Git/browser 等工具；
- 自主完成多步骤工作；
- 主动报告重要进展；
- 缺信息时 `ask_parent`；
- 发布 artifact；
- 返回结构化结果；
- 在 Task 被 cancel 时停止。

Worker 不负责：

- 判断用户身份；
- 修改自身 capability；
- 任意访问 owner-private Memory；
- 任意选择 Chat Platform destination；
- 长期维护与用户的独立聊天关系。

---

# 5. Main Identity 与 Conversation Session

MVP 中只有一个长期 **Main logical identity**，但不使用一个全局共享的 Pi conversation session 承载所有聊天平台 Conversation。

必须区分：

```text
Main Agent Identity
≠
Conversation
≠
Pi Session
```

推荐关系：

```text
                     Main Agent
                  长期逻辑身份
                        │
          ┌─────────────┼─────────────┐
          ▼             ▼             ▼
   Owner 私聊        群 A          Guest 私聊
 Conversation     Conversation      Conversation
      │               │               │
      ▼               ▼               ▼
 Pi Session A      Pi Session B     Pi Session C
```

原因：

- 不同私聊/群聊的上下文不应相互污染；
- Owner 私聊可能包含 `owner_private` Memory；
- 群聊或 Guest conversation 不应继承这些上下文；
- 一个全局 Pi Session 会造成上下文串线和潜在权限泄漏；
- `/new` 应只重置当前 conversation 的会话上下文，而不是重置整个 Agent。

Runtime 拥有：

```text
Main logical identity
Conversation registry
Conversation → Pi Session binding
Conversation scope / trust metadata
```

Pi Session ID 只是当前 Harness binding。

因此：

```text
Main != Pi Session ID
Conversation != Pi Session ID
```

如果某个 Pi Session 无法恢复：

- Runtime 只重建对应 Conversation Session；
- Agent identity 不变；
- 其他 Conversation 不受影响；
- Task / Memory / Projects 不丢失；
- 新 Session 根据 conversation scope 重新组合 Core/Relevant Memory 和必要 Task 摘要。

---

# 5.1 Conversation Identity

Conversation 必须使用平台 namespace。

禁止只使用：

```text
private:<userId>
group:<groupId>
```

因为不同平台、不同 Bot account 的原始 ID 可能冲突。

平台 Adapter 先产生：

```ts
interface ConversationAddress {
  platform: string;
  accountId: string;

  kind: "private" | "group";

  platformConversationId: string;
  threadId: string | null | NotImplemented;
}
```

Runtime 再为一个稳定平台地址建立内部：

```text
conversationId = UUID / stable internal ID
```

Conversation durable record 至少包含：

```ts
interface ConversationRef {
  conversationId: string;

  platform: string;
  accountId: string;

  kind: "private" | "group";

  platformConversationId: string;
  threadId: string | null | NotImplemented;

  principalId?: string;

  trustScope: string;
  memoryScopes: string[];

  mainSessionId?: string;

  createdAt: string;
  updatedAt: string;
}
```

同一个 Principal 在 QQ 与 Telegram 私聊中：

```text
Principal 可以相同
ConversationId 不同
Main Pi Session 不同
```

跨平台账号只能通过显式 identity binding 关联，不能根据昵称/用户名推断。

未来 thread/topic 平台可以把 `threadId` 映射为真实值；不支持 thread 的平台使用 `NOT_IMPLEMENTED`。

---

# 5.2 Session Scope 不得隐式扩大

Conversation Session 的安全 scope 必须由 Runtime 决定。

例如 Owner 私聊：

```text
private:owner
→ owner_private
→ user:owner
→ global_agent
```

群聊：

```text
group:123
→ group:123
→ global_agent
→ only explicitly safe requester/context scopes
```

即使 Owner 本人在群里发消息，也不能因为这一 turn 就把 `owner_private` Memory 注入一个后续会被其他群成员继续使用的群 Session。

原则：

> Conversation Session 的可见 Memory / Capability scope 不能因为某一条更高权限用户消息而永久扩大。

如果某个 turn 需要额外临时信息，应作为 turn-scoped context 使用，不能改变 Session 的长期安全基线。

---

# 5.3 `/new`

`/new` 的高层语义固定为：

> 为当前 Conversation 创建一个新的 Main conversational session/context。

它不删除：

- Agent identity；
- Long-term Memory；
- Task；
- Projects；
- 其他 Conversation Sessions。

流程：

```text
/new
↓
Runtime identifies current conversation
↓
close/archive current Pi conversation binding
↓
create fresh Pi Session for same Conversation scope
↓
future turns use new session
```

正在运行的 Task 不因 `/new` 自动取消。

---

# 5.4 Task 与 Conversation

Task 必须记录 origin / notification conversation。

例如：

```text
Task #17
originConversation = group:123
```

Task 生命周期独立于 Main Pi Session。

因此：

```text
/new
```

之后 Task #17 仍然存在。

Task 完成时，Runtime/Main 根据 Task notification target 决定回到哪个 Conversation，而不是依赖“当前 Pi Session”猜测。

---

# 5.5 Main Context 恢复

重建 Conversation Session 时，不重放所有历史。

只恢复：

```text
Main system/identity instructions
+
Conversation scope
+
Core Memory allowed by scope
+
relevant retrieved Memory
+
active/recent Task summaries relevant to this conversation
+
必要 recent conversation summary/state
```

Pi raw history 是可利用的 context source，但不是唯一 durable continuity source。

---

# 6. Main Context 组成

每次处理事件时，Main Context 应按预算组合：

```text
System / Agent instructions
+
当前 trusted event metadata
+
当前用户消息 / reply
+
recent context for the current Conversation only
+
Core Memory allowed by current Conversation scope
+
retrieved relevant Memory
+
relevant Task summaries / bindings
+
按需从当前 Chat Platform Adapter 获取的上下文
```

不应默认加入：

- 全部历史 QQ；
- 全部 Task log；
- 全部 Worker raw events；
- 全部 Memory；
- 无关群消息。

Main 可以通过 Tool 主动获取更多信息。

---

# 7. 消息事件进入 Main 的流程

完整入站高层流程：

```text
QQ
↓
SnowLuma
↓
Host Controller
↓ persistent control stream
Runtime durable ingress
↓
Wake / deterministic command check
↓
Build MainTurnContext
↓
Main Pi Session
```

Runtime 在调用 Main 前至少确定：

- trusted requester identity；
- conversation identity；
- message ID；
- reply target（若有）；
- 是否存在 PendingQuestion binding；
- 是否存在 Task/Artifact binding；
- allowed capabilities；
- event dedup 已完成。

Main 不负责从 message text 推断这些可信字段。

---

# 8. MainTurnContext

建议概念类型：

```ts
interface MainTurnContext {
  eventId: string;
  conversationId: string;

  requester: {
    platform: string;
    accountId: string;
    userId: string;
    principalId?: string;
  };

  conversation: {
    kind: "private" | "group";
    platformConversationId: string;
    threadId: string | null | NotImplemented;
  };

  message: {
    messageId: string;
    replyTo:
      | PlatformMessageRef
      | null
      | NotImplemented;

    preview?: string;
    rawRef?: string;
  };

  trust: "OWNER" | "GUEST";

  bindings: {
    taskIds?: string[];
    questionId?: string;
    artifactId?: string;
  };

  capabilities: CapabilitySet;
}
```

Main 可以使用 Tool 获取完整 message/reply/history/media。

---

# 9. 消息路由优先级

事件进入 Runtime 后按以下优先级处理：

```text
1. deterministic control command
2. PendingQuestion reply binding
3. explicit Task / MessageBinding
4. Main conversational routing
```

例如：

```text
/stop
```

不需要 Main 判断。

回复某个 PendingQuestion：

```text
reply_to → question binding
```

应先由 Runtime 解析并持久化答案，再通知 Main/Worker。

普通自然语言 follow-up 才交给 Main 判断其与哪些 Task 相关。

---

# 10. Main 对用户请求的三种基本处理

Main 每个 turn 应在语义上选择：

## A. Direct Response

适合：

- 普通聊天；
- 解释；
- 简单查询；
- 短小、不需持久跟踪的操作。

流程：

```text
Main
↓
Chat Platform Capability
↓
SnowLuma
↓
User
```

---

## B. Existing Task Interaction

适合：

- “做到哪了？”
- “改成 PostgreSQL”
- “先别继续 UI”
- “那个任务停掉”
- 对 Worker question 的补充说明。

流程：

```text
Main
↓
query/steer/cancel existing Task
↓
Main confirms/explains to user
```

不应无条件新建 Worker。

---

## C. New Delegated Work

适合：

- 长任务；
- 多步骤工作；
- 需要 shell/filesystem/Git/browser；
- 需要持续进度；
- 需要可恢复；
- 会阻塞 Main 的工作。

流程：

```text
Main
↓
create Task
↓
spawn Worker
↓
Main immediately returns acknowledgement
```

---

# 11. Worker Spawn Policy

Main 不使用固定 “coding=Worker” 分类器。

判断因素：

```text
预计持续时间
步骤数量
是否需要执行工具
是否需要独立进度
是否可能等待外部条件
是否需要中途 steering
是否应在用户继续聊天时后台运行
```

原则：

> 只要直接执行会让 Main 明显失去响应性，就应委派。

---

# 12. 多 Worker 的使用条件

Main 可以为一个用户目标创建多个 Worker，但不应默认“一个问题多 Agent 群聊”。

允许多 Worker 的典型情况：

### 12.1 独立并行工作

```text
Worker A → 查 SnowLuma API
Worker B → 检查 Pi adapter
```

两者 workspace 不冲突。

### 12.2 不同专业子任务

```text
Worker A → implementation
Worker B → tests / validation
```

但只有在确实能并行并减少等待时才创建。

### 12.3 大目标拆分

主 Task 可包含 child Tasks：

```text
Parent Task
├── Child A
├── Child B
└── Child C
```

Task Runtime 拥有 parent/child durable relationship。

---

# 13. 不使用固定 Persona Swarm

MVP 不预定义：

```text
Researcher
Coder
Reviewer
Planner
Manager
...
```

作为永久 Agent 集群。

原因：

- 增加 prompt 和 routing 复杂度；
- 容易重复工作；
- 固定角色不适合所有 Task；
- 难以控制成本；
- 容易制造“Agent 在互相聊天但没有推进”。

Worker 是**按任务动态生成的 execution agent**。

Main 可在 spawn 时给 Worker 一个临时 role/goal，但该 role 不是长期人格。

---

# 14. Worker 创建参数

建议语义：

```ts
interface SpawnWorkerRequest {
  taskId: string;

  goal: string;

  context: {
    requesterTrust: "OWNER" | "GUEST";
    projectId?: string;
    workspace?: string;
    relevantMemory?: string[];
    sourceMessageRefs?: string[];
  };

  capabilities: string[];

  constraints?: string[];

  parentTaskId?: string;
}
```

Runtime 必须验证：

```text
requested capabilities
⊆
Task allowed capabilities
```

Main 不能自己授予更多权限。

---

# 15. Worker 初始 Prompt

Worker 初始上下文应该包含：

```text
明确目标
完成标准
允许的 workspace
能力边界
Task ID
必要用户要求
必要项目上下文
必要 Memory
如何 report_progress
如何 ask_parent
如何 publish_artifact
如何 finish_task
```

不应默认复制 Main 的全部对话历史。

Worker 只得到完成任务所需的信息。

---

# 16. Worker 与 Main 的通信

Worker 不通过自然语言“模拟 QQ”与 Main 通信。

必须通过结构化 Runtime API。

至少：

```ts
interface WorkerControl {
  reportProgress(input: ProgressInput): Promise<void>;
  askParent(input: WorkerQuestion): Promise<QuestionHandle>;
  publishArtifact(input: ArtifactProposal): Promise<ArtifactHandle>;
  finishTask(input: WorkerResult): Promise<void>;
}
```

可额外支持：

```text
report_blocked
report_warning
```

但不要无限扩展事件类型。

---

# 17. Progress

Worker 应在有意义的阶段报告 progress。

不要按 token/tool call 频繁刷状态。

推荐时机：

- 完成一个阶段；
- 开始重要长步骤；
- 遇到重要变化；
- 进入等待；
- 发现阻塞；
- 用户主动查询前已有新信息。

Progress 数据建议：

```ts
interface ProgressInput {
  summary: string;
  currentAction?: string;
  completedSteps?: string[];
}
```

禁止 Worker 自己编造百分比，除非任务本身存在真实可计算进度。

---

# 18. Worker Question

Worker 缺必要信息时：

```text
Worker
↓ askParent
Runtime persists PendingQuestion
↓
Main receives question event
↓
Main determines user-facing wording
↓
SnowLuma send
```

Main 应保留 Worker 问题的原始语义，不应擅自改变技术选择含义。

如果问题可以通过：

- QQ lazy context；
- Memory；
- filesystem；
- Task history；

自行回答，Main 可以先尝试解决，而不是立刻打扰用户。

---

# 19. User Answer

用户回复问题：

```text
QQ reply
↓
SnowLuma
↓
Controller
↓
Runtime
↓
MessageBinding
↓
PendingQuestion answer persisted
↓
Worker steer/resume
```

Main 可以给用户一个自然确认。

答案必须先 durable，再认为 Worker 已获得信息。

---

# 20. Worker Result

Worker 完成时返回结构化结果：

```ts
interface WorkerResult {
  summary: string;

  outcome:
    | "COMPLETED"
    | "PARTIAL"
    | "FAILED";

  details?: string;

  artifacts?: string[];

  changes?: {
    projectId?: string;
    paths?: string[];
    commits?: string[];
  };

  memoryProposals?: string[];

  followUps?: string[];
}
```

Worker 不直接决定最终给用户展示的长文本。

---

# 21. Main 汇总 Worker 结果

Main 收到 Worker Result 后：

1. 读取 Task 当前状态；
2. 获取必要 Worker summary；
3. 如存在多个 Worker，检查其他 child Task；
4. 必要时再查询项目/Artifact/Memory；
5. 判断：
   - 可以完成用户目标；
   - 需要新的 Worker；
   - 需要用户选择；
   - 部分完成；
6. 生成用户-facing response；
7. 通过 SnowLuma Capability/MCP 发给用户。

因此：

```text
Worker output
≠
直接 QQ output
```

---

# 22. 多 Worker 汇总策略

Main 是默认 aggregator。

例如：

```text
Worker A Result
Worker B Result
Worker C Result
      │
      ▼
     Main
      │
  resolve conflicts
  inspect evidence
  decide next action
      │
      ▼
    User
```

Main 不应该简单拼接三个 Worker 文本。

应关注：

- 是否相互矛盾；
- 是否覆盖目标；
- 哪些结果已验证；
- 哪些只是建议；
- 是否需要额外 Worker 验证。

---

# 23. Worker 间通信

MVP 默认：

> Worker 不直接向另一个 Worker 建立长期通信通道。

需要共享信息时：

```text
Worker A
↓ result/progress/artifact
Task Runtime
↓
Main / Parent orchestration
↓
Worker B steering/context
```

这样避免：

- 隐式 Agent 网络；
- 不可观察的循环讨论；
- 权限传播不清晰；
- 难以恢复。

未来若确有需求，可增加受控 `send_to_child/parent`，但不能绕过 Task Runtime。

---

# 24. Parent / Child Task

如果一个大目标拆成子任务：

```text
Parent Task
├── Child Task A → Worker A
├── Child Task B → Worker B
└── Child Task C → Worker C
```

Parent Task 状态不简单等于所有 Child 状态。

Main / Task Runtime 根据目标判断完成条件。

例如：

```text
A COMPLETED
B FAILED
C COMPLETED
```

Parent 可以是：

```text
PARTIAL / FAILED / needs-replan
```

具体 Task 状态机由 `TASK_RUNTIME_DESIGN.md` 进一步定义。

---

# 25. 并发原则

MVP 可以支持多个 Worker 并行，但必须有资源约束。

至少考虑：

- 每个 Agent Home 总 Worker 上限；
- 每个用户/Task Worker 上限；
- 每个 project writer lock；
- Pi/API quota；
- CPU/Memory；
- Network。

Main 请求 spawn Worker 时，Runtime 可以：

```text
start now
queue
reject
```

Main 不拥有绕过资源限制的权限。

---

# 26. Workspace 冲突

默认：

```text
一个 project 同时最多一个 writer Worker
```

多个只读 Worker 可以并行。

如果两个 Worker 需要写同一 repo：

- 第二个排队；
- 或 Main 调整任务拆分。

MVP 不因为“多 Agent”就自动引入 Git worktree。

---

# 27. Existing Task Routing

用户可能不显式说 Task ID。

Main 可结合：

```text
reply binding
最近活跃 Task
conversation context
Task title/summary
用户文本
```

判断目标 Task。

优先级：

```text
明确 reply/binding
>
显式 Task ID
>
明显唯一的活跃 Task
>
Main semantic resolution
```

如果有多个可能 Task 且错误 steering 后果明显，Main 应向用户确认，而不是猜。

---

# 28. QUERY / FOLLOW_UP / INTERRUPT

Main 与 Task Runtime 之间统一语义：

## QUERY

```text
“做到哪了？”
```

读取 Task durable state/activity。

不打断 Worker。

## FOLLOW_UP

```text
“数据库换 PostgreSQL”
```

写 durable mailbox，再通过 Pi steering 等机制送给 Worker。

## INTERRUPT

```text
“停掉”
```

进入 cancellation 流程。

Main 负责理解自然语言，但 Runtime 决定合法动作和实际执行。

---

# 29. Main 回复策略

Main 不必等 Worker 完成才回复用户。

创建 Task 后应尽快：

```text
acknowledge
+
必要的 Task 概要
```

而不是保持 QQ turn 打开直到 Worker 结束。

Worker 完成后可以主动向 Main 产生 result event，Main 再发新的 QQ 消息。

---

# 30. 主动通知

Main 可以在这些情况下主动发消息：

- Task 完成；
- Task 失败；
- Worker 需要用户输入；
- 重要阻塞；
- 用户明确要求的阶段性通知。

避免：

- 每个 tool call 都通知；
- 高频“还在工作”刷屏；
- 无意义心跳。

---

# 31. SnowLuma 回复路径

正常 user-facing output 固定：

```text
Main
↓
Chat Platform Capability
↓
SnowLuma MCP / network action
↓
QQ
```

Main 可调用的 QQ 工具应是安全封装，例如：

```text
get_message
get_reply_context
get_history
send_message
send_reply
send_published_artifact
```

SnowLuma MCP 同时向 Main 提供固定 Schema 的 Progressive Discovery 工具：

```text
list_actions / search_actions / get_action
query_action (read-only)
invoke_action (side effect)
```

Main 先发现并读取 OneBot action 文档，再使用 `query_action` 或 `invoke_action`。这不是暴露 Pi 原生任意工具；Runtime 对两种通用 action 调用执行 Owner 身份检查并记录审计。Owner 可通过目录中实际存在的 action 操作 QQ，包括向指定用户私聊或处理收到的好友申请；Guest 仅可使用当前 Conversation 的安全封装。普通 Main 回复仍固定发往当前 Conversation。

---

# 32. SnowLuma MCP 的角色

SnowLuma MCP/Action Catalog 用于：

- Main lazy read；
- Main safe send；
- Main / Owner turn 的 OneBot action 发现；
- Owner 授权的 OneBot query / invoke，包括私聊与好友申请管理操作。

Inbound event streaming 不通过 MCP，仍按：

```text
SnowLuma → Host Controller → Runtime
```

Main 不需要知道 Host Controller 存在。

---

# 33. QQ Reply / 引用

Main 回复某条用户消息时，应尽可能保留 conversation/thread 语义。

Outgoing message 成功后 Runtime 应记录必要 MessageBinding：

```text
outgoing QQ message ID
→ Task / Question / Artifact / Main event
```

这样用户下一次直接 reply 时能稳定路由。

---

# 34. Attachment / File 语义

Main 收到含附件的 event reference 时：

1. 不要求 Controller 把完整文件塞进 prompt；
2. Main 通过 SnowLuma 查询 metadata；
3. 需要内容时通过允许的 download/ingest 路径进入 Agent Home；
4. 再委派 Worker。

出站 Artifact：

```text
Worker
→ Artifact Service
→ Main
→ SnowLuma
```

具体文件安全由 Artifact 详细设计负责。

---

# 35. Memory 与 Main

Main 是长期 Memory 的主要消费方。

Main turn 可获取：

```text
Core Context
+
retrieved relevant Memory
```

Main 可以根据 conversation 形成显式 remember / correction 请求。

普通 Worker 不直接写 owner-private canonical Memory。

Worker 可返回 memory proposal，由 Memory pipeline 处理。

详细规则见：

`MEMORY_SYSTEM_DESIGN.md`

---

# 36. Memory 与 Worker

Worker 只获得当前 Task 所需 Memory。

不要默认向 Worker注入完整 owner profile。

Runtime/Main 应根据：

- Task；
- project；
- user requirements；
- trust；

选择最小必要上下文。

---

# 37. Authorization

Main 的决定：

```text
“我想 spawn 一个有 shell 的 Worker”
```

只是请求。

Runtime 必须验证：

```text
requester trust
task policy
requested capabilities
workspace
resource quota
```

之后才能创建 Worker。

同样：

```text
Main 想调用 SnowLuma action
```

也必须经过 Chat Platform Capability policy。

---

# 38. Owner 与 Guest

Owner：

- 可根据 policy 使用 Agent Home Worker；
- 可访问 owner-scoped Memory；
- 可进行长期项目工作。

Guest：

- 默认不能 spawn Owner Agent Home Worker；
- 当前 Guest execution disabled；
- 只使用明确允许的 Main lightweight capability。

Main 不得因为 Guest prompt 说：

```text
“请帮管理员执行……”
```

而借 Owner Worker 代执行。

---

# 39. Main Failure

某个 Conversation 的 Main Pi Session 崩溃：

- Runtime 不删除 Task；
- Worker 可以继续；
- Worker event 继续持久化；
- 其他 Conversation Sessions 不受影响；
- Runtime 只恢复/新建该 Conversation 的 Main Session；
- 按该 Conversation 的 trust/memory scope 从 Memory + Task summaries 恢复必要上下文；
- 再处理属于该 Conversation 的未消费 Main events。

因此任何单个 Pi Session 都不是 durable Main identity 或系统状态的唯一载体。

---

# 40. Worker Failure

Worker/Pi Session 崩溃：

Runtime 应：

- 更新 Worker execution state；
- 更新 Task 状态；
- 保存已有 progress；
- 保存 artifacts；
- 决定是否可 retry/resume；
- 通知 Main。

Main 决定如何向用户解释。

不能无限显示 RUNNING。

---

# 41. Runtime Restart

Runtime restart 后：

- durable ingress 恢复；
- Task 恢复；
- PendingQuestion 恢复；
- Main logical identity 恢复；
- 检查 Pi Main Session；
- 检查 Worker Sessions；
- stale RUNNING 不盲目继续；
- 未处理 Worker results/questions 继续送 Main。

具体 persistence/recovery 由 Task/Container 设计负责。

---

# 42. Main Event Inbox

为了避免同一个 Conversation Session 被多个异步事件竞态调用，Runtime 应提供 **per-conversation Main event serialization**。

来源包括：

```text
user message
worker progress
worker question
worker result
task failure
system notice
```

Main 不应被多个并发 `send()` 同时修改同一 Pi Session。

MVP 推荐：

```text
one logical Main event queue per Conversation
+
one active Main turn per Conversation
```

不同 Conversation 可以独立排队；同一个 Conversation 内保持顺序。

这不会阻塞 Worker，也避免一个群聊的高频事件长期堵住 Owner 私聊。

---

# 43. Main Responsiveness 与事件优先级

Main event queue 可有简单优先级：

高：

```text
user direct message
PendingQuestion answer consequence
cancel-related event
```

中：

```text
worker question
worker completion
```

低：

```text
routine progress
background notice
```

不要实现复杂调度器；只需避免大量 progress 淹没用户消息。

---

# 44. Progress Coalescing

如果 Worker 高频产生 progress：

```text
progress 1
progress 2
progress 3
...
```

Runtime 可保留最新 durable state，并合并低价值 Main notifications。

Main 不需要对每条 progress 都产生一个 turn。

用户 `/status` 时直接读取 Task 当前状态。

---

# 45. Main Tool 面

Main 至少需要语义上等价的工具：

```text
QQ:
  get_message
  get_context
  send_message
  send_reply
  send_artifact

Task:
  create_task
  list_tasks
  get_task
  steer_task
  cancel_task

Worker:
  spawn_worker
  worker_status

Memory:
  retrieve_memory
  remember_explicit
  propose/correct memory

Artifact:
  inspect_artifact
  deliver_artifact

Usage:
  get_usage
```

具体工具数量可以合并。

不要把内部数据库 CRUD 全部暴露给 Main。

---

# 46. Worker Tool 面

Worker 至少：

```text
shell/filesystem/git/browser
report_progress
ask_parent
publish_artifact
finish_task
```

根据 Task capabilities 裁剪。

Worker 默认不获得：

```text
send_qq_anywhere
modify_owner_memory_directly
spawn_privileged_worker_without_runtime
change_authorization
```

---


## Pi Adapter 实施约束

本设计不冻结 Pi 的具体 API。

实现 Agent 必须根据项目实际使用版本的 Pi 文档/API/源码，实现真实 Harness Adapter，并至少覆盖本设计需要的语义：

```text
create/resume session
send
steer
abort
inspect/recover
event/tool handling
```

不得以 mock、placeholder、TODO 代替真实 Pi 集成。

如果 Pi 的低层 API 与本文示意不同，应在 Adapter 内吸收差异，保持：

```text
Main logical identity
Conversation Session
Task
WorkerExecution
```

这些上层语义不变。


# 47. Worker 是否允许 Spawn Child Worker

MVP 推荐：

> Worker 不直接 spawn Worker。

需要进一步拆分时：

```text
Worker
↓ ask/report need for subtask
Main / Runtime
↓
spawn child Worker
```

原因：

- 保持资源控制；
- 保持 parent/child Task 可见；
- 避免递归 swarm；
- 避免 Worker 自行扩权。

以后确有需要可提供受限 `request_subtask`，本质仍由 Runtime 决定。

---

# 48. 多 Agent 成本控制

多 Worker 不是越多越好。

Main 应优先考虑：

```text
单 Worker 能否完成？
```

只有明显可并行、可独立或需要不同上下文时才增加 Worker。

Runtime 可以限制：

```text
maxWorkersPerInstance
maxWorkersPerTask
maxWorkersPerProject
```

Quota 接近限制时，可以拒绝新的非必要 Worker，但不得静默改变用户要求。

---

# 49. Task Completion 与用户通知

Task terminal state 形成后：

```text
Task Runtime
↓
Main Event
↓
Main reads result
↓
Main user-facing summary
↓
SnowLuma
```

Main 回复应区分：

```text
完成
部分完成
失败
被取消
等待用户
```

不得把 Worker 的内部错误文本原样全部倾倒给用户。

---

# 50. 结构化 Orchestration Event

建议统一：

```ts
type OrchestrationEvent =
  | { type: "USER_MESSAGE"; eventId: string; context: MainTurnContext }
  | { type: "WORKER_PROGRESS"; taskId: string; workerId: string; data: unknown }
  | { type: "WORKER_QUESTION"; taskId: string; questionId: string }
  | { type: "WORKER_RESULT"; taskId: string; workerId: string; resultId: string }
  | { type: "TASK_FAILED"; taskId: string }
  | { type: "TASK_CANCELLED"; taskId: string };
```

Runtime 持久化 domain state。

Main event queue 可以引用 ID，而不是复制大量 payload。

---

# 51. Worker Identity

每个 Worker 至少有：

```ts
interface WorkerRef {
  workerId: string;
  taskId: string;
  harness: "pi";
  harnessSessionId?: string;
  status: string;
}
```

`harnessSessionId` 不作为外部公共 ID。

用户看到的是 Task，而不是 Pi Session。

---

# 52. Main 与 Task ID

Main 可以在自然回复中使用短 Task 标识，便于用户显式引用。

例如：

```text
Task #17 已开始，我会在需要确认时再问你。
```

但用户不应必须记 Task ID。

reply/binding 和自然语言 routing 应支持自然交互。

---

# 53. 结果可信度与验证

Main 汇总时应区分：

- Worker 已实际验证；
- Worker 仅代码阅读；
- Worker 推测；
- 外部条件阻塞。

如果需要高可信结论，可创建额外验证 Worker，但不要固定“双 Agent 审核所有任务”。

---

# 54. 不将 Worker Raw Reasoning 暴露给 Main

Main 不需要 Worker 私有 chain-of-thought。

Worker 只返回：

```text
progress
observations
decisions needed
results
evidence refs
artifacts
```

这样减少耦合和无效 token。

---

# 55. 可观察性

应能查询：

```text
Main status
Main current event
active Tasks
Workers per Task
Worker status
last progress
PendingQuestions
queued Main events
```

用户-facing `/status` 不需要展示所有内部字段。

内部日志应能通过 IDs 关联：

```text
eventId
messageId
taskId
workerId
questionId
artifactId
```

---

# 56. 测试要求

至少测试：

## Routing

- private message → Main；
- @ → Main；
- reply binding → existing Task/Question；
- control command 不进入 Main 语义 routing。

## Delegation

- 简单请求不 spawn Worker；
- 长任务可 spawn Worker；
- Main spawn 请求不能扩大 capability。

## Responsiveness

- Worker RUNNING 时 Main 可处理新 user event。

## Existing Task

- QUERY 不打断 Worker；
- FOLLOW_UP durable；
- INTERRUPT 触发 cancellation。

## HITL

- Worker question → Main → QQ；
- reply → Question → Worker resume。

## Multi-worker

- 两个独立 Worker 可并行；
- 同 project writer conflict 被阻止；
- Main 可汇总多个结果。

## Conversation isolation

- Owner 私聊与群聊使用不同 Main Session；
- 群聊 Session 不继承 owner_private Memory；
- `/new` 只轮换当前 Conversation Session；
- 一个 Conversation Session 崩溃不影响其他 Conversation。

## Failure

- Main Session 崩溃不删除 Task；
- Worker 崩溃不留下无限 RUNNING；
- Runtime restart 后未消费 Worker result 仍能送 Main。

## QQ

- Main outbound 走 SnowLuma Capability；
- Worker 不能直接任意发送 QQ。

---

# 57. MVP 验收

必须真实演示：

## 57.1 普通对话

```text
QQ event
→ Main
→ SnowLuma reply
```

## 57.2 单 Worker

```text
User request
→ Main delegates
→ Worker executes
→ Main remains responsive
→ Worker result
→ Main summarizes
→ QQ
```

## 57.3 Steering

```text
Worker running
→ User changes requirement
→ Main routes FOLLOW_UP
→ Worker receives steering
```

## 57.4 HITL

```text
Worker asks
→ Main asks user
→ user replies naturally
→ Worker resumes
```

## 57.5 Multiple Workers

至少一次真实演示：

```text
Main
├→ Worker A
└→ Worker B

A/B 独立工作
↓
Main obtains both results
↓
Main produces one coherent user response
```

不要求每个任务都多 Worker。

## 57.6 Failure Recovery

Main/Worker 任一 Session 故障后，durable Task state 仍正确。

---

# 58. 非目标

本设计当前不定义：

- Task DB 完整 schema；
- 所有 Task transition；
- SnowLuma 每个 action 的参数；
- Memory 内部 schema；
- Guest Sandbox；
- distributed multi-agent；
- Worker-to-Worker unrestricted messaging；
- autonomous recursive agent spawning；
- permanent specialist personas；
- consensus/voting swarm。

这些应由其他详细设计或真实需求驱动。

---

# 59. 与其他详细设计的边界

## `AGENT_HOME_CONTAINER_CONTROL_DESIGN.md`

拥有：

- SnowLuma inbound → Host Controller；
- persistent exec；
- durable ingress；
- container / state / backup。

本文从：

```text
Runtime 已拥有一个可信、durable 的 ingress event
```

开始讨论。

---

## `MEMORY_SYSTEM_DESIGN.md`

拥有：

- Canonical Memory；
- retrieval；
- Core Profile；
- scope；
- migration。

本文只规定 Main/Worker 如何消费或提议 Memory。

---

## `TASK_RUNTIME_DESIGN.md`

应拥有：

- Task schema；
- 状态机；
- mailbox persistence；
- PendingQuestion schema；
- MessageBinding persistence；
- parent/child Task；
- cancellation/recovery transactions；
- process ownership。

本文拥有这些对象在多 Agent 编排中的**语义用途**，不拥有其数据库细节。

---

## `AUTHORIZATION_CAPABILITY_DESIGN.md`（待建立）

应拥有：

- capability 定义；
- owner/guest；
- Tool authorization；
- resource quotas。

本文只规定 Main/Worker 的请求必须经过该安全边界。

---

## `QQ_SNOWLUMA_INTEGRATION_DESIGN.md`（待建立）

应拥有：

- SnowLuma action mapping；
- message/reply/media；
- safe send/query API；
- retry semantics。

本文只规定 Main 是 user-facing orchestrator，并通过 Chat Platform Capability 回复。

---

# 60. 最终不变量

1. **Main 是唯一默认 user-facing Agent。**
2. **Main 使用长期逻辑身份；不同 Conversation 使用独立、scope-safe 的 Pi Sessions。**
3. **Worker 是动态执行 Agent，不是固定 Persona。**
4. **Worker 工作不会阻塞 Main。**
5. **Main 可以按需创建多个 Worker，但不是默认 swarm。**
6. **Worker 默认不直接互相通信。**
7. **Worker 默认不直接操作任意 Chat Platform destination。**
8. **所有 user-facing 普通回复最终由 Main 通过 SnowLuma Capability/MCP 发出。**
9. **Task != Worker != Pi Session。**
10. **已有 Task 的 query/follow-up/interrupt 优先路由到原 Task。**
11. **Worker progress/question/result 使用结构化 Runtime 协议。**
12. **Worker question 统一由 Main 与用户交互。**
13. **Main 汇总多个 Worker 的结果，而不是简单拼接。**
14. **Main 的 capability 请求必须经过 Runtime 授权。**
15. **Main context 按需组合，不复制全部 QQ/Memory/Worker 历史。**
16. **Main Session 故障不能导致 Task/Memory 消失。**
17. **多 Agent 的复杂度必须由并行性或任务拆分的真实收益证明。**

---

# 61. Trusted Model Plane / Principal Execution Plane

当前实现中，Main 与 Worker 的 Pi 都运行在同一个 Trusted Model Plane UID（rootful 容器内 UID/GID 10002）。Pi 直接访问 provider，不存在 LLM reverse proxy；Pi 的 mount namespace 不包含 Principal workspace、SQLite、deployment secrets 或 project extensions。Provider auth/settings 位于 `/state/model/pi/agent`。

Worker Pi 只加载应用镜像里的 `worker-tools` Runtime extension，Main Pi 只加载应用镜像里的 `pi-tools` extension。两者均关闭 Pi built-in tools、自动 extensions、skills 与 context files。任何 workspace `.pi/extensions` 都不自动执行。

所有 Worker 的 shell 和文件工具均通过同一 Unix Runtime Tool socket 到 TaskService `ExecutionBackend`。Runtime token 对应服务端 Task/Worker/Principal 上下文；Worker 输入不能指定 Principal、UID/GID 或绝对 workspace。Owner 与 Guest 差别仅由 Principal 身份、capability、workspace 与 Guest policy 决定。
