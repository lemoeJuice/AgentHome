# Task Runtime Design

> 状态：详细设计基线  
> 上位设计：`AGENT_HOME_DESIGN.md` / `AGENT_HOME_DESIGN.md`  
> 相关设计：`MAIN_WORKER_ORCHESTRATION_DESIGN.md`、`MEMORY_SYSTEM_DESIGN.md`、`AGENT_HOME_CONTAINER_CONTROL_DESIGN.md`、`EXTERNAL_PLUGIN_COMMAND_DESIGN.md`

---

# 1. 目标

Task Runtime 是 Agent Home 内部的 durable execution control plane。

它负责回答：

```text
这个任务是什么？
现在处于什么状态？
有哪些 Worker？
用户刚刚追加了什么要求？
Worker 在等什么？
任务能否取消？
Runtime 重启后怎么恢复？
最终结果应该回到哪个 Conversation？
```

Task Runtime 不负责：

- Main 的自然语言推理；
- Worker 如何思考；
- Pi 的内部实现；
- Memory 抽取；
- SnowLuma 协议；
- Host Router 的 Direct Command；
- Plugin 业务逻辑。

核心目标：

> 即使 Main、Worker、Pi Session、Runtime 进程或 QQ 链路暂时中断，Task Runtime 仍然保存足够的 durable truth，让系统知道任务处于什么状态以及下一步如何安全继续。

---

# 2. 核心不变量

1. **Task != Worker。**
2. **Worker != Pi Session。**
3. **Task != Pi Session。**
4. **Pi Session 只是某次 Agent execution 的 Harness binding，不是 durable Task identity。**
5. **一个 Task 可以有 0..N 个 WorkerExecution。**
6. **一个 Task 可以有 0..N 个 child Task。**
7. **用户追加要求必须先持久化，再 steer Worker。**
8. **Worker question 必须先持久化，再向当前 Chat Platform 发问。**
9. **用户回答必须先持久化，再恢复/steer Worker。**
10. **Task cancellation 只有在确认相关 execution 已停止后才能进入 `CANCELLED`。**
11. **不把运行时错误分类无限扩张成 Task status。**
12. **异常、invariant violation、无法安全判断的情况记录为结构化 Runtime Event/Exception，并上抛 Main。**
13. **Runtime 能确定恢复的故障由 Runtime 自动恢复，不依赖 Main。**
14. **Runtime 无法安全决定下一步时停止危险动作并交给 Main。**
15. **任何重启恢复都不能凭数据库里的 `RUNNING` 就假设真实 execution 仍然存在。**

---

# 3. 核心对象关系

```text
Conversation
    │
    ▼
   Task
    │
    ├── WorkerExecution A
    │      └── Pi Session A
    │
    ├── WorkerExecution B
    │      └── Pi Session B
    │
    ├── Mailbox
    ├── PendingQuestion
    ├── Artifact
    ├── Event Log
    └── Child Task
```

Main 是 Task 的 orchestration caller，但 Task 生命周期不依赖某个 Main Pi Session。

---

# 4. Task

Task 表示一个用户可理解、可查询、可取消、可恢复的工作目标。

概念结构：

```ts
interface Task {
  id: string;

  title: string;
  goal: string;

  status: TaskStatus;

  requester: {
    platform: string;
    accountId: string;
    userId: string;
    principalId?: string;
  };

  trust: "OWNER" | "GUEST";

  originConversationId: string;
  notificationConversationId: string;

  parentTaskId?: string;

  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}
```

Task 不直接保存：

- Pi Session ID 作为身份；
- raw model chain-of-thought；
- ephemeral process object；
- in-memory Promise。

---

# 5. Task Status

Task status 只表达稳定、长期有意义的生命周期语义。

MVP：

```text
CREATED
QUEUED
RUNNING
WAITING_USER
PAUSED
COMPLETED
PARTIAL
FAILED
CANCELLED
INTERRUPTED
```

## 5.1 CREATED

Task 已创建并持久化，但尚未进入执行调度。

## 5.2 QUEUED

