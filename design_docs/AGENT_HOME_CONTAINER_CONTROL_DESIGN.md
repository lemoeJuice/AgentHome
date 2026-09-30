# Agent Home 容器、Controller 与 SnowLuma 通信设计

> 状态：架构基线  
> 目的：定义 Agent Home 的容器边界、宿主控制器职责、`exec` 控制通道、SnowLuma 数据流、持久化与迁移约束。  
> 本文只约束部署和跨边界通信，不定义 Memory 内部实现；Memory 见独立的 `MEMORY_SYSTEM_DESIGN.md`。

---

# 1. 核心目标

Agent Home 应表现为一个尽量自包含、与宿主机环境隔离的长期 Agent 实例。

宿主侧分为 Router 与 Controller 两个逻辑模块：

- Router 接收 SnowLuma 的入站事件并决定消息处理路径；
- Direct Command 在 Router 侧直接进入外部插件路径；
- 只有需要 Agent Runtime 处理的事件才交给 Controller；
- Controller 负责启动/管理 Agent Home，并将 Router 产生的可信 Agent ingress event 通过容器运行时控制通道可靠注入 Runtime；
- Controller 还负责初始化、诊断、备份、恢复等 Agent Home 运维操作。

Agent Home 内部负责：

- Runtime；
- Main Agent；
- Pi Harness；
- Worker；
- Task Runtime；
- Memory；
- SQLite；
- Projects；
- Artifacts；
- 直接通过网络调用 SnowLuma 的查询和发送接口；
- 直接访问互联网和其他允许的外部服务。

核心原则：

> 宿主机不是 Agent 的工作环境。  
> Agent Home 不依赖宿主机文件系统。  
> 需要进入 Agent 的业务入站走 `Router → Controller → exec` 控制通道。  
> Agent → SnowLuma 的业务出站走网络。  
> 持久状态与容器镜像分离。  
> 可重新生成的运行时状态不进入迁移契约。

---

# 2. 总体架构

```text
                         QQ
                         │
                         ▼
                    SnowLuma
                         │
                         ▼
                    Host Router
                   /           \
          Direct Command       Agent Path
                │                 │
                ▼                 ▼
        Gateway Plugin Handler       Controller
                │                 │
                │                 │ podman exec -i
                │                 │ control injection
                │                 ▼
                │       ┌──────────────────────────────┐
                │       │      Agent Home Container    │
                │       │                              │
                │       │ Exec Control Client          │
                │       │        │                     │
                │       │        │ local IPC only      │
                │       │        ▼                     │
                │       │ Runtime / Control Plane      │
                │       │   ├── Main Agent             │
                │       │   ├── Task Runtime           │
                │       │   ├── Pi Harness             │
                │       │   ├── Workers                │
                │       │   ├── Memory                 │
                │       │   └── SnowLuma Client ───────┼───┐
                │       │                              │   │ network
                │       └──────────────────────────────┘   │
                │                                           │
                └──────────────→ SnowLuma ←──────────────────┘
```

系统采用**非对称通信**：

需要 Agent 处理的入站：

```text
SnowLuma
→ Router
→ Controller
→ persistent exec control stream
→ Runtime
```

Direct Command：

```text
SnowLuma
→ Router
→ Gateway Plugin Handler
→ SnowLuma
```

Agent 普通出站：

```text
Runtime / Main
→ network
→ SnowLuma
```

因此：

- Router 决定“这条入站消息去哪”；
- Controller 只负责“如何可靠送进 Agent Home”；
- SnowLuma 只负责 QQ / OneBot 协议；
- Controller 不解析 `/score`、`/bind` 等 Direct Command；
- Router 不处理 Pi、Task、Memory 或 Agent Home 生命周期细节。

MVP 中 Router 与 Controller 可以位于同一个 `bot-gateway` 进程，但逻辑模块必须分离。

---

# 3. 为什么采用非对称通信

## 3.1 入站事件经过 Router 与 Controller

SnowLuma 的 OneBot 入站事件首先进入 Router。

Router 负责：

- 识别 Control Command / Direct Command / Natural Language；
- 保留平台提供的可信 `user_id`、`group_id`、`message_id`、reply 等 metadata；
- 将 Direct Command 留在 Agent Home 外部处理；
- 将需要 Agent 处理的消息规范化为 `AgentIngressEvent`。

只有 `AgentIngressEvent` 会交给 Controller。

Controller 负责：

- 确保对应 Agent Home 可用；
- 通过长期 `podman exec -i ... control stream` 可靠投递事件；
- 处理 ACK / reconnect / retry；
- 管理 Agent Home 生命周期。

这样 Runtime 不需要暴露 Host 可访问的 HTTP/TCP listener，同时 Controller 也不需要理解 QQ command grammar。
---

## 3.2 出站直接访问 SnowLuma

Main / Runtime 需要：

- 发送 QQ 消息；
- 查询完整消息；
- 获取 reply 原消息；
- 查询历史；
- 获取文件/图片信息；
- 执行允许的 OneBot action。

这些操作直接通过 SnowLuma 的网络接口完成。

路径：

```text
Main
↓
SnowLuma Capability
↓
SnowLuma network API / MCP / OneBot action API
↓
QQ
```

不回绕 Host Controller。

这样 Host Controller 不需要复制 SnowLuma action API，也不会逐渐演变成第二套 QQ SDK。

