# Agent Home 主设计文档

> 状态：当前系统级架构基线  
> 目标：定义跨模块职责、不可违反的系统不变量、MVP 验收标准，以及详细设计文档之间的边界  
> 主实现语言：TypeScript + Node.js  
> 当前 Harness：Pi  
> 当前聊天平台：QQ  
> 当前 QQ Adapter：SnowLuma / OneBot  
> 当前容器基线：Rootless Podman

---

# 1. 文档层级与实现阅读顺序

本文件只负责**系统级设计**。

以下详细设计文档属于实现时的必读规范：

1. [`MEMORY_SYSTEM_DESIGN.md`](./MEMORY_SYSTEM_DESIGN.md)  
   负责长期记忆系统的内部模型、公共接口、Canonical/Derived Data、Scope、Provenance、Temporal Validity、Export/Import。

2. [`AGENT_HOME_CONTAINER_CONTROL_DESIGN.md`](./AGENT_HOME_CONTAINER_CONTROL_DESIGN.md)  
   负责 Rootless Podman、Agent Home 容器边界、Router→Controller→Control Stream、`/state`、备份恢复、迁移，以及 SnowLuma 真实适配要求。

3. [`MAIN_WORKER_ORCHESTRATION_DESIGN.md`](./MAIN_WORKER_ORCHESTRATION_DESIGN.md)  
   负责 Main logical identity、Conversation Session、Main/Worker/Pi 编排、多 Worker、Worker progress/question/result 与 Main user-facing response。

4. [`EXTERNAL_PLUGIN_COMMAND_DESIGN.md`](./EXTERNAL_PLUGIN_COMMAND_DESIGN.md)  
   负责 Bot Gateway、Router、Control/Direct Command、加载式 Plugin、CommandRegistry、AgentActionRegistry、Gateway MCP、Router persistence 与 Direct Command context bridge。

5. [`TASK_RUNTIME_DESIGN.md`](./TASK_RUNTIME_DESIGN.md)  
   负责 durable Task/Worker execution semantics：状态机、Mailbox、PendingQuestion、MessageBinding、取消、process ownership、project lock、restart recovery、事务边界与 RuntimeException。

6. [`AUTHORIZATION_CAPABILITY_DESIGN.md`](./AUTHORIZATION_CAPABILITY_DESIGN.md)  
   负责 Identity / Trust / Capability、Conversation boundary、capability propagation/attenuation、confused-deputy prevention，以及 Memory/Project/QQ/Plugin/Task/Artifact 的确定性授权边界。

7. [`ARTIFACT_FILE_DESIGN.md`](./ARTIFACT_FILE_DESIGN.md)  
   负责 QQ inbound file/image、Agent/Worker/Gateway Plugin Artifact、文件注册/发布/发送权限、路径验证、跨 filesystem transfer 与 retention。

实现 Agent 在修改以下领域之前必须先阅读对应详细设计：

```text
Memory / Profile / Retrieval / Forget / Import / Export
→ MEMORY_SYSTEM_DESIGN.md

Container / Router→Controller transport / Podman / Bootstrap /
Backup / State Volume / Runtime ingress / SnowLuma integration
→ AGENT_HOME_CONTAINER_CONTROL_DESIGN.md

Main / Worker / Pi orchestration / Conversation Session /
Delegation / Multi-worker / Worker question-result
→ MAIN_WORKER_ORCHESTRATION_DESIGN.md

SnowLuma Router / Direct Command / Gateway Plugin /
CommandRegistry / AgentActionRegistry / Gateway MCP
→ EXTERNAL_PLUGIN_COMMAND_DESIGN.md

Task / WorkerExecution / Mailbox / PendingQuestion /
Cancellation / Process / Lock / Recovery / RuntimeException
→ TASK_RUNTIME_DESIGN.md

Identity / Owner / Guest / Capability / Permission /
Memory scope / Project access / QQ access / Plugin Action permission
→ AUTHORIZATION_CAPABILITY_DESIGN.md

File / Image / Attachment / Artifact / Publish /
Upload / Download / Send file
→ ARTIFACT_FILE_DESIGN.md
```

## 1.1 文档冲突处理

优先级按职责范围判断，而不是简单“后写的覆盖前写的”。

- 本文档拥有：系统组件边界、跨模块数据流、核心产品语义、MVP 总体验收标准。
- `MEMORY_SYSTEM_DESIGN.md` 拥有：Memory 内部设计。
- `AGENT_HOME_CONTAINER_CONTROL_DESIGN.md` 拥有：容器、Host Controller、控制通道和部署边界设计。
- `MAIN_WORKER_ORCHESTRATION_DESIGN.md` 拥有：消息进入 Main 之后的 Main/Worker/Pi 多 Agent 编排与 user-facing response 语义。
- `EXTERNAL_PLUGIN_COMMAND_DESIGN.md` 拥有：Host-side Router/Controller/SnowLuma 分层、Direct Command、Gateway 加载式插件、Command/Action Registry 与 MCP bridge。
- `TASK_RUNTIME_DESIGN.md` 拥有：Task/Worker durable state、Mailbox、PendingQuestion、MessageBinding、取消、恢复、锁与 RuntimeException。
- `AUTHORIZATION_CAPABILITY_DESIGN.md` 拥有：Identity/Trust/Capability、权限传播、Conversation scope 与各资源边界的 deterministic authorization。
- `ARTIFACT_FILE_DESIGN.md` 拥有：文件/Artifact 生命周期、路径安全、跨域 transfer、publish/send 权限和 retention。
- `IMPLEMENTATION_LOG.md` 只记录实现事实、临时方案和偏差，**不能推翻设计文档**。

如果发现冲突：

1. 不要自行选择其中一个然后静默继续；
2. 先判断冲突属于哪个文档的职责范围；
3. 按该范围的权威文档实现；
4. 同时修正文档中的过时内容；
5. 在 `IMPLEMENTATION_LOG.md` 记录修正。

---

# 2. 项目目标