Task 已准备执行，但正在等待：

- Worker slot；
- project writer lock；
- resource limit；
- parent orchestration。

## 5.3 RUNNING

至少存在一个 active execution，且 Task 不处于 blocking user wait。

## 5.4 WAITING_USER

Task 当前需要用户提供信息后才能安全继续。

通常存在至少一个 blocking `PendingQuestion`.

## 5.5 PAUSED

Task 被显式暂停，但 execution continuity 仍可恢复。

MVP 如果没有真正 pause/resume 需求，可以暂不暴露此状态。

## 5.6 COMPLETED

目标已完成，Main/Runtime 已明确提交完成结果。

## 5.7 PARTIAL

已有有价值结果，但部分目标未完成。

不是所有 Worker fail 都自动等于 `PARTIAL`。

是否 Partial 是 Task-level completion decision。

## 5.8 FAILED

Task 无法完成，并且没有足够结果形成 Partial completion。

## 5.9 CANCELLED

取消已完成。

只有在 Runtime 已确认相关 execution 停止、资源释放完成后才进入。

## 5.10 INTERRUPTED

执行曾经开始，但 continuity 丢失，且当前没有确认仍在运行的 execution。

典型：

```text
DB says Worker RUNNING
but process / harness session cannot be recovered
```

`INTERRUPTED` 是明确设计过的恢复语义，不代表任意异常。

---

# 6. 不增加复杂异常状态

以下不作为 Task status：

```text
CANCELLING
CANCELLATION_FAILED
ABORT_TIMEOUT
LOCK_CONFLICTED
RECOVERY_FAILED
ADAPTER_BROKEN
```

原则：

```text
State
= durable business lifecycle truth

Event
= what happened

Runtime Exception
= something happened outside normal state-machine semantics
```

例如：

```text
Task = RUNNING

RuntimeException:
operation = cancel
workerId = w3
error = "process state cannot be confirmed"
```

Task 保持最后一个可信 lifecycle state。

Runtime：

1. 停止进一步危险动作；
2. 持久化 exception；
3. 发出 Main event；
4. 由 Main 决定如何向用户解释或请求下一步。

---

# 7. WorkerExecution

WorkerExecution 表示某个 Worker 对 Task 的一次具体执行实例。

概念：

```ts
interface WorkerExecution {
  id: string;
  taskId: string;

  role?: string;
  objective: string;

  status: WorkerStatus;

  harness: "pi";
  harnessSessionId?: string;

  workspaceId?: string;
  workspaceAccess?: "READ" | "WRITE";

  startedAt?: string;
  updatedAt: string;
  finishedAt?: string;
}
```

一个 Task 可以：

```text
Task RUNNING
├── Worker A COMPLETED
├── Worker B RUNNING
└── Worker C FAILED
```

这不自动决定 Task 最终状态。

---

# 8. Worker Status

MVP：

```text
PENDING
STARTING
RUNNING
WAITING_USER
STOPPING
COMPLETED
FAILED
CANCELLED
INTERRUPTED
```

`STOPPING` 可以作为内部 transient execution state，不要求向用户暴露。

Worker status 可以比 Task status 更细，因为它直接对应 execution lifecycle。

---

# 9. Pi Session

Pi Session 是 Harness execution handle。

关系：

```text
WorkerExecution
↓
Pi Session binding
```

Pi Session 可以：

- 创建；
- 恢复；
- 丢失；
- 被 abort；
- 被替换。

但：

```text
Pi Session lost
≠ Task deleted
≠ WorkerExecution identity lost
```

如果 Pi Session 无法恢复：

```text
WorkerExecution → INTERRUPTED
```

Task 再根据剩余 Worker 和 Main decision 继续处理。

---

# 10. Task Event Log

Task Runtime 保存关键 domain event。

不要求完整 event sourcing。

建议事件：