---

# 4. 容器运行时选择

当前基线：

> **Rootless Podman**

原因：

- 可以由普通宿主用户运行；
- 不要求 root daemon；
- rootless 模式使用 user namespace；
- 适合单个或少量长期容器；
- 支持 named volume；
- 支持 `podman exec -i` 控制注入；
- 支持独立网络 namespace；
- 可不发布任何 Agent Home 入站端口；
- volume 可以独立 export/import；
- Host 不需要知道 volume 的实际物理路径。

不采用当前阶段的主要替代方案：

### Docker Rootless

能够实现类似功能，但存在用户态 Docker daemon；当前没有明显收益。

### Incus

更像完整 Linux 系统，但管理 daemon 的特权模型与“普通宿主用户运行”目标不如 Rootless Podman 匹配。

### VM / MicroVM

隔离更强，但 Owner Agent Home 当前不是 hostile workload sandbox，资源和运维成本不值得。

### Guest Sandbox

Owner 与 Guest 均在 Agent Home 容器内，复用 Trusted Pi Model Plane 和同一 Principal ExecutionBackend。容器边界保护 Host；Principal UID/GID、workspace permission 与 capability 在容器内区分 Owner/Guest。当前不使用 nested container、VM 或 LLM reverse proxy。

---

# 5. 宿主机边界

Agent Home 不应依赖宿主机实际环境。

正常运行时禁止依赖：

- Host `/home/...`；
- Host 项目目录；
- Host `.ssh`；
- Host 浏览器 profile；
- Host Git config；
- Host D-Bus；
- Host Unix socket；
- Host Docker/Podman socket；
- Host network namespace；
- Host 任意 bind mount。

Host 对 Agent Home 的正常理解只需要：

```text
container instance
state volume
image/runtime version
exec control interface
```

Host 不需要知道：

```text
Agent 的项目目录结构
Memory 数据库内部结构
Pi session 文件位置
Git repository 内容
用户态工具安装位置
```

---

# 6. Agent Home 容器边界

一个 Agent Home 对应一个长期存在的逻辑 Agent 实例。

MVP 不拆分：

```text
runtime container
main container
worker container
memory container
database container
```

而采用：

```text
一个 Agent Home Container
├── Runtime
├── Main
├── Pi
├── Worker Sessions
├── Memory
├── SQLite
└── Projects
```

原因：

- 当前不需要进程级网络隔离；
- Main/Worker 的权限区别由 Runtime capability boundary 控制；
- 多容器会增加状态、网络、生命周期、debug 与恢复复杂度；
- Guest hostile execution 将来另建 Sandbox，不复用此容器。

---

# 7. Host Router 与 Controller

Host-side 逻辑分为两个模块。

## 7.1 Router

Router 负责：

- 接收 SnowLuma / OneBot 入站事件；
- 解析消息类型与 Command；
- Direct Command routing；
- Direct Command 的短期持久状态；
- 生成需要进入 Agent Home 的 `AgentIngressEvent`；
- 调用 Controller 进行可靠投递。

Router 不负责：

- Agent Home 生命周期；
- Podman exec transport；
- Main / Task / Worker；
- Pi Session；
- Memory。

Direct Command、外部插件和 Router persistence 的详细设计见：

`EXTERNAL_PLUGIN_COMMAND_DESIGN.md`

## 7.2 Controller

Controller 必须保持薄。

它负责：

1. Agent Home 实例生命周期；
2. 长期 `exec` control channel；
3. ACK / reconnect / retry；
4. bootstrap / admin / backup / restore orchestration；
5. 基础 health；
6. 多 Agent Home 时的实例映射。

Controller 不负责：

- SnowLuma command parsing；
- Direct Command routing；
- Plugin business logic；
- Main prompt；
- Task scheduling；
- Pi Session；
- Memory；
- Worker；
- SnowLuma outbound business action。

MVP 中 Router 与 Controller 可以位于同一个 `bot-gateway` 进程，但代码依赖方向仍应保持：

```text
SnowLuma Adapter
↓
Router
↓
Controller
↓
Agent Home
```
---

# 8. Inbound Event 数据流

需要进入 Agent 的事件：

```text
QQ
↓
SnowLuma
↓ OneBot event over network
Host Router
↓ route / normalize
Host Controller
↓ trusted Agent ingress envelope
podman exec control client
↓
Runtime
↓
Wake Policy / Runtime Command Routing / Main
```

Router 负责：

- 识别 Direct Command；
- 将 Direct Command 留在 Agent Home 外部处理；
- 将 Natural Language 和需要 Runtime 执行的 Control Command 规范化后交给 Controller；
- 保留可信平台 metadata。

Controller 不理解任何聊天平台的 command grammar，也不把自然语言解释成权限。

它只负责可靠传输 Router 已决定送入 Agent Home 的事件。

建议入站 envelope：

```ts
interface ControllerEventEnvelope {
  protocolVersion: 1;

  eventId: string;
  instanceId: string;

  type:
    | "chat.message"
    | "chat.notice"
    | "control.command"
    | "control.health";

  occurredAt: string;

  source: {
    platform: string;
    accountId: string;
    adapter: string;
  };

  trustedIdentity?: {
    userId: string;
    principalId?: string;
  };

  conversation?: {
    conversationId: string;
    platformConversationId: string;
    threadId: string | null | NotImplemented;
  };

  message?: {
    messageId: string;
    replyTo:
      | PlatformMessageRef
      | null
      | NotImplemented;
  };

  payload: unknown;
}
```