本项目不是普通的“QQ Bot + LLM”，也不是只有临时 workspace 的 coding agent。

核心产品语义：

> Agent 是一个长期存在的数字个体，拥有自己的持久 Linux Home，并通过 QQ 与用户保持联系。

用户应该能够：

- 正常聊天；
- 发起持续几分钟、几小时甚至更久的工作；
- Worker 工作期间继续和 Main 对话；
- 查询 Task 状态；
- 中途修改需求；
- 回答 Worker 的问题；
- 取消 Task；
- 接收生成文件和结果；
- 在未来继续使用以前留下的项目、工具、记忆和状态。

必须成立：

```text
Runtime 重启           ≠ Agent 失忆
Task 完成              ≠ 项目被删除
Worker 结束             ≠ 工作环境被删除
Pi Session 结束         ≠ Task 被删除
Container restart      ≠ Agent Home 状态被清空
Host Controller restart ≠ Worker 自动停止
```

---

# 3. 非目标

当前不追求：

- 多 IM 平台统一框架；
- 多 Harness 通用框架；
- Kubernetes / 分布式调度；
- 多机集群；
- 多租户 SaaS；
- per-task VM、nested container 或完整 cgroup 管理；
- 每个 Worker 一个容器；
- 复杂 Git worktree 调度；
- 向量数据库作为前置依赖；
- Graph DB 作为前置依赖；
- 自动购买额度或自动改计费策略；
- 大型 Web 管理后台。

原则：

> 只有真实故障模式证明需要某个组件时才加入。

---

# 4. 总体架构

```text
                           QQ
                           │
                           ▼
               SnowLuma → Router → Controller
                                      │
                           authenticated IPC
                                      ▼
┌─────────────────────────────────────────────────────┐
│ Agent Home                                          │
│  Control Plane: Runtime / Task / Principal / SQLite │
│                  │                                  │
│                  ▼                                  │
│  Model Plane: Trusted Pi UID 10002 + Pi auth        │
│                  │ Runtime tool protocol            │
│                  ▼                                  │
│  Execution Plane: Worker + Principal UID/GID        │
│      ┌───────────┴────────────┐                     │
│      Owner workspace      Guest workspace           │
└─────────────────────────────────────────────────────┘
```

Owner and Guest share the same Trusted Pi Runtime and Principal-scoped ExecutionBackend. Pi receives only fixed trusted Runtime extensions; it has no workspace mount and no unrestricted built-in tools. `GUEST_PERSISTENT_SANDBOX_DESIGN.md` defines the UID/GID filesystem and network boundary.

---

# 5. 核心组件

## 5.1 Chat Platform Abstraction

聊天平台是当前系统中**唯一需要正式预留多实现的外部平台抽象**。

原因：

- QQ 与 Telegram 等平台可能同时接入；
- 同一个 Agent 可能同时存在多个平台上的 Conversation；
- Router / Task / Memory / Authorization 不应硬编码 QQ 字段；
- 未来新增平台不应要求修改 Agent Runtime 核心模型。

当前唯一生产实现：

```text
ChatPlatformAdapter
└── QQ / SnowLuma / OneBot
```

未来可以增加：

```text
ChatPlatformAdapter
├── QQ / SnowLuma
└── Telegram
```

但当前 MVP **不要求实现 Telegram**。

### 5.1.1 不为 Container / Harness 建通用多后端框架

当前：

```text
Container runtime = Rootless Podman
Harness = Pi
```

这两者可以各自放在清晰的 integration module 中，便于测试和隔离第三方 API，但不建立：

```text
Container backend registry/factory
Universal Harness framework
Multi-harness capability negotiation
```

除非未来出现真实的第二实现需求。

也就是说：

> 正式可插拔抽象只做 Chat Platform；Podman 与 Pi 直接实现当前真实需求。

### 5.1.2 通用平台字段

Adapter 把平台原始事件转换成统一模型。

至少统一：

```ts
interface PlatformIdentityRef {
  platform: string;
  accountId: string;
  userId: string;
}

interface ConversationAddress {
  platform: string;
  accountId: string;

  kind: "private" | "group";

  platformConversationId: string;

  threadId: string | null | NotImplemented;
}

interface PlatformMessageRef {
  platform: string;
  accountId: string;

  platformConversationId: string;
  threadId: string | null | NotImplemented;

  messageId: string;
}

interface ChatEvent {
  platform: string;
  accountId: string;

  sender: PlatformIdentityRef;
  conversation: ConversationAddress;

  message: {
    ref: PlatformMessageRef;

    text: string | null;
    replyTo: PlatformMessageRef | null | NotImplemented;
    mentionsBot: boolean | NotImplemented;

    attachments: ChatAttachmentRef[];
  };

  timestamp: string;

  extensions?: Record<string, unknown>;
}
```

`extensions` 只保存平台特有 metadata。

Runtime 核心逻辑不能依赖某个平台专属 `extensions` 才能完成普通聊天、Task、Authorization 或 MessageBinding。

### 5.1.3 `null` 与 `NOT_IMPLEMENTED`

统一语义：

```text
null
= 平台支持这个概念，但当前对象没有值

NOT_IMPLEMENTED
= 这个平台不支持这个字段/能力
```

例如：

```text
replyTo = null
```

表示平台支持 reply，但当前消息不是 reply。

而：

```text
threadId = NOT_IMPLEMENTED
```

表示当前平台没有 thread/topic 概念。

不要把两者混在一起。

在 TypeScript 内可以使用稳定 sentinel/type 表示 `NOT_IMPLEMENTED`；持久化或跨进程传输时必须使用明确的结构化表示，而不是依赖 magic string 猜测。

### 5.1.4 通用平台方法

Chat Platform boundary 提供一组通用能力，例如：

```text
sendMessage()
getMessage()
getRecentMessages()
getReplyTarget()
fetchAttachment()
sendArtifact()

editMessage()
deleteMessage()
addReaction()
```

如果某个平台没有对应能力：