```text
TASK_CREATED
TASK_QUEUED
TASK_STARTED

WORKER_CREATED
WORKER_STARTED
WORKER_PROGRESS
WORKER_WAITING_USER
WORKER_COMPLETED
WORKER_FAILED
WORKER_INTERRUPTED

FOLLOW_UP_ADDED
QUESTION_CREATED
QUESTION_SENT
QUESTION_ANSWERED

CANCEL_REQUESTED
WORKER_CANCELLED
TASK_CANCELLED

TASK_COMPLETED
TASK_PARTIAL
TASK_FAILED
TASK_INTERRUPTED

RUNTIME_EXCEPTION
INVARIANT_VIOLATION
```

用途：

- restart recovery；
- debugging；
- audit；
- status explanation；
- Main context summary。

Event Log 不替代 current-state tables。

---

# 11. Task Mailbox

用户对运行中 Task 的后续交互先进入 durable mailbox。

类型：

```text
QUERY
FOLLOW_UP
INTERRUPT
```

概念：

```ts
interface TaskMailboxItem {
  id: string;
  taskId: string;

  type: "QUERY" | "FOLLOW_UP" | "INTERRUPT";

  sourceConversationId: string;
  sourceMessageId: string;

  content?: string;

  status:
    | "PENDING"
    | "DELIVERED"
    | "CONSUMED";

  createdAt: string;
}
```

---

# 12. QUERY

QUERY 不改变 Worker execution。

例如：

```text
“做到哪了？”
“现在还在跑吗？”
```

Runtime/Main 从：

- Task current state；
- Worker progress；
- recent Task events；

生成回答。

默认不 steer Worker。

---

# 13. FOLLOW_UP

FOLLOW_UP 表示用户修改或补充任务要求。

例如：

```text
“数据库换成 PostgreSQL”
“顺便把 README 也补上”
```

流程：

```text
User message
↓
resolve Task
↓
persist FOLLOW_UP
↓ COMMIT
select target Worker / Main orchestration
↓
steer
↓
mark delivered/consumed
```

必须：

> 先持久化，再调用 Harness。

如果：

```text
DB commit succeeded
but Pi steer failed
```

Runtime 仍可知道这条 follow-up 没有成功 delivery，并进行确定性恢复或交给 Main。

---

# 14. INTERRUPT

INTERRUPT 触发 Task cancellation flow。

例如：

```text
/stop
“别做了”
```

是否属于明确 cancel intent，由 Router/Main/Runtime command semantics 决定。

进入 Runtime 后必须 durable 记录：

```text
CANCEL_REQUESTED
```

再执行取消。

---

# 15. PendingQuestion

Worker 需要用户信息时，不允许：

```text
await in-memory Promise
```

必须创建 durable `PendingQuestion`。

概念：

```ts
interface PendingQuestion {
  id: string;

  taskId: string;
  workerId: string;

  question: string;

  status:
    | "OPEN"
    | "ANSWERED"
    | "CLOSED";

  outgoingMessageId?: string;

  answer?: string;

  createdAt: string;
  answeredAt?: string;
  closedAt?: string;
}
```

---

# 16. Worker Question Flow

```text
Worker
↓ askParent()
Runtime
↓
persist PendingQuestion OPEN
+
event QUESTION_CREATED
↓ COMMIT
Main event
↓
Main formats user-facing question
↓
SnowLuma send
↓
persist outgoing MessageBinding
+
question.outgoingMessageId
↓
Worker waits
```

如果 Chat Platform send 失败：

- PendingQuestion 仍然存在；
- Runtime/Main 可以重试 send；
- 不丢问题。

---

# 17. User Answer Flow

```text
User reply
↓
MessageBinding
↓
PendingQuestion
↓
persist answer
+
status = ANSWERED
+
mailbox / Worker delivery intent
↓ COMMIT
steer/resume Worker
```

先 commit，再 steer。

如果 steer 失败：

- answer 不丢；
- question 已经回答；
- delivery 可以恢复或升级 Main。

---

# 18. Question 并发规则

MVP：

- 一个 Worker 默认最多一个 blocking `OPEN` question；
- 一个 Task 可以同时存在来自不同 Worker 的多个 OPEN question；
- Main 可以选择合并多个 question 后一次询问用户；
- 合并只影响 presentation，不改变底层 question identity。