`payload` 可以保留最小事件引用，不要求 Controller 复制完整 OneBot object model。

---

# 9. Runtime 内部控制端点

重要约束：

> `podman exec` 会创建一个新的容器内进程，而不是直接获得正在运行 Runtime 的 stdin。

因此采用：

```text
podman exec
↓
Exec Control Client
↓
container-local IPC
↓
Runtime
```

推荐 Runtime 提供：

```text
/run/agent-home/control.sock
```

Unix domain socket。

该 socket：

- 只存在于容器内部；
- 不通过 volume 持久化；
- 不 bind mount 到 Host；
- 不通过网络暴露；
- Runtime restart 后重新创建；
- 文件权限只允许 Agent Home 内受信任用户访问。

示意：

```text
Host
 │
 │ podman exec -i
 ▼
agent-home control inject
 │
 │ connect()
 ▼
/run/agent-home/control.sock
 │
 ▼
Runtime
```

---

# 10. Exec Control Client

容器 image 提供稳定命令：

```text
agent-home control ...
```

正常运行时只保留一个长期控制桥：

```bash
podman exec -i agent-home \
  agent-home control stream
```

Controller 在自身生命周期内保持该 exec session，并持续复用同一 stdin/stdout。

不为每个 QQ event 创建新的 `podman exec` 进程。

控制协议采用 framing 明确的双向流，MVP 推荐：

```text
JSON Lines
```

约束：

```text
stdin  = Controller → Agent control protocol
stdout = Agent → Controller ACK / protocol messages
stderr = bridge logs
```

每行一个完整 message，例如：

```json
{"protocolVersion":1,"eventId":"evt_1","type":"qq.message","payload":{}}
{"protocolVersion":1,"eventId":"evt_2","type":"control.command","payload":{}}
```

Control Bridge 将事件通过容器内部 local IPC 转发给常驻 Runtime。

`control stream` 是正常业务入站的唯一 exec 数据通道；不提供 one-shot event injection fallback，以避免形成两套投递语义和两套可靠性路径。

Admin/maintenance 命令仍可使用独立 one-shot exec，但它们不承载普通 QQ/业务事件。

---

# 11. Control Protocol 与 Podman 解耦

Runtime 不允许 import Podman API。

容器内部只定义：

```ts
interface ControlIngress {
  receive(event: ControllerEventEnvelope): Promise<ControlAck>;
}
```

Host Controller 侧才实现：

```text
PodmanExecTransport
```

未来可以替换为：

```text
SSH transport
vsock transport
container runtime exec
local RPC
remote Agent Home gateway
```

而 Runtime/Main/Task/Memory 不改变。

---

# 12. 控制协议 Ack

每个事件必须具有稳定 `eventId`。

Runtime 返回：

```ts
interface ControlAck {
  eventId: string;

  status:
    | "accepted"
    | "duplicate"
    | "rejected"
    | "failed";

  receivedAt: string;

  errorCode?: string;
}
```

Host Controller 在收到 `accepted` 或 `duplicate` 前，不应认为注入成功。

---

# 13. 去重

Controller → Runtime 需要至少 once delivery 容忍。

原因：

```text
Controller 写入
↓
Runtime 已处理
↓
exec bridge 在 Ack 返回前断线
```

Controller 可能重发。

因此 Runtime 必须维护有限的：

```text
processed controller event IDs
```

对于 QQ message，可结合 SnowLuma `message_id` 进一步防重复。

原则：

> retry 不应该导致同一 QQ 消息触发两个 Task。


---

# 14. Durable Ingress Queue

`control stream` 只是长期 transport，不是 durable queue。

Runtime 收到 Controller event 后，必须先把事件持久化到自己的 ingress queue，再向 Controller 返回成功 ACK。

推荐流程：

```text
Controller
↓ persistent exec stream
Control Bridge
↓ local IPC
Runtime Ingress Service
↓
SQLite transaction:
  insert ingress_event
  mark eventId accepted
↓ COMMIT
ACK accepted
↓
Wake Policy / Command Router / Main
```

因此：

> `accepted` 表示事件已经由 Runtime 持久接收，而不是 Main 已经处理完成。

这使以下故障不会丢失已 ACK 的消息：

- Control Bridge 退出；
- Controller 重启；
- Runtime 在 ACK 之后崩溃；
- Main/Pi 暂时不可用。

建议持久结构至少包含：

```ts
interface IngressEvent {
  eventId: string;
  type: string;
  envelope: unknown;
  status: "PENDING" | "PROCESSING" | "DONE" | "FAILED";
  receivedAt: string;
  updatedAt: string;
  attempts: number;
}
```

Runtime restart 后继续处理 `PENDING`，并检查残留 `PROCESSING` 项。

Controller 到 Runtime 的传输语义为：

```text
at-least-once delivery
+
eventId deduplication
+
durable enqueue before ACK
```

从业务效果上避免重复处理。

---

# 15. Backpressure

Controller 不应无限向 exec stdin 写入未确认事件。

维护有界 in-flight window，例如：

```text
maxInFlight = configurable
```