```text
return NOT_IMPLEMENTED
```

而不是：

- 假装成功；
- silently no-op；
- 在 Runtime 到处写 `if platform == ...`。

调用方收到 `NOT_IMPLEMENTED` 后可以：

- 使用通用降级方案；
- 省略可选功能；
- 由 Main 向用户解释平台限制。

### 5.1.5 平台 Adapter 负责转换，不负责业务语义

Adapter 负责：

```text
raw platform event/action
↕
common Chat Platform model
```

不负责：

- Task；
- Main reasoning；
- Memory；
- capability grant；
- Direct Command business logic；
- Worker；
- Conversation Session policy。

当前 QQ 实现：

```text
QQ
↕
SnowLuma / OneBot
↕
QQChatPlatformAdapter
↕
common Chat Platform model
```

### 5.1.6 多平台 Conversation Identity

不能使用：

```text
private:<userId>
group:<groupId>
```

作为跨平台全局 identity。

平台原始 identity 至少包含：

```text
platform
accountId
platformConversationId
threadId?
```

Runtime 为其分配内部稳定：

```text
conversationId
```

例如：

```text
QQ bot A / private 123
→ conversation UUID A

Telegram bot B / private 456
→ conversation UUID B
```

即使两个平台最终绑定到同一个人，也默认使用不同 Conversation / Main Pi Session。

### 5.1.7 Platform Identity 与 Principal Identity

跨平台时必须区分：

```text
Platform Identity
↓ explicit account binding
Principal Identity
↓
Conversation Identity
```

例如：

```text
qq:user:123 ───────┐
                   ├── principal:owner
telegram:user:456 ─┘
```

跨平台账号关联必须显式建立。

禁止根据：

- nickname；
- username；
- avatar；
- LLM 推断；

自动判断两个平台账号是同一个人。

可以共享：

```text
Principal-scoped long-term Memory
```

但仍不共享 Conversation Session。

### 5.1.8 多平台 Session

默认：

```text
one Conversation
→ one Main Pi Session binding
```

因此：

```text
QQ private
→ Session A

Telegram private
→ Session B

QQ group
→ Session C

Telegram group/topic
→ Session D
```

即使 QQ 与 Telegram identity 绑定到同一个 Principal：

```text
Principal / Memory 可以共享
Conversation / Pi Session 不共享
```

避免跨平台短期上下文串线。

### 5.1.9 MessageRef 必须带平台 namespace

任何 MessageBinding 都不能把：

```text
messageId
```

当作全局唯一。

必须使用完整：

```text
platform
accountId
platformConversationId
threadId?
messageId
```

或 Runtime 内部稳定 MessageRef ID。

Router 的 Direct Command MessageBinding 与 Runtime 的 Task/PendingQuestion MessageBinding 都遵守同样原则。

### 5.1.10 Wake Policy 按平台配置

Wake Policy lookup 至少支持：

```text
global default
↓
platform default
↓
account override
↓
conversation override
```

例如：

```yaml
chat:
  platforms:
    qq:
      commandRequireMention: false
      naturalLanguageMode: observe_all

    telegram:
      commandRequireMention: true
      naturalLanguageMode: explicit_wake
```

Telegram 只是配置模型示例，不代表 MVP 必须实现 Telegram Adapter。

### 5.1.11 当前 SnowLuma 实现要求

实现 Agent 必须阅读当前 SnowLuma / OneBot 文档、API、README 或公开源码接口，实现真实 `QQChatPlatformAdapter`。

不得用 fake client / mock-only adapter / TODO 代替生产 QQ 集成。

SnowLuma 只是当前 QQ Adapter 的底层实现，不应泄漏到 Task / Memory / Authorization 的核心数据模型。

---

## 5.2 Bot Gateway / Router

Host-side Bot Gateway 接收 Chat Platform Adapter 规范化后的入站事件；当前 QQ 实现来自 SnowLuma / OneBot。

Router 负责：

- 区分 Control Command / Direct Command / Natural Language；
- Direct Command 的外部插件路由；
- Direct Command 的短期 CommandInvocation / binding；
- 将需要 Agent 处理的事件交给 Controller。

Router 不负责：

- Task；
- Main；
- Worker；
- Pi；
- Memory；
- Agent Home 生命周期。

Router 与 Controller 在 MVP 可以位于同一个 `bot-gateway` 进程，但模块职责保持独立。

详细设计见：

`EXTERNAL_PLUGIN_COMMAND_DESIGN.md`

---

## 5.3 Host Controller

Host Controller 是宿主机上的薄 Agent transport/lifecycle 模块。

Chat Platform Adapter 的规范化事件先经过 Host-side Router；只有需要 Agent Runtime 处理的事件才交给 Controller。

Controller 负责：

- 接收 Router 产生的 Agent ingress event；
- 保留 Router 提供的可信平台身份 metadata；
- 将事件可靠注入 Agent Home；
- 管理 Agent Home 生命周期；
- bootstrap / backup / restore / health 等 Host-side orchestration。

不负责：

- Command parsing / Direct Command routing；
- Plugin business routing；
- Main reasoning；
- Task scheduling；
- Pi Session；
- Memory；
- Worker；
- Chat Platform outbound business action。

详细通信和容器边界见：

`AGENT_HOME_CONTAINER_CONTROL_DESIGN.md`

---

## 5.4 Agent Home

Agent Home 是 Owner Agent 的长期 Linux 运行环境。

当前基线：

```text
Rootless Podman
单个长期 Agent Home container
单个 canonical /state
无 Host filesystem 业务共享
```

Agent Home 包含：

- Runtime；
- Main；
- Pi；
- Workers；
- Memory；
- Runtime persistence；
- Projects；
- Artifacts；
- Agent 用户态配置。

容器、迁移、备份和 Control Stream 的所有详细规则由：

`AGENT_HOME_CONTAINER_CONTROL_DESIGN.md`

定义。

---

## 5.5 Runtime / Control Plane

Runtime 是 Agent Home 内的可信控制平面。