Task cancellation 时：

```text
OPEN question
→ CLOSED
```

不能继续接受旧问题回答作为 Worker resume。

---

# 19. MessageBinding

Runtime 维护自己的 Chat Platform MessageBinding。

平台原始 `messageId` 不能视为全局唯一。

概念：

```ts
interface PlatformMessageRef {
  platform: string;
  accountId: string;

  platformConversationId: string;
  threadId: string | null | NotImplemented;

  messageId: string;
}

interface MessageBinding {
  message: PlatformMessageRef;

  bindingType:
    | "TASK"
    | "PENDING_QUESTION"
    | "ARTIFACT"
    | "MAIN_MESSAGE";

  bindingId: string;

  createdAt: string;
}
```

Router 自己的 Direct Command binding 不属于这里，但必须使用同样的平台 namespace 原则。

Runtime 可为 `PlatformMessageRef` 生成内部稳定 key 作为数据库索引。

---

# 20. Conversation Binding

Task 必须记录：

```text
originConversation
notificationConversation
```

两者默认相同。

例如：

```text
Task #17
originConversation = group:123
notificationConversation = group:123
```

即使之后：

```text
/new
```

轮换了该 Conversation 的 Main Pi Session，Task 仍然回到：

```text
group:123
```

而不是依赖“当前 Main Session”。

---

# 21. Task 被其他 Conversation 查询

例如 Task 在群 A 创建，Owner 后来私聊：

```text
“群里刚才那个任务怎么样了？”
```

Main 可以根据权限查询 Task。

但：

```text
query from private conversation
≠ notification target automatically changed
```

只有显式动作才改变 notification target。

---

# 22. 多 Worker

多个 Worker 的使用由 Main orchestration 决定。

Task Runtime 只提供：

```text
createWorkerExecution()
startWorker()
steerWorker()
stopWorker()
observeWorker()
```

默认拓扑仍然是：

```text
Main
├── Worker A
├── Worker B
└── Worker C
```

Worker 不直接自由创建子 Worker。

---

# 23. Parent / Child Task

不是每个 Worker 都创建 child Task。

默认：

```text
一个用户目标
→ 一个 Task
→ 多个 WorkerExecution
```

只有当子目标具有独立 lifecycle 时才创建 child Task，例如：

- 可以单独查询；
- 可以单独取消；
- 可以独立完成/失败；
- 生命周期明显长于一次 Worker execution；
- 需要自己的 notification/ownership。

结构：

```text
Parent Task
├── Child Task A
└── Child Task B
```

Child Task 仍然使用完整 Task Runtime 语义。

---

# 24. Task Completion

Worker 完成不自动等于 Task 完成。

例如：

```text
Worker A COMPLETED
Worker B COMPLETED
```

Main 仍可能决定：

```text
需要第三个 Worker
```

所以 Task completion 必须是明确 domain action：

```text
finishTask(COMPLETED | PARTIAL | FAILED)
```

Runtime 可以计算候选状态，但不能仅根据 Worker terminal 状态自动认定用户目标已完成。

---

# 25. Progress

Worker 可以上报结构化 progress：

```ts
interface TaskProgress {
  taskId: string;
  workerId: string;

  summary: string;
  phase?: string;

  createdAt: string;
}
```

Progress：

- 持久化 recent records；
- 可供 `/status` / QUERY 使用；
- 不直接注入长期 Memory；
- 不要求每一条都发 QQ。

Main 决定哪些 progress 值得通知用户。

---

# 26. Cancellation

取消是 Runtime 的确定性 control action。

正常流程：

```text
cancel request
↓
persist CANCEL_REQUESTED
↓ COMMIT
stop accepting new FOLLOW_UP for affected execution
↓
abort Pi Session
↓
terminate owned processes
↓
release locks
↓
close PendingQuestion
↓
Worker → CANCELLED
↓
if Task cancellation complete:
Task → CANCELLED
↓
notify user
```

重要：