MVP 可以取较小默认值，例如 16 或 32。

当达到上限：

- Controller 停止从本地待发送队列继续写入；
- 等待 ACK；
- Router ingress 层使用有界缓冲或持久 spool；
- 不通过无限增长的内存队列吸收压力。

具体数值属于配置，不属于协议语义。

---

# 16. Controller 断线

Control bridge 断线：

```text
≠ Runtime 停止
≠ Main 停止
≠ Worker 停止
```

Controller 在 bridge 断开后重新建立同一种长期 `control stream` 会话；正常业务事件仍只通过该持久流投递。

握手建议：

```json
{
  "type": "hello",
  "protocolVersion": 1,
  "instanceId": "agent-home-default",
  "controllerSessionId": "..."
}
```

Runtime 返回：

```json
{
  "type": "hello_ack",
  "protocolVersion": 1,
  "runtimeVersion": "...",
  "runtimeInstanceId": "...",
  "status": "ready"
}
```

---

# 17. SnowLuma Outbound

Agent Home 内部拥有独立 SnowLuma Client。

建议抽象：

```ts
interface QQCapability {
  getMessage(id: string): Promise<QQMessage>;
  getHistory(query: HistoryQuery): Promise<QQMessage[]>;
  sendMessage(target: QQTarget, message: OutgoingMessage): Promise<SendResult>;
  sendArtifact(target: QQTarget, artifact: PublishedArtifact): Promise<SendResult>;
}
```

具体实现：

```text
SnowLumaQQCapability
```

Main 不直接拼 SnowLuma HTTP/WebSocket 协议。

---

# 18. SnowLuma Lazy Context

Router 生成的 Agent ingress event 不需要包含完整群历史。

Main 获取上下文：

```text
Inbound message reference
↓
Main 判断需要更多上下文
↓
QQCapability
↓ network
SnowLuma
↓
完整 message / reply / history / attachment metadata
```

这保持：

- Controller 简单；
- prompt 小；
- QQ 细节不复制进 Runtime transport；
- SnowLuma 仍然是 OneBot protocol source of truth。

---

# 19. SnowLuma Credential

SnowLuma outbound credential 属于 Agent Home state。

保存于：

```text
/state/secrets/
```

或等价受控配置。

禁止：

- 通过命令行 argv 传 token；
- 写进 image；
- 写进源码；
- 放在 Host bind mount；
- 输出到普通日志。

首次配置通过 bootstrap stdin 注入。

---

# 20. Bootstrap

Agent Home 初次创建后，需要初始化：

- instance identity；
- SnowLuma endpoint；
- SnowLuma credential；
- Owner QQ ID；
- Pi/Harness auth/config；
- Memory schema；
- DB schema；
- Agent runtime config。

通过：

```bash
podman exec -i agent-home \
  agent-home bootstrap --stdin
```

输入结构化配置。

例如：

```json
{
  "format": "agent-home-bootstrap",
  "version": 1,
  "instanceId": "default",
  "owner": {
    "platform": "qq",
    "userId": "..."
  },
  "snowluma": {
    "endpoint": "...",
    "credential": "..."
  }
}
```

bootstrap：

1. 校验格式；
2. 创建必要 `/state` 目录；
3. 安全写入 secrets；
4. 初始化 DB；
5. 执行 migration；
6. 标记 initialized；
7. 不在 stdout 回显 secrets。

---

# 21. 为什么配置使用 stdin

避免：

```bash
podman exec agent-home \
  agent-home bootstrap --token SECRET
```

敏感值出现在：

- shell history；
- process argv；
- debug output；
- 运维日志。

因此规则：

> Secret-bearing admin command 必须优先从 stdin 或受控 file descriptor 读取。

正常自动化不使用 pseudo-TTY。

---

# 22. 文件输入

大文件不放进 JSON control envelope。

Router 收到含 Chat Platform file 的入站事件后，根据实现可采用：

```text
SnowLuma file URL / remote reference
```

优先让 Agent Home 自己通过网络下载。

即：

```text
Chat Platform file
↓
SnowLuma metadata / URL
↓
Controller injects reference
↓
Agent Home
↓ network
download
↓
/state/inbox or project
```

只有 SnowLuma 无法提供可用网络引用时，才使用：

```bash
podman exec -i agent-home \
  agent-home ingest-file --metadata ... < file
```

做 stream upload。

禁止为了传文件引入 Host bind mount。

---

# 23. Artifact 输出

Worker 产生文件：

```text
/state/artifacts/...
```

经过 Artifact Service 校验。

然后：

```text
Worker
↓
publishArtifact
↓
Artifact Service
↓
Main
↓
QQCapability
↓ network
SnowLuma
↓
QQ
```

Router / Controller 都不需要访问 Agent Home artifact 文件。

如果 SnowLuma 的 file action 需要上传 bytes，则 Agent Home 自己通过网络上传。

---

# 24. 网络模型

Agent Home 需要网络用于：

- SnowLuma outbound；
- Pi / model provider；
- Git；
- npm/pip/cargo；
- Web；
- Worker external APIs。

采用 Rootless Podman 独立网络 namespace。

禁止：

```text
--network host
```

除非未来有明确不可替代需求并重新审查安全边界。

默认：

```text
published ports = 0
```

Agent Home 不需要 Host 访问 TCP listener。

Controller 通过 `exec` 进入。