原则：

> LLM 决定“想做什么”；Runtime 决定“是否允许做、如何可靠执行”。

Runtime 负责：

- Durable ingress consumption；
- wake policy；
- deterministic commands；
- identity / authorization；
- capability assignment；
- Task 生命周期；
- Worker 生命周期；
- mailbox；
- PendingQuestion；
- MessageBinding；
- workspace locking；
- Artifact policy；
- cancellation；
- restart recovery；
- Runtime persistence；
- usage policy。

Runtime 不应把 authorization 交给 LLM。

---

## 5.6 Main Agent

Main 是用户长期接触的主对话 Agent。

负责：

- 正常聊天；
- 理解自然语言意图；
- 判断是否需要 Task / Worker；
- 创建、查询、steer、cancel Task；
- 按需读取 QQ 上下文；
- 使用长期 Memory；
- 将 Worker question 转达给用户；
- 将 Worker progress / result 呈现给用户；
- 调用允许的共享 Capability。

Main 默认不拥有 unrestricted shell。

---

## 5.7 Pi Harness

Pi 是当前 MVP 使用的 Harness。

Pi 提供实际 Agent Session / Tool Loop 能力。

要求：

- Main 可由 Pi 驱动；
- Worker 可由独立 Pi Session 驱动；
- Runtime 能创建、发送、steer、abort、观察 Pi Session；
- Pi Session 只是 Harness 实现细节。

必须保持：

> Task != Pi Session

当前不实现 multi-harness framework，但 Pi 接入必须有窄边界，避免业务状态直接依赖 Pi 内部格式。

---

## 5.8 Worker

Worker 是持续工作的执行 Agent。

负责：

- shell；
- filesystem；
- Git；
- coding；
- browser/tool；
- task-local scripts；
- progress；
- ask_parent；
- artifact proposal/publish；
- task completion。

Worker 不直接拥有任意 Chat Platform destination。

---

## 5.9 Memory Service

Memory 是独立系统模块。

上层只允许通过 Memory 公共接口访问。

Main / Worker / Runtime 禁止直接依赖：

- Memory SQLite schema；
- FTS 实现；
- embedding backend；
- Graph backend；
- 某第三方 memory framework。

关键系统级语义：

- Harness History != Long-term Memory；
- Machine Truth != Memory；
- Memory 必须可迁移；
- 用户显式记忆必须可保留、解释、纠正、删除；
- Memory Scope 属于安全边界；
- Worker 默认不能直接污染 Owner 长期 Memory。

详细设计见：

`MEMORY_SYSTEM_DESIGN.md`

---

## 5.10 Artifact Service

Artifact Service 管理 Agent 对外输出文件。

它是：

```text
Worker filesystem
→ External QQ file delivery
```

之间的安全边界。

禁止 Worker 直接：

```text
send_file("/arbitrary/path")
```

Artifact 必须先被发布为受控对象，再由 Main / Chat Platform Capability 发送。

---

## 5.11 Usage Service

Usage Service 提供只读模型额度/使用信息。

当前优先使用 Codex App Server 已支持的 account/rate-limit/usage 能力。

默认策略：

```text
display
warn
```

不自动：

- 买 credits；
- consume reset credit；
- 改订阅；
- 偷偷切模型；
- 取消用户要求的 Task。

---

# 6. 入站与出站通信语义

## 6.1 Chat 入站与可配置 Wake Policy

高层路径固定为：

```text
Chat Platform
↓
Platform Adapter
↓
Bot Gateway / Router
↓
Wake Policy
├── Direct / Control Command
└── Natural Language
        ↓
    Controller
        ↓
persistent Control Stream
        ↓
Runtime durable ingress
        ↓
Main
```

Wake Policy 不写死为单一 QQ 交互方式，而是部署级或群级配置。

命令消息和自然语言消息分开配置。

### 6.1.1 Command Wake Policy

私聊中的命令正常解析。

群聊中的命令至少支持：

```text
commandRequireMention = false
```

表示：

```text
/score
/status
```

即可触发。

以及：

```text
commandRequireMention = true
```

表示只有：

```text
@Bot /score
@Bot /status
```

等显式指向 Bot 的命令才触发。

是否要求 mention 是 Router/Wake Policy 配置，不由插件各自决定。

### 6.1.2 Natural Language Wake Policy

群聊自然语言至少支持两种模式。

#### `observe_all`

```text
所有符合基础过滤条件的群消息
↓
Router
↓
Controller
↓
Main
↓
Main 自己判断是否需要回复
```

此模式下：

- Main 可以读取群里的连续自然对话；
- “是否回复”属于 Main 的语义判断；
- 不要求每条消息都产生 QQ 回复；
- Runtime 仍然执行正常的 identity / authorization / memory-scope 限制。

#### `explicit_wake`

```text
普通群消息
→ 不创建 Main turn

@Bot / reply Bot / 其他配置的显式唤醒
→ Main turn
```

被显式唤醒后，Main 可以通过 Chat Platform Capability 按需读取：

```text
recent group history
quoted/replied message
images
files
user information
```

从而获得必要上下文，而不是要求 Router 预先把整段群历史塞入事件。

### 6.1.3 配置边界

Wake Policy 只决定：

> 这条消息是否形成 Bot command invocation 或 Main turn。

它不决定：

- requester 权限；
- Memory scope；
- Worker capability；
- Plugin Action capability；
- 是否允许读取敏感资源。

这些仍由授权层确定。

Main 在 `observe_all` 模式下看到一条群消息，也不意味着它因此获得额外权限。

### 6.1.4 建议配置粒度

MVP 至少支持全局默认值，并允许按群覆盖：

```text
default
└── group overrides
```

例如概念配置：

```yaml
qq:
  group:
    commandRequireMention: false
    naturalLanguageMode: observe_all

  overrides:
    "123456":
      commandRequireMention: true
      naturalLanguageMode: explicit_wake
```

具体配置文件格式属于实现细节。