> 只有确认相关 execution 已停止后，Task 才进入 `CANCELLED`。

---

# 27. Cancellation 异常

如果发生：

```text
Pi abort returned unexpected error
process termination cannot be confirmed
lock ownership inconsistent
```

不创建：

```text
CANCELLATION_FAILED
```

Runtime：

```text
keep last trusted Task state
↓
persist RUNTIME_EXCEPTION
↓
stop unsafe continuation
↓
emit Main event
```

Main 再决定：

- 如何向用户解释；
- 是否建议重试；
- 是否需要人工确认；
- 是否继续其他独立 Worker。

---

# 28. Process Ownership

Worker 启动的外部进程必须能被 Runtime 追踪。

至少：

```ts
interface OwnedProcess {
  id: string;
  taskId: string;
  workerId: string;

  pid: number;
  processGroupId?: number;

  commandSummary: string;

  startedAt: string;
}
```

Unix 环境优先使用：

```text
process group / cgroup-like ownership
```

而不是只 kill 顶层 PID。

取消 Worker 时必须终止其 owned process tree。

---

# 29. Workspace Access

Worker 创建时声明：

```text
READ
WRITE
```

MVP：

```text
同一个 project
多个 READ 可以并发

WRITE
→ 单 writer lock
```

不引入复杂 worktree orchestration。

---

# 30. Project Writer Lock

概念：

```ts
interface ProjectLock {
  projectId: string;
  mode: "WRITE";

  ownerWorkerId: string;

  acquiredAt: string;
}
```

规则：

- 一个 project 同时最多一个 WRITE owner；
- Worker terminal 后释放；
- restart recovery 检查 stale lock；
- 只有 Runtime 能确认 owner execution 已不存在时才自动释放。

如果出现违反 invariant 的双 writer：

```text
INVARIANT_VIOLATION
```

而不是创造新的 Task status。

---

# 31. Restart Recovery

Runtime 启动后执行 reconciliation。

流程：

```text
1. open database
2. load non-terminal Tasks
3. load PendingQuestion
4. load pending mailbox
5. inspect WorkerExecution
6. inspect actual Harness / process reality
7. reconcile locks
8. emit recovery events
9. resume deterministic work
```

核心：

```text
DB says RUNNING
≠ execution is alive
```

---

# 32. Worker Recovery

对于数据库中的 active Worker：

## 可确认仍然存在

例如 Harness 能恢复 session / process ownership 可确认：

```text
keep RUNNING
```

## 无法恢复

```text
Worker → INTERRUPTED
```

并记录：

```text
WORKER_INTERRUPTED
```

Task 再根据：

- 是否还有其他 active Worker；
- 是否已有结果；
- Main orchestration；

决定下一步。

---

# 33. PendingQuestion Recovery

Runtime restart 后：

```text
OPEN PendingQuestion
```

继续存在。

如果已经有：

```text
outgoingMessageId
```

则继续等待 reply。

如果 question 已创建但消息还没成功发送：

```text
Main event queue
→ retry presentation/send
```

不能丢失 question。

---

# 34. Mailbox Recovery

未消费：

```text
FOLLOW_UP
```

必须继续存在。

Runtime 恢复 Worker 后：

- 可以重新 delivery；
- 如果 Worker 已 INTERRUPTED，则把事件交给 Main；
- Main 决定是否启动 replacement Worker。

---

# 35. Known Recovery vs Unknown Exception

## Runtime 自动恢复

适用于规则明确的情况：

```text
control transport reconnect
known Pi session reconnect
stale process confirmed dead
stale lock owner confirmed terminal
unsent question retry
undelivered mailbox retry
```

## 上抛 Main

适用于：

```text
无法确认 process 是否还在执行
数据库状态违反 invariant
Harness 返回不可能状态
恢复后 Task 目标是否仍可完成需要业务判断
多个结果互相冲突
```

原则：

> deterministic recovery stays in Runtime; semantic judgment or unsafe ambiguity goes to Main.

---

# 36. Runtime Exception

概念：