这里的 `published ports = 0` 只约束 **Agent Home 容器**。SnowLuma 是同一 Podman 网络中的独立容器，当前部署会将它的服务端口发布到宿主机：

```text
Host 127.0.0.1:3000 → SnowLuma:3000   OneBot HTTP
Host 127.0.0.1:3001 → SnowLuma:3001   OneBot WebSocket
Host 0.0.0.0:6081   → SnowLuma:6081   noVNC
Host 0.0.0.0:5100   → SnowLuma:5099   SnowLuma WebUI
```

OneBot 宿主端口默认只绑定 loopback；noVNC/WebUI 默认绑定所有宿主接口，可由部署配置调整。Rootless Podman 可能通过宿主机上的 `rootlessport` 进程接受连接并转发到 SnowLuma 容器。该进程只是端口转发层，宿主端口能 accept TCP 并不代表容器内 OneBot 服务正在监听，更不代表 QQ 已登录。部署检查应探测 SnowLuma 容器内的 OneBot 端口（当前 WebSocket 端口为 `3001`），不能仅检查宿主机的转发端口。

两个调用方使用的是**同一个 SnowLuma OneBot 服务在各自网络命名空间中的地址**，不是两套 API：

```text
Host Gateway → http://127.0.0.1:3000 / ws://127.0.0.1:3001
Agent Home   → http://snowluma:3000   / ws://snowluma:3001
```

因此当前仍需发布宿主机的 `3000/3001`：Host Gateway 是宿主机进程，依赖它们调用 OneBot HTTP action 并接收 OneBot WebSocket 事件。关闭这两个发布端口会切断 QQ 入站和 Host 侧 QQ action；`6081/5100` 则是独立的 noVNC/WebUI 管理入口。修改为完全不发布 OneBot 端口，需要先迁移 Host Gateway 到可直接加入 `agent-home-net` 的通信拓扑。

---

# 25. 网络方向

理想默认：

```text
Agent Home → Internet      allowed
Agent Home → SnowLuma      allowed

Host → Agent TCP           none
LAN → Agent TCP            none
Internet → Agent TCP       none
```

注意：

> “无 published port”不等于“容器完全无网络”。

Agent Home 仍需出站网络。

---

# 26. Rootless 安全模型

Podman 必须以普通宿主用户运行。

部署时可以要求一次 Host bootstrap，例如：

- 安装 Podman；
- `subuid/subgid`；
- rootless networking/storage prerequisites。

日常：

```text
start
stop
exec
backup
restore
upgrade
```

不应需要 root。

禁止正常配置：

```text
--privileged
host PID namespace
host network namespace
Host home mount
runtime socket mount
```

---

# 27. 持久状态模型

Agent 的 identity 不等于容器 writable layer。

定义：

```text
Agent Instance
=
Runtime/Image Version
+
Canonical Persistent State
```

其中：

```text
/state
```

是唯一核心持久状态根。

---

# 28. `/state` 布局

建议：

```text
/state/
├── home/
│   ├── .config/
│   ├── .local/
│   └── ...
│
├── projects/
│
├── data/
│   ├── agent.db
│   ├── memory/
│   └── ...
│
├── artifacts/
│
├── inbox/
│
├── config/
│
└── secrets/
```

实际子目录可以演化，但 `/state` 语义稳定。

---

# 29. 非持久目录

```text
/app
/cache
/scratch
/tmp
/run
```

语义：

## `/app`

Runtime 软件，来自 image。

## `/cache`

可重新下载或计算。

## `/scratch`

临时 Worker 数据。

## `/tmp`

系统临时文件。

## `/run`

Runtime socket / PID / lock 等当前启动状态。

这些都不属于迁移契约。

---

# 30. XDG 建议

可配置：

```text
HOME=/state/principals/uid-<runtime-uid>/home
XDG_CONFIG_HOME=/state/principals/uid-<runtime-uid>/home/.config
XDG_DATA_HOME=/state/principals/uid-<runtime-uid>/home/.local/share
XDG_STATE_HOME=/state/principals/uid-<runtime-uid>/home/.local/state
XDG_CACHE_HOME=/cache
TMPDIR=/scratch/tmp
```

这样：

```text
config/data/state → persistent
cache/temp        → disposable
```

---

# 31. Persistent Volume

Podman 管理一个 named volume：

```text
agent-home-state
```

挂载：

```text
agent-home-state:/state
```

不使用普通 Host bind mount 作为主状态方案。

Host 不需要知道 named volume 的物理 mountpoint。

---

# 32. 可迁移状态

需要迁移：

```text
/state
```

包含：

- Memory canonical data；
- Task DB；
- config；
- Pi auth/config；
- projects；
- Git repositories；
- artifacts（按 retention policy）；
- explicit Agent/user state；
- required secrets。

---

# 33. 不需要迁移

以下均视为 derived / disposable：

- image；
- container ID；
- Podman graphroot；
- overlay layers；
- writable layer；
- build cache；
- `/cache`；
- `/scratch`；
- `/tmp`；
- `/run`；
- process state；
- network namespace；
- transient logs；
- active exec session。

---

# 34. Volume 迁移

逻辑流程：

```text
quiesce state writers
↓
SQLite checkpoint / flush
↓
stop or enter backup mode
↓
export named volume
↓
archive
```

恢复：