Platform Adapter 只负责协议转换；Control Stream、ACK、去重、Durable Ingress Queue、backpressure、重连等细节见：

`AGENT_HOME_CONTAINER_CONTROL_DESIGN.md`

---

## 6.2 QQ 出站

高层路径固定为：

```text
Main / Runtime
↓
Chat Platform Capability
↓
SnowLuma network API
↓
QQ
```

Host Controller 不参与普通出站消息。

这样避免 Controller 演变为第二套 QQ SDK。

---

## 6.3 Lazy QQ Context

入站事件只需携带处理所需的可信 metadata 和必要 payload。

Main 需要：

- 原消息；
- reply；
- 群历史；
- 图片；
- 文件；
- 用户资料；

时，通过 SnowLuma Capability 按需查询。

不要把大量群历史预先塞入每次 Main context。

即使使用 `observe_all`，单次 Main turn 仍以当前消息和必要 metadata 为主；只有 Main 判断确实需要时才 lazy-fetch 更多历史。

`explicit_wake` 模式下尤其如此：未唤醒消息不形成 Main turn，但可以在后续被唤醒时作为按需上下文读取。

---

# 7. 身份、信任与授权

必须区分：

```text
chat identity
authorization identity
execution identity
```

可信身份只能来自平台 transport metadata，而不是自然语言。

例如：

```text
“我是 owner”
```

不能改变权限。

每个 Task 必须携带 requester / trust / capability context。

身份和权限语义必须沿：

```text
SnowLuma event
→ Controller trusted envelope
→ Runtime
→ Main
→ Task
→ Worker
```

传播。

Guest 不得通过 Main 获得 Owner Worker 权限。

---

# 8. Main / Worker 多 Agent 编排

系统采用：

```text
一个长期 Main logical identity
+
按 Conversation scope 隔离的 Main Pi Sessions
+
动态 Worker Agents
+
Runtime / Task Control Plane
```

而不是单 Agent 执行所有长任务，也不是固定 Persona swarm。

系统级约束：

- Main 是唯一默认 user-facing logical Agent，但不同私聊/群聊使用独立、scope-safe 的 Pi conversation sessions；
- Worker 长任务不能阻塞 Main；
- Main 可以根据任务需要创建一个或多个 Worker；
- Worker 默认不直接与用户或其他 Worker 建立自由通信；
- Task != Worker != Pi Session；
- 用户对已有工作的 QUERY / FOLLOW_UP / INTERRUPT 应优先路由到已有 Task；
- Worker progress / question / result 必须通过 Runtime 结构化返回；
- Worker 需要用户输入时由 Main 统一询问；
- 多 Worker 结果由 Main 汇总后形成一个连贯回复；
- 正常 user-facing 回复由 Main 通过 SnowLuma Capability/MCP 发送；
- Main/Worker 的具体 Pi Session 生命周期不应泄露为产品状态。

具体包括：

- Main logical identity、Conversation scope 与独立 Pi Session 的创建/恢复；
- MainTurnContext；
- Direct / Existing Task / New Delegated Work 路由；
- Worker spawn policy；
- 多 Worker 并行和 parent/child；
- Worker prompt/capability；
- progress/question/result 协议；
- Main event queue；
- Worker failure/Main failure；
- Main 汇总与 SnowLuma 回复；

全部见：

`MAIN_WORKER_ORCHESTRATION_DESIGN.md`

---

# 16. Command / Tool / Capability

必须保持三个概念独立：

```text
Command
= 人类稳定接口

Tool
= Agent-facing interface

Capability / Service
= 实际实现
```

## 16.1 Control / Model / Execution Planes

当前执行架构有三个安全域：

```text
Control Plane
  Router / Controller / Runtime / SQLite / Principal / Task / policy

Model Plane
  Trusted Pi process / provider credentials / trusted extensions / agent loop

Execution Plane
  Worker tools / shell / filesystem / build tools / Principal workspace
```

Pi 不拥有 Principal workspace mount，也不启用 unrestricted built-in tools。只有部署镜像中的固定 Runtime extension 能进入 Pi；Principal workspace 的 `.pi/extensions` 不会加载。

Owner 与 Guest 共用 Pi、Runtime Tool Protocol 和 `ExecutionBackend`。Runtime 从 Task/Worker/Principal 的持久可信记录构造 `ExecutionContext`（task、worker、Principal、UID/GID、role、capability、workspace、session）；模型输入只提供 operation 参数，不能指定身份、UID 或 workspace root。shell、read/write/edit、mkdir/remove/list/stat 均通过 backend 以目标 Principal UID/GID 执行。

Pi provider auth 位于 `/state/model/pi/agent`，由 Model Plane UID 10002 持有。Principal execution 不获得 provider token、auth path bind、环境变量副本或临时凭据文件。系统当前没有通用 `secret.read` 或 raw secret export tool；未来需要服务凭据时必须将 `secret.use` 与 `secret.export` 分开，默认不提供 `secret.export`。Model Plane 直接访问模型 provider，不经过 LLM reverse proxy。

Worker 工作区按 origin Conversation 隔离并共享：同一群聊/私聊的 Tasks 使用该会话的稳定工作区身份和目录，不同 Conversation 使用不同 UID 与目录。调用者 Principal 不因此合并；每个 Worker 的读写权限仍由发起者当前 Capability 快照约束。工作区路径使用 Conversation ID 的 SHA-256 目录名，不把平台 ID 或 Principal ID 直接作为文件路径。个人 Home/Cache/Artifacts 则保留在以 runtime UID 命名的 Principal 目录中；旧的 `/state/home`、`/state/projects` symlink 兼容层不再创建。

Guest execution 另外受 `guest.enabled`、Principal capability、UID/GID filesystem permission 与 Guest UID nftables policy 约束。Model Plane provider networking 不受 Guest egress rules 限制。

禁止：

> 一个 Command 必须对应一个独立实现。

例如：

```text
/stop
↓
TaskService.cancel()

Main Tool cancel_task
↓
TaskService.cancel()
```