```ts
interface RuntimeExceptionEvent {
  id: string;

  taskId?: string;
  workerId?: string;

  operation: string;
  category: string;

  summary: string;
  details?: unknown;

  createdAt: string;
}
```

这里的 `category` 用于日志/调试，不参与 Task 状态机。

Main 收到的是结构化摘要，不是底层 stack trace 全量倾倒。

---

# 37. Invariant Violation

违反系统内部不变量时：

1. 停止可能造成进一步破坏的动作；
2. 记录 `INVARIANT_VIOLATION`；
3. 保留最后可信 durable state；
4. 上抛 Main；
5. 不“猜”一个新的业务状态。

例如：

```text
same project has two confirmed WRITE lock owners
```

不能自动选一个 winner。

---

# 38. 事务原则

核心原则：

> **先持久化意图，再执行不可恢复的外部 side effect。**

---

# 39. Task Creation Transaction

同一事务：

```text
insert Task
+
insert TASK_CREATED event
```

commit 后才允许创建 Worker。

---

# 40. Worker Question Transaction

同一事务：

```text
insert PendingQuestion OPEN
+
insert QUESTION_CREATED event
+
必要时 update Task WAITING_USER
```

commit 后再通知 Main。

---

# 41. User Answer Transaction

同一事务：

```text
PendingQuestion → ANSWERED
+
persist answer
+
insert QUESTION_ANSWERED
+
insert Worker delivery intent / mailbox item
```

commit 后再 `steer()`。

---

# 42. Follow-up Transaction

```text
insert FOLLOW_UP mailbox item
+
insert FOLLOW_UP_ADDED event
```

commit 后再 delivery。

---

# 43. Cancellation Transaction

取消请求先：

```text
insert CANCEL_REQUESTED event
+
mark cancellation intent
```

commit 后才执行 abort/kill。

execution 真正停止后，再单独事务：

```text
Worker → CANCELLED
Task → CANCELLED if applicable
+
events
```

---

# 44. External Side Effects

以下都视为 external side effect：

```text
Pi send / steer / abort
process spawn / kill
SnowLuma send
artifact publish
```

数据库不能假设这些调用一定成功。

因此需要：

```text
durable intent
→ external call
→ durable outcome
```

而不是：

```text
external call
→ hope DB update succeeds
```

---

# 45. Task State Derivation

Runtime 可以根据 facts 提供候选状态。

例如：

```text
blocking OPEN question
→ candidate WAITING_USER

active Worker
→ candidate RUNNING

queued Worker and no active Worker
→ candidate QUEUED

all Workers interrupted and no safe continuation
→ candidate INTERRUPTED
```

但：

```text
COMPLETED
PARTIAL
FAILED
```

通常需要 Main / Task orchestration 明确提交。

---

# 46. Main Event Integration

Task Runtime 向 Main 发结构化事件：

```text
TASK_CREATED
TASK_PROGRESS
TASK_QUESTION
TASK_RESULT
TASK_EXCEPTION
TASK_INTERRUPTED
```

事件进入：

```text
per-conversation Main event queue
```

Main 不直接轮询 Runtime DB。

---

# 47. Worker Event Integration

Worker 向 Runtime 的核心接口：

```text
reportProgress()
askParent()
publishArtifact()
finishWorker()
failWorker()
```

Worker 不直接：

- 修改 Task DB；
- 修改 Task status；
- 发 QQ；
- 创建长期 Memory；
- 获得新的 capability。

---

# 48. Artifact 关系

Task Runtime 只保存 Artifact reference：

```text
taskId
workerId
artifactId
```

文件安全、上传、下载、retention 由 Artifact Service 负责。

Worker 不能：

```text
qq_send_file(path)
```

---

# 49. Authorization

Task 创建时保存：

```text
requester
trust
capability set/reference
```

Worker capability 不得超过 Task。

Task Runtime 不自行推断权限。

详细规则由：

```text
AUTHORIZATION_CAPABILITY_DESIGN.md
```

负责。

---

# 50. Persistence Schema

MVP 至少：