```text
create fresh named volume
↓
import archive
↓
attach new runtime image
↓
schema migration
↓
start runtime
```

应用级 CLI 应封装底层 Podman 命令。

例如：

```text
agent-home backup ...
agent-home restore ...
```

用户不应被要求理解 Podman volume 内部路径。

---

# 35. Backup Manifest

备份建议包含 manifest：

```json
{
  "format": "agent-home-state",
  "formatVersion": 1,
  "createdAt": "...",
  "runtimeVersion": "...",
  "databaseSchemaVersion": 1,
  "memorySchemaVersion": 1
}
```

状态 archive 可与 manifest 打包为：

```text
agent-home-backup.tar.zst
```

---

# 36. Secrets 与备份

当前设计将恢复 Agent identity 所需 secret 视为持久 state。

优点：

```text
恢复 state
→ Agent 基本可直接继续工作
```

代价：

```text
backup 高度敏感
```

因此以后应支持 encrypted backup。

但不要为了 secret 分离而破坏当前统一 state contract。

---

# 37. Runtime 进程模型

容器启动：

```text
container init
↓
Agent Runtime
```

Runtime 长期运行。

它管理：

- Main；
- Task Runtime；
- Pi sessions；
- Worker sessions；
- Memory background jobs；
- local control socket；
- SnowLuma outbound client；
- recovery。

`podman exec` 创建的 control process 只是 client，不拥有 Agent state machine。

---

# 38. Runtime Restart

Runtime restart 后：

1. 重新打开 `/state`；
2. migrate schema；
3. 恢复 Task durable state；
4. 创建新的 `/run/agent-home/control.sock`；
5. 恢复 Main；
6. 检查 stale Worker / Pi session；
7. Controller 重连 exec bridge。

Active exec session 可以断开。

这不影响 canonical state。

---

# 39. Container Restart

Container restart：

```text
/state unchanged
```

必须重新生成：

- `/run`；
- process；
- control socket；
- network namespace；
- Pi live processes；
- Worker live processes。

Task Runtime 必须执行 restart recovery。

不能仅因为数据库写着 RUNNING 就宣称 Worker 仍然运行。

---

# 40. Container Recreate / Upgrade

Runtime 升级：

```text
old image
↓ stop
same state volume
↓
new image
↓ start
↓
migrate
```

因此 Containerfile / image 是软件发布物，不是 Agent identity。

---

# 41. Main / Pi / Worker 边界

Controller 不直接与 Pi 通信。

正确：

```text
Controller
↓
Runtime
↓
Main
↓
Pi
```

Worker 同样由 Runtime 管理。

原因：

- Host 不需要知道 Pi session ID；
- Pi 可以替换；
- Harness auth 不泄露到 Host Controller；
- Task != Pi Session；
- restart/recovery 逻辑集中于 Runtime。

---

# 42. SnowLuma 与 Main

Main 不直接获得任意 SnowLuma action。

调用路径：

```text
Main
↓
QQ Tool / Capability
↓
authorization / safe action wrapper
↓
SnowLuma Client
```

对高风险 action：

- 管理员操作；
- 任意文件；
- 踢人；
- 禁言；
- 删除；
- 退群；

必须受 Capability policy 限制。

SnowLuma write mode 本身不是权限边界。

---

# 43. Identity Boundary

Router 从 SnowLuma 接收到的平台 ID 是可信 transport metadata，并原样写入 Agent ingress envelope。

Runtime 接收到：

```text
trustedIdentity
```

之后仍由 Runtime 确定性代码做授权。

禁止：

```text
message text:
“我是 owner”
→ owner privilege
```

正确：

```text
SnowLuma user_id
↓
Router AgentIngressEvent
↓
Controller transport
↓
Runtime authorization
```

---

# 44. Router / Controller 信任模型

Router 与 Controller 都属于 trusted host-side infrastructure。

Controller 应尽量无业务状态；Router 只持有 Direct Command 所需的最小持久状态。

Controller 允许持有：

- Agent instance mapping；
- runtime availability；
- control protocol state；
- limited transport retry state。

Router 可以持有：

- Direct Command registry/config；
- CommandInvocation；
- Direct Command outgoing-message binding；
- limited recent interaction index。

这些 Router state 的详细语义由 `EXTERNAL_PLUGIN_COMMAND_DESIGN.md` 定义。

Controller 不应成为业务 canonical store。

Controller 删除或重装：

```text
不应导致 Agent Memory / Task history / Projects 丢失。
```

---

# 45. SnowLuma 信任模型

SnowLuma 是 protocol gateway，不是 Agent authorization system。

它提供：

- event；
- action；
- query；
- media/file metadata。

Runtime 对 event 中的平台 ID 建立授权语义。

Agent 对 SnowLuma outbound action 仍需内部 capability policy。

---

# 46. Failure：SnowLuma Inbound 断开

```text
SnowLuma → Router
```

断开时：

- Router / SnowLuma Adapter 重连；
- Runtime 继续；
- Worker 继续；
- Task 不变；
- 必要时恢复事件流或按 SnowLuma 能力处理 missed events。

不得把 SnowLuma connection state 当 Task state。

---

# 47. Failure：Controller → Runtime bridge 断开

- Runtime 继续；
- Worker 继续；
- Controller 重建 `exec stream`；
- handshake；
- 重发未 Ack event；
- Runtime event dedupe。