应该复用同一 Capability。

---

# 17. Control Commands

MVP 控制命令至少包括：

```text
/status
/tasks
/stop
/new
/usage
/help
```

`/mode`、`/access` 等只有在实际产品语义确定后再稳定下来。

Privilege-changing command 必须由 deterministic Runtime 处理。

---

# 18. Workspace

每个 Conversation 使用 Agent Home 内独立、持久的 project workspace；同一 Conversation 的不同调用者共享文件，但各自 Task/Worker 的权限仍独立授权。

MVP：

```text
/state/workspaces/conversations/<sha256(conversation-id)>/projects/<workspace-id>
+
per-conversation execution UID/GID and caller Capability check
+
conversation-scoped writer lock
```

不要提前加入 Git worktree。

当真实出现：

> 两个 Worker 必须同时写同一 repository

再升级 workspace strategy。

Workspace 属于 Agent Home state，不依赖 Host project directory。

---

# 19. Artifact 高层规则

Artifact Service 必须：

- 校验真实路径；
- 校验允许的 storage scope；
- 校验 Task ownership；
- 校验敏感文件；
- 校验大小；
- 生成稳定 artifact record。

发送到 QQ 必须经过：

```text
Worker
→ Artifact Service
→ Main / Chat Platform Capability
→ SnowLuma
```

不能把任意文件路径直接暴露给 SnowLuma action。

---

# 20. Memory 高层规则

Memory 的内部结构不在本文重复描述。

本文只保留跨系统约束：

1. Memory 是独立模块；
2. Main 通过 API 读取；
3. Worker 默认提交 proposal，而不是直接永久写 Owner Memory；
4. Memory Scope 必须由代码强制；
5. Memory 不替代 filesystem/Git/process 等 Machine Truth；
6. Memory migration 不依赖 Pi、SnowLuma 或容器实现；
7. Memory 的详细 MVP 和 schema 必须遵守 `MEMORY_SYSTEM_DESIGN.md`。

---

# 21. Guest

当前：

```text
Guest execution = disabled
```

Guest 可以只拥有明确允许的轻量能力。

Guest 不允许：

- Owner Agent Home shell；
- Owner projects；
- owner_private memory；
- Owner credential；
- 通过 Main 间接 spawn privileged Worker。

未来 Guest execution 必须使用独立 Disposable Sandbox。

不要把 Guest hostile workload 放进 Owner Agent Home。

---

# 22. Persistence 责任边界

不要把整个系统的 persistence 混成一个“SQLite 就行”。

应区分逻辑 ownership：

```text
Runtime Persistence
├── Tasks
├── Task mailbox
├── PendingQuestion
├── MessageBinding
├── Artifact metadata
├── Ingress queue
└── Recovery metadata

Memory Persistence
└── 由 Memory Service 自己拥有

Agent Home State
└── 由 /state 迁移契约拥有
```

这些实现可以在 MVP 中共享同一个 SQLite engine/file，也可以分开。

但上层模块不能通过跨模块 SQL 直接访问别人的表。

---

# 23. Restart Recovery

系统重启时必须以真实执行状态为准。

至少：

```text
COMPLETED / CANCELLED / FAILED
→ 保留历史

WAITING_USER
→ 恢复 PendingQuestion

RUNNING
→ 不直接继续声称 RUNNING
→ 检查 Harness / process state
→ 决定 INTERRUPTED / resume
```

必须避免 phantom RUNNING Task。

Container / Control Stream 恢复细节见容器详细设计。

---

# 24. Cancellation

`/stop` 必须代表真实取消。

高层语义：

```text
User /stop
↓
Runtime
↓
Task cancel
↓
Pi abort / owned process termination
↓
release Task-owned resources
↓
confirmed cancellation
```

不能在实际执行仍继续时回复“已经停止”。

取消 Task 不销毁 Agent Home。

---

# 25. Progress

禁止伪造百分比。

优先展示：

- Task 状态；
- 已完成步骤；
- 当前动作；
- 最近 activity；
- elapsed time。

Worker 主动 `reportProgress` 应成为主要语义来源。

Harness raw events 只能辅助。

---

# 26. 技术基线

当前基线：

```text
TypeScript
Node.js 26 environment target
SQLite
Pi
SnowLuma / OneBot
Rootless Podman
```

要求正常工程链：

```text
package.json
tsconfig.json
build
start
dev
test
typecheck
```

不要把：

```bash
node --experimental-strip-types ...
```

作为唯一长期启动方式。

业务架构不要依赖 Node 26 独有特性，除非有明确收益并记录。

---

# 27. 推荐代码边界

目录名不是强制，依赖方向才是约束。

概念上：

```text
host-controller/
├── snowluma-ingress
├── instance-driver
└── control-transport

agent-runtime/
├── control-ingress
├── runtime
├── auth
├── main
├── orchestration
├── tasks
├── harness/pi
├── workers
├── qq-capability
├── artifacts
├── memory-api integration
├── usage
└── persistence

memory/
└── 独立模块，详见 MEMORY_SYSTEM_DESIGN.md

deployment/
└── Rootless Podman / image / state / backup
```

禁止依赖方向：

```text
Host Controller → Pi internals
Host Controller → Memory DB
Main → Memory SQLite tables
Worker → SnowLuma raw unrestricted write API
Memory → SnowLuma
Memory → Pi
```

---

# 28. End-to-End 主流程

## 28.1 普通消息

```text
User QQ
↓
SnowLuma
↓
Host Controller
↓
persistent Control Stream
↓
Runtime
↓
Main
↓
SnowLuma direct network send
↓
QQ
```

---

## 28.2 长任务

```text
User
↓
QQ / SnowLuma / Controller
↓
Runtime
↓
Main
↓
TaskService.create
↓
Pi Worker
↓
Agent Home filesystem/tools
↓
progress/result
↓
Task Runtime
↓
Main
↓
SnowLuma
↓
QQ
```

---

## 28.3 Worker 提问