```text
tasks
worker_executions
task_events
task_mailbox
pending_questions
message_bindings
task_artifacts
project_locks
owned_processes
runtime_exceptions
```

可以使用单一 SQLite。

---

# 51. 建议关键索引

至少：

```text
tasks(status)
tasks(origin_conversation_id)
tasks(notification_conversation_id)

worker_executions(task_id, status)

task_events(task_id, created_at)

task_mailbox(task_id, status)

pending_questions(task_id, status)

message_bindings(platform, account_id, platform_conversation_id, thread_id, message_id)

project_locks(project_id)

owned_processes(worker_id)
```

---

# 52. 唯一约束

建议：

```text
MessageBinding:
(platform, account_id, platform_conversation_id, thread_id, message_id, binding_type, binding_id) UNIQUE

ProjectLock:
project_id UNIQUE WHERE mode = WRITE

PendingQuestion:
可通过应用层保证 one OPEN per Worker
```

具体 SQLite schema 可以在实现阶段定。

---

# 53. Task 查询

Runtime 至少提供：

```text
getTask(taskId)
listTasks(requester/scope)
getTaskStatus(taskId)
getTaskProgress(taskId)
getTaskWorkers(taskId)
```

Main/Control Command 通过稳定 Runtime API 使用，不直接拼 SQL。

---

# 54. Task Mutation API

至少：

```text
createTask()
createWorker()
startWorker()

addFollowUp()
answerQuestion()

requestCancel()

finishTask()
failTask()
markTaskPartial()
```

以及内部：

```text
recordProgress()
recordRuntimeException()
```

---

# 55. `/status`

`/status` 只读 Runtime truth。

不要求调用 Main。

可以展示：

```text
Task
status
active Workers
last progress
waiting question
```

---

# 56. `/tasks`

`/tasks` 是 deterministic query。

根据 requester / authorization scope 过滤。

不由 Main 猜 Task 可见性。

---

# 57. `/stop`

Task resolution 顺序：

```text
explicit task id
→ reply binding
→ exactly one active task
→ otherwise ask user to select
```

不要让 Main 随机猜。

选定后：

```text
requestCancel(taskId)
```

---

# 58. `/new`

`/new` 不属于 Task cancellation。

它只轮换当前 Conversation 的 Main session。

已有 Task：

```text
继续存在
继续执行
继续按 notificationConversation 通知
```

---

# 59. Runtime 与 Main 的边界

Runtime 决定：

```text
state transition validity
durable persistence
delivery ordering
recovery
locks
process ownership
cancellation mechanics
```

Main 决定：

```text
是否需要创建 Task
如何拆 Worker
是否接受 Partial result
异常情况下如何解释
是否继续/重开 Worker
最终 user-facing response
```

---

# 60. Runtime 与 Harness 的边界

Harness Adapter 提供：

```text
createSession()
resumeSession()
send()
steer()
abort()
inspect()
events()
```

Task Runtime 不依赖 Pi 私有内部结构。

Pi 只是 MVP adapter。

---

# 61. Runtime 与 Memory 的边界

Task Runtime 可以向 Main 提供：

```text
Task summary
Task result
important events
```

但不直接决定哪些内容成为长期 Memory。

Worker 也不能直接写 owner long-term Memory。

---

# 62. 典型流程：新长任务

```text
User
↓
Main
↓ createTask()
Task CREATED
↓
createWorker()
↓
Task RUNNING
Worker RUNNING
↓
Pi work
↓
progress
↓
finishWorker()
↓
Main evaluates result
↓
finishTask(COMPLETED)
↓
notify origin/notification Conversation
```

---

# 63. 典型流程：用户 Follow-up

```text
User
“数据库改成 PostgreSQL”
↓
resolve Task
↓
persist FOLLOW_UP
↓ COMMIT
↓
steer Worker
↓
continue work
```

---

# 64. 典型流程：Worker 问用户

```text
Worker
↓ askParent()
PendingQuestion OPEN
↓
Main
↓
platform question #900
↓
binding #900 → question
↓
User reply
↓
Question ANSWERED
↓ COMMIT
↓
steer Worker
```