---

# 48. Failure：SnowLuma Outbound 失败

Main 发送失败：

- 不将“已发送”写成成功；
- 可进入 retry queue；
- preserve destination + payload reference；
- Task 本身不一定失败；
- 用户可稍后收到结果。

---

# 49. Failure：Agent Home 不运行

Router 收到需要 Agent 处理的 QQ event 后，Controller：

- 检测 container；
- 根据配置启动 Agent Home；
- 等待 Runtime ready；
- 建立 exec bridge；
- 注入 event。

如果启动失败：

- 不丢弃 event；
- 记录 delivery failure；
- 有界重试；
- 不无限占用内存。

---

# 50. Admin Exec

除 control stream 外，保留 one-shot 管理命令：

```text
agent-home bootstrap
agent-home doctor
agent-home migrate
agent-home version
agent-home backup-prepare
agent-home backup-finish
```

这些命令只允许管理 Agent Home，不绕过 Runtime 权限去执行用户业务。

---

# 51. 不把任意 shell 暴露为 Controller API

虽然 Podman 可以：

```bash
podman exec agent-home bash
```

运维人员技术上可做。

但 Host Controller 的程序接口不应提供：

```text
execAnyCommand(command)
```

正常控制协议只允许固定命令。

否则 Controller 变成一个 Host → Agent arbitrary RCE API。

---

# 52. Dev 与 Production

开发时可以手动：

```bash
podman exec ...
podman logs ...
```

生产模型仍保持：

```text
Controller → fixed control CLI → Runtime
```

不要因为开发方便把 debug 通道变成产品协议。

---

# 53. 日志

Runtime logs 默认输出 stdout/stderr，Podman 可采集。

但长期必要的审计事件如：

- Task history；
- authorization denial；
- Memory change；
- migration；

应该写 canonical data / structured audit store，而不是依赖 container logs。

普通日志可丢。

---

# 54. Health

Host Controller 可以用：

```bash
podman exec agent-home agent-home control ping
```

或 Podman healthcheck。

Health 至少区分：

```text
container_running
runtime_ready
database_ready
main_ready
snowluma_outbound_reachable
pi_available
```

不要只检查 PID 存在。

---

# 55. 启动顺序

建议：

```text
1. Rootless Podman available
2. state volume exists
3. Agent Home container exists / recreate from image
4. container start
5. Runtime opens /state
6. migrations
7. Runtime creates local control socket
8. Runtime reports ready
9. Controller establishes exec stream
10. Router starts/resumes inbound routing to Controller
```

---

# 56. 首次部署顺序

```text
1. install/bootstrap Rootless Podman
2. acquire Agent Home image
3. inspect the configured Agent Home named volume
4. if absent, ask whether to initialize empty state or restore a portable deployment backup
5. for restore, accept the backup directory (or a path to a file in it); require `manifest.json`, `state.tar`, `image.tar`, and every manifest-referenced archive
6. create/restore the Agent Home volume and create/start Agent Home container
7. podman exec -i ... bootstrap --stdin
8. Runtime initializes /state
9. configure SnowLuma inbound for Router / Bot Gateway
10. start Router + Controller
11. Controller establishes exec bridge
12. end-to-end test
```

---

# 57. E2E 入站示例

用户：

```text
@Bot 帮我检查一下项目
```

流程：

```text
QQ
↓
SnowLuma emits event
↓
Controller receives event
↓
Controller creates trusted envelope
↓
podman exec stream
↓
control client
↓
Runtime local socket
↓
wake policy
↓
Main
↓
Task/Worker if needed
```

---

# 58. E2E 出站示例

Main：

```text
“好的，我开始检查。”
```

流程：

```text
Main
↓
QQ Capability
↓
SnowLuma Client
↓ network
SnowLuma
↓
QQ
```

Controller 不参与。

---

# 59. E2E Worker Question

```text
Worker
↓ askParent
PendingQuestion persisted
↓
Main
↓
SnowLuma direct send
↓
QQ
```

用户 reply：

```text
QQ
↓
SnowLuma inbound
↓
Controller
↓ exec
Runtime
↓ MessageBinding
↓
PendingQuestion resolve
↓
Pi steer/resume
```

---

# 60. E2E 文件

入站：

```text
Chat Platform file
↓
SnowLuma
↓
Controller sends metadata/reference
↓ exec
Agent Runtime
↓
SnowLuma/network fetch
↓
/state/inbox
```

出站：

```text
Worker file
↓
Artifact Service
↓
/state/artifacts
↓
SnowLuma direct upload/send
↓
QQ
```

Host filesystem 不参与。

---

# 61. E2E 备份

```text
Host Controller / admin CLI
↓
exec backup-prepare
↓
Runtime checkpoint + quiesce
↓
Podman volume export
↓
archive + manifest
↓
exec backup-finish
```

备份不复制 container writable layer。

---

# 62. 迁移

在新 Host：

```text
install rootless runtime
↓
restore state volume
↓
pull/build compatible image
↓
create Agent Home
↓
attach /state
↓
start
↓
migrate
↓
bootstrap host-side Controller
↓
connect SnowLuma
```

Agent 的核心状态不依赖旧 Host 路径、UID、home directory 或 container ID。

---

# 63. Portability Contract

真正的跨运行时契约是：