```text
Worker
↓
PendingQuestion
↓
Main
↓
SnowLuma
↓
QQ
↓ user reply
SnowLuma
↓
Controller
↓
Runtime
↓
MessageBinding
↓
PendingQuestion resolve
↓
Pi steer/resume
```

---

## 28.4 Artifact

```text
Worker
↓
Artifact Service
↓
Main
↓
SnowLuma network API
↓
QQ
```

Host Controller 不读取 artifact 文件。

---

# 29. 实现状态不属于主设计

本文不再保存：

```text
“当前已经实现了哪些文件”
“现在有几个测试”
“当前还剩哪些具体 TODO”
```

这些信息变化太快。

应该记录在：

```text
IMPLEMENTATION_LOG.md
```

如需要更直观的实时进度，可新增：

```text
STATUS.md
```

但不能把动态实现状态重新写回架构规范。

---

# 30. MVP Blocking 能力

以下属于核心能力，不允许只用：

```text
interface
mock
stub
TODO
```

宣称完成。

必须真实集成或确实被无法自行解决的外部条件阻塞：

1. SnowLuma 真实 inbound；
2. Host Controller 真实接收；
3. persistent Control Stream；
4. Runtime durable ingress；
5. Main 真实 LLM/Pi 驱动；
6. Main 真实 SnowLuma outbound；
7. Task → real Pi Worker；
8. Worker 在 Agent Home 内真实工作；
9. progress/result 回到 Main；
10. Worker question → QQ → reply → Worker resume；
11. `/stop` 实际终止 Worker/Harness execution；
12. Rootless Podman Agent Home；
13. `/state` 持久化与重启恢复；
14. Memory Service 按独立设计接入 Main；
15. 正常 build/typecheck/test；
16. 至少一个真实 E2E demo。
17. Owner/Guest 共用 Model Plane 与 Runtime Tool interface；真实 OS UID 测试证明 workspace/credential isolation。

Principal-scoped ExecutionBackend 与 Model Plane credential isolation 属于 MVP security blocking；per-task VM/cgroup、Graph Memory、Git worktree、multi-harness 不属于当前 MVP blocking。

---

# 31. MVP 验收标准

## 31.1 真实主链路

必须实际演示：

```text
真实 QQ
↓
真实 SnowLuma
↓
Host Controller
↓
persistent Control Stream
↓
Runtime
↓
真实 Main
↓
Task
↓
真实 Pi Worker
↓
Agent Home
↓
result
↓
Main
↓
真实 SnowLuma
↓
QQ
```

Mock 不满足此项。

---

## 31.2 Main responsiveness

Worker 工作期间：

```text
用户：“做到哪了？”
```

Main 可及时回复。

---

## 31.3 HITL

Worker 发起真实问题。

Main 通过 QQ 询问。

用户 reply。

Runtime 通过 MessageBinding 找到 PendingQuestion。

Worker 获得答案继续执行。

---

## 31.4 Persistence

Agent Home restart 后：

- `/state` 仍存在；
- Projects 仍存在；
- Runtime DB 仍存在；
- Memory 仍存在；
- 已完成 Task 仍存在。

---

## 31.5 Restart Recovery

Runtime restart：

- PendingQuestion 不丢；
- Waiting Task 不丢；
- 不产生 phantom RUNNING；
- durable ingress 不丢已 ACK 事件。

---

## 31.6 Cancellation

真实 Worker 执行 long-running process。

`/stop` 后：

- Harness 被 abort；
- owned process 停止；
- lock/resources 释放；
- Task 进入正确终态。

---

## 31.7 Security

Guest 不能：

- spawn Owner privileged Worker；
- 读 owner_private Memory；
- 使用 Owner Agent Home shell；
- 获取任意 credential；
- 通过 artifact 发送越界敏感文件。

---

## 31.8 Memory

至少验证：

- Main 能获得 Core/长期相关 Memory；
- 明确“记住”内容可以跨 Runtime/Pi Session 使用；
- Memory 与 Pi Session 生命周期解耦；
- scope enforcement 生效；
- export/import 基础路径可工作。

更详细的 Memory MVP 以 `MEMORY_SYSTEM_DESIGN.md` 为准。

---

# 32. 自动实现规则

项目可以无人值守执行。

### A. 局部、可逆实现细节

选择最简单方案并继续。

### B. 非 MVP 必要的未来能力

保留窄接口或 disabled，继续其他工作。

### C. MVP 必须能力存在未决实现选择

选择：

```text
最小
保守
可逆
最少权限
```

但不能把核心能力永久 stub 掉并宣称完成。

涉及安全：

```text
deny > allow
least privilege > convenience
disabled > broad access
```

所有重要临时实现写入 `IMPLEMENTATION_LOG.md`。

---


# 32.1 外部系统适配的实现要求

Pi 与当前 QQ/SnowLuma Adapter 的**具体 API 形态不由本设计文档重复定义**。

原因是：

- Pi / Harness 的实际接口可能随版本变化；
- SnowLuma / OneBot 的实际事件、action、MCP/API 细节应以当前实现为准；
- 本设计负责规定系统边界、数据流和不变量，而不是冻结第三方项目的某一版函数签名。

因此，实现 Agent 必须遵循以下要求。

## Pi

实现 Agent 必须：

1. 阅读项目当前使用版本的 Pi 官方文档、README、API 文档或源码中公开接口；
2. 确认真实可用的 session 创建、恢复、消息发送、steer、abort、event/tool handling 等能力；
3. 在 `MAIN_WORKER_ORCHESTRATION_DESIGN.md` 与 `TASK_RUNTIME_DESIGN.md` 已定义的 Harness Adapter 边界内实现真实 Pi adapter；
4. 将 Pi 的真实 event/session semantics 映射到 Runtime 的 WorkerExecution / Main Conversation Session 模型；
5. 如果 Pi API 与设计假设存在差异，优先保持本项目的上层不变量，并在 adapter 内吸收差异；
6. 不得因为设计文档没有列出具体 Pi API 调用就留下 fake adapter、mock-only adapter、TODO 或“后续接入”。