---

# 65. 典型流程：取消

```text
User /stop
↓
resolve task
↓
persist CANCEL_REQUESTED
↓
abort Worker
↓
terminate owned processes
↓
release locks
↓
Worker CANCELLED
↓
Task CANCELLED
↓
notify user
```

---

# 66. 典型流程：取消异常

```text
User /stop
↓
persist CANCEL_REQUESTED
↓
abort
↓
process state cannot be confirmed
```

Runtime：

```text
keep last trusted Task state
↓
record RUNTIME_EXCEPTION
↓
stop unsafe continuation
↓
Main event
```

不创建：

```text
CANCELLATION_FAILED
```

---

# 67. 典型流程：Runtime Restart

```text
Runtime restart
↓
load Task #17 RUNNING
↓
Worker #3 RUNNING in DB
↓
Pi session missing
↓
Worker #3 INTERRUPTED
↓
record event
↓
Main event
↓
Main decides resume / replacement Worker / user notification
```

---

# 68. 故障测试

MVP 必须覆盖以下真实场景。

## 68.1 Runtime crash during Worker execution

验证：

- Task 不丢；
- recovery 不产生 phantom RUNNING；
- Worker 可恢复或进入 INTERRUPTED。

## 68.2 Question persisted, platform message not sent

验证：

- restart 后 question 仍存在；
- 可以再次发送。

## 68.3 platform question sent, Runtime crash

验证：

- outgoing binding 保留；
- reply 仍能 resolve。

## 68.4 User answer committed, steer 前 crash

验证：

- answer 不丢；
- recovery 后可以继续 delivery。

## 68.5 Follow-up committed, Worker unavailable

验证：

- mailbox 不丢；
- Main 能看到 undelivered follow-up。

## 68.6 Cancel during child process

验证：

- Pi abort；
- process tree terminated；
- lock released；
- Task 只有确认停止后才 CANCELLED。

## 68.7 Cancel cannot confirm process state

验证：

- 不生成复杂 cancel failure state；
- 记录 RuntimeException；
- Main 收到异常事件。

## 68.8 Multiple Workers

```text
A COMPLETED
B RUNNING
C FAILED
```

验证 Task 仍可 RUNNING。

## 68.9 Writer lock conflict

验证第二个 WRITE Worker 排队，而不是同时写。

## 68.10 Restart with stale lock

只有确认旧 owner execution 已终止才释放。

## 68.11 `/new` while Task running

验证：

- Main Conversation Session 轮换；
- Task 不取消；
- Worker 不停止；
- notification target 不变。

## 68.12 Main Session crash

验证 Task/Worker 继续存在。

---

# 69. MVP 非目标

当前不设计：

- distributed scheduler；
- cross-machine Worker migration；
- complex DAG engine；
- speculative execution；
- automatic task retry policy engine；
- Git worktree orchestration；
- arbitrary nested Worker spawning；
- user-configurable Task state machine；
- exhaustive operational error states。

---

# 70. 实现顺序

推荐：

## Phase 1

```text
Task
WorkerExecution
Event Log
basic state transitions
```

## Phase 2

```text
Mailbox
PendingQuestion
MessageBinding
```

## Phase 3

```text
Cancellation
Process Ownership
Project Lock
```

## Phase 4

```text
Restart Recovery
Runtime Exception escalation
```

## Phase 5

```text
Multi-worker
Parent/Child Task
Partial completion
```

---

# 71. 最终原则

Task Runtime 的最终职责不是“让所有东西都自动恢复”。

而是：

> **在任何时刻保存足够可靠的 durable truth，能区分什么已经发生、什么仍在运行、什么需要用户、什么可以确定恢复，以及什么已经超出 Runtime 的安全判断边界。**

可以确定恢复：

```text
Runtime 处理
```

需要语义判断：

```text
Main 处理
```

无法安全判断：

```text
停止危险动作
+
记录异常
+
Main 处理
```

而不是继续膨胀状态机。