```text
1. Agent Home image/build definition
2. /state logical contents
3. control protocol
4. SnowLuma network API contract
```

不是：

```text
Podman internal storage
Podman volume physical path
container ID
Host filesystem layout
```

因此未来可迁移到：

```text
Docker Rootless
Incus
VM
Remote Linux
```

只需提供对应：

```text
Container/Instance Driver
Control Transport
State Restore
```

Runtime 业务逻辑不应重写。

---

# 64. MVP 必须真实验证

至少：

1. Rootless Podman 下启动 Agent Home；
2. 无 Host bind mount；
3. 无 `--network host`；
4. 无 published Agent Home TCP port；
5. Controller 可通过 `exec` 注入真实事件；
6. Runtime 收到事件且不会重复处理；
7. Main 可直接通过网络调用 SnowLuma 发 QQ 消息；
8. Main 可通过 SnowLuma lazy query 获取上下文；
9. 长期 Controller bridge 断开并重连后 Runtime 不退出，未 ACK 事件会重发且不会造成重复业务处理；
10. 容器 restart 后 `/state` 保留；
11. Runtime restart 后 Task recovery 正确；
12. `/state` volume export/import 后新实例可恢复；
13. Host home / SSH / socket 不可见；
14. bootstrap secret 不通过 argv 泄露；
15. 大文件不要求 Host bind mount；
16. SnowLuma outbound 失败可被检测；
17. Worker question → QQ → Controller → exec → Runtime → Worker resume 完成闭环。

---

# 65. 明确禁止

MVP 默认禁止：

```text
--privileged
--network host
Host / bind mount
Host home bind mount
~/.ssh bind mount
browser profile bind mount
Docker/Podman socket mount
直接把 Runtime TCP port 暴露给 Host
Controller 直接调用 Pi
Controller 直接访问 Memory DB
Controller 直接访问 /state
Controller 执行任意业务 shell
Secret 通过 CLI argv
把 container writable layer 当成唯一持久状态
把 container ID 当 Agent identity
```

---

# 66. 最终设计不变量

1. **当前 QQ 底层由 SnowLuma / OneBot 提供；平台协议差异由 ChatPlatformAdapter 吸收。**
2. **Router 负责入站分流；Direct Command 不进入 Agent Home。**
3. **Controller 只负责 Agent Home 生命周期和可靠控制传输。**
4. **Router → Controller → Runtime 构成 Agent 入站链路。**
5. **Controller → Runtime 通过 `exec` 控制通道。**
3. **`exec` process 通过容器内部 local IPC 与常驻 Runtime 通信。**
4. **Agent outbound 直接通过网络调用 SnowLuma。**
5. **Agent Home 不需要公开入站 TCP port。**
6. **Agent Home 与 Host filesystem 默认完全不共享。**
7. **Agent Home 使用 Rootless Podman。**
8. **`/state` 是唯一核心持久状态根。**
9. **容器镜像、writable layer、cache、process 都是可重新生成状态。**
10. **Host 不需要知道 volume 的物理路径。**
11. **Main/Task/Pi/Worker/Memory 位于 Agent Home 内。**
12. **Controller 不直接依赖 Pi 或 Memory 实现。**
13. **SnowLuma 是 QQ protocol gateway，不是授权边界。**
14. **Runtime 依据可信平台 metadata 做确定性授权。**
15. **Guest 与 Owner 共用 Agent Home/Model Plane；Principal ExecutionContext、UID/GID、capability 与 workspace 不同。**
16. **Control Protocol 与 Podman 解耦，Podman 只是当前 transport/backend。**
17. **恢复 Agent 依赖的是 `/state` 与兼容 runtime，不是原宿主环境。**
18. **正常业务入站只使用一个长期 `podman exec -i ... control stream` 通道，不存在 one-shot event injection fallback。**
19. **`control stream` 只负责传输；可靠性由 durable ingress queue + eventId + ACK 提供。**


---


# SnowLuma 实施约束

本设计定义的是：

```text
SnowLuma → Router → Controller → Runtime
```

的职责边界，不冻结 SnowLuma 的具体连接/API 版本。

实现 Agent 必须参考当前使用版本的 SnowLuma / OneBot 文档、公开 API 或源码接口，完成真实：

- inbound event 接入；
- message/reply/@ segment 解析；
- image/file reference 处理；
- outbound send/action；
- history/context 查询；
- reconnect/error handling。

不得用 fake client、固定测试事件或 TODO 代替真实 SnowLuma 集成。

SnowLuma API 的版本差异应由 SnowLuma Adapter 吸收，不应把协议细节扩散到 Controller、Task Runtime 或 Main。



---

# Chat Platform 抽象边界补充

只有 Chat Platform 是当前正式预留多实现的外部适配层。

```text
Raw Platform API
↓
ChatPlatformAdapter
↓
Router
```

当前：

```text
QQChatPlatformAdapter
↓
SnowLuma / OneBot
```

Controller 不知道：

```text
QQ
Telegram
OneBot
```

它只接收 Router 产生的统一 `AgentIngressEvent`。

Rootless Podman 与 Pi 不建立通用多后端 registry/factory；只保留当前具体 integration module。

平台字段/方法不支持时使用统一 `NOT_IMPLEMENTED` 语义；`null` 仅表示该平台支持该概念但当前值缺失。