需要完成的是**真实可运行集成**。

## QQ / SnowLuma Chat Platform Adapter

实现 Agent 必须：

1. 阅读当前使用版本的 SnowLuma 文档、README、OneBot 接口说明、MCP/API 文档或源码中公开接口；
2. 确认真实的 inbound event 接入方式、消息结构、reply/@/file/image 等 segment、发送 action、history/context 查询以及连接/重连语义；
3. 按本设计规定的：

```text
SnowLuma
↓
Router / Wake Policy
↓
Controller
↓
Runtime
```

实现真实入站集成；

4. 按本设计规定的 Agent outbound / Router Direct Command outbound 路径实现真实发送和查询能力；
5. 将 OneBot/SnowLuma 细节限制在 `QQChatPlatformAdapter` / Platform integration 层，不扩散到 Controller、Task、Memory、Authorization；
6. 不得因为设计文档只描述高层语义，就用假的 SnowLuma client、固定测试数据或 TODO 代替真实接入。

## 文档与现实冲突时

如果实现过程中发现：

```text
当前 Pi / SnowLuma 实际接口
≠
设计文档假设的低层调用方式
```

则：

- 不得擅自改变核心架构边界；
- 在 adapter / integration layer 内做兼容；
- 如果确实影响高层不变量，记录到 `IMPLEMENTATION_LOG.md`；
- 选择最小、可逆、能真实工作的实现；
- 不因为接口细节不完全确定而停止整个实现。

核心原则：

> **架构文档定义边界和语义；实现 Agent 负责根据 Pi 与 SnowLuma 的当前真实文档/API，把这些边界落成可运行代码。**


# 33. 详细设计状态

当前 MVP 所需的主要架构设计已经收口。

已完成：

```text
Memory
→ MEMORY_SYSTEM_DESIGN.md

Container / Router / Controller / Control Stream
→ AGENT_HOME_CONTAINER_CONTROL_DESIGN.md

Main / Conversation / Worker / Pi orchestration
→ MAIN_WORKER_ORCHESTRATION_DESIGN.md

Gateway Plugin / Direct Command / MCP
→ EXTERNAL_PLUGIN_COMMAND_DESIGN.md

Task Runtime
→ TASK_RUNTIME_DESIGN.md

Authorization / Capability
→ AUTHORIZATION_CAPABILITY_DESIGN.md

Artifact / File
→ ARTIFACT_FILE_DESIGN.md
```

Pi 的具体 integration API 与 SnowLuma 的低层 API 不再单独设计；Chat Platform 的公共抽象已在本文定义。

实现 Agent 必须：

```text
阅读当前 Pi / SnowLuma 实际官方文档、README、公开 API 或源码接口
↓
在本项目既定 Adapter / Integration boundary 内
↓
完成真实可运行实现
```

不得因为设计文档没有冻结第三方 API 函数签名而留下 stub、mock-only integration 或 TODO。

从此处开始，默认优先进入实现与真实垂直集成。

只有在实现暴露出新的真实故障模式、无法由现有边界表达的需求，或现有不变量产生冲突时，才新增架构设计文档。


# 34. 不建议现在单独设计的部分

暂时不值得写详细文档：

- per-task Guest VM/cgroup backend；
- Git worktree；
- Graph Memory；
- multi-harness；
- 独立 `PI_HARNESS_ADAPTER_DESIGN.md`（当前按实际 Pi 文档实现即可）；
- multi-IM；
- distributed workers；
- Web dashboard。

其中 per-task VM/cgroup 尚未成为 MVP blocking；Principal-scoped ExecutionBackend 属于当前安全边界，必须沿用现有 Principal/Task/Runtime 架构维护。

---

# 35. 设计判断标准

新增任何组件之前先回答：

> 如果移除它，会出现什么具体故障？

例如：

```text
Main / Worker split
```

移除 → 长任务阻塞对话。

```text
Task
```

移除 → Pi Session crash 后用户任务语义丢失。

```text
MessageBinding
```

移除 → QQ reply 无法可靠映射 PendingQuestion。

```text
Memory Service boundary
```

移除 → 换 Harness / DB 时长期记忆被绑定。

```text
Host Controller
```

移除 → 需要向 Agent Home 暴露 inbound 网络或把 SnowLuma transport 塞入容器，破坏当前部署边界。

```text
Artifact Service
```

移除 → Worker 可把任意 filesystem path 直接发出。

组件必须解决实际问题，而不是让架构看起来更完整。

---

# 36. 最终核心不变量

1. **Agent 有长期存在的 Linux Home。**
2. **Agent Home 当前运行于 Rootless Podman。**
3. **Agent Home 与 Host filesystem 默认不共享。**
4. **所有核心实例持久状态归属于 `/state` 契约。**
5. **入站 QQ：SnowLuma → Router → Controller → persistent Control Stream → Runtime。**
6. **Direct Command：SnowLuma → Router → Gateway Plugin → SnowLuma，不进入 Main。**
7. **出站 QQ：Agent Home → network → SnowLuma，不回绕 Controller。**
8. **Router 决定消息去哪；Controller 只负责可靠送入 Agent Home。**
9. **Host Controller 不直接控制 Pi、Task 或 Memory。**
8. **Main 不被 Worker 长任务阻塞。**
9. **Task != Pi Session。**
10. **LLM 不做授权判断。**
11. **身份与 capability 必须沿 Task 传播。**
12. **Worker 不直接拥有任意 QQ / filesystem exfiltration 能力。**
13. **PendingQuestion 和 MessageBinding 必须 durable。**
14. **Memory 与 Harness、QQ、容器实现解耦。**
15. **Memory 不能冒充 Machine Truth。**
16. **Guest 与 Owner execution identity 隔离。**
17. **真实 integration 才算 MVP；mock/interface 不算。**
18. **可重新生成的状态不属于迁移契约。**
19. **复杂度必须由具体故障模式证明。**
