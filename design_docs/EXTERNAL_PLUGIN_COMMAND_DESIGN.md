# Bot Gateway Plugin & Command Design

> 状态：详细设计基线  
> 文件名沿用：`EXTERNAL_PLUGIN_COMMAND_DESIGN.md`  
> “External” 的含义：插件位于 Agent Home 之外；**不表示插件是独立网络服务**。  
> 上位设计：`AGENT_HOME_DESIGN.md`  
> 相关设计：`AGENT_HOME_CONTAINER_CONTROL_DESIGN.md`、`MAIN_WORKER_ORCHESTRATION_DESIGN.md`

---

# 1. 核心结论

插件采用传统 Bot plugin 模型：

> **Bot Gateway 启动时加载插件模块；插件在 import/init 阶段向 Registry 注册 Direct Command 和可选 Agent Action；收到请求时 Gateway 直接调用已注册函数。**

插件不是：

- 独立 MCP Server；
- 独立 HTTP Service；
- 默认常驻子进程；
- 默认独立容器。

MCP 只存在于：

```text
Agent Home
↔
Bot Gateway MCP
```

这条边界。

插件本身只是一组被 Bot Gateway 加载和调用的代码扩展。

---

# 2. 总体结构

```text
                             QQ
                             │
                             ▼
                         SnowLuma
                             │
                             ▼
                    ┌──────────────────┐
                    │   Bot Gateway    │
                    │                  │
                    │ SnowLuma Adapter │
                    │        │         │
                    │      Router      │
                    │     /      \     │
                    │ Direct     Agent │
                    │   │          │   │
                    │   ▼          ▼   │
                    │ Command   Controller ── persistent exec ──▶ Agent Home
                    │ Registry         │
                    │   │              │
                    │   ▼              │
                    │ Plugin Handler   │
                    │                  │
Agent Home ──MCP──▶ │ MCP Gateway      │
                    │   │              │
                    │   ▼              │
                    │ AgentAction      │
                    │ Registry         │
                    │   │              │
                    │   ▼              │
                    │ Plugin Handler   │
                    └──────────────────┘
```

同一个插件模块可以同时注册：

```text
Human-facing Direct Command
+
Agent-facing Action
```

但二者是两个独立入口，不要求一一对应。

---

# 3. SnowLuma / Router / Controller

三个职责继续严格分离。

## SnowLuma

只负责：

```text
QQ / OneBot protocol
```

## Router

负责：

```text
这条入站消息去哪
```

包括：

- Control Command；
- Direct Command；
- Natural Language；
- Direct Command reply context。

## Controller

只负责：

```text
Agent Home lifecycle
+
Router → Runtime reliable control transport
```

Controller 不理解插件命令。

MVP 中 Router 与 Controller 可以位于同一个 `bot-gateway` 进程。

---

# 4. 用户输入分类

```text
User Input
├── Command
│   ├── Control Command
│   └── Direct Command
└── Natural Language
    └── Main Agent
```

不保留 Intent Command。

如果请求仍然需要自然语言推理，直接进入 Main。

---

# 5. Control Command

Control Command 管理 Agent 系统自身。

例如：

```text
/status
/tasks
/stop
/new
/usage
/help
```

Router 识别 Control Command，但真正的系统语义由 Runtime 执行。

流程：

```text
QQ
↓
SnowLuma
↓
Router
↓ CONTROL
Controller
↓
Runtime
↓
Core Service
↓
SnowLuma
```

插件不得覆盖 Core Control Command。

---

# 6. Direct Command

Direct Command 是确定性的 Bot 功能。

例如：

```text
/score
/bind <account>
/rank
/checkin
```

流程：

```text
QQ
↓
SnowLuma
↓
Router
↓
CommandRegistry.resolve()
↓
direct handler()
↓
CommandResult
↓
SnowLuma
↓
QQ
```

Main / Pi 不参与。

---

# 7. Plugin Loader

Bot Gateway 启动时加载启用的插件模块。

概念流程：

```text
Gateway startup
↓
discover enabled plugin modules
↓
import / initialize plugin
↓
plugin registration code executes
↓
CommandRegistry / AgentActionRegistry populated
↓
validate collisions / metadata
↓
Gateway ready
```

插件注册失败：

```text
该插件 disabled / startup error
```

不能悄悄覆盖已有 route。

---

# 8. 注册模型

注册机制可以用：

- decorator；
- module-level registration；
- `register()` 函数；
- framework annotation。

具体语法不是架构约束。

核心要求：

> 注册发生在插件加载阶段，路由阶段只做 Registry lookup + direct function call。

概念示例：

```ts
registerCommand(
  {
    name: "score",
    permission: "user",
  },
  scoreCommand,
);

registerAgentAction(
  {
    name: "maimai.get_score",
    description: "Get the current score for the bound account",
  },
  getScoreAction,
);
```

等价的 Python 风格可以是：

```python
@command("score")
async def score(ctx):
    ...

@agent_action("maimai.get_score")
async def get_score(ctx):
    ...
```

---

# 9. CommandRegistry

CommandRegistry 是 Gateway 内存中的运行时索引。

概念：

```ts
interface CommandDefinition {
  name: string;
  aliases?: string[];
  permission: string;
  pluginId?: string;
  kind: "CORE" | "PLUGIN";
}
```

Registry 保存：

```text
command metadata
+
handler reference
```

例如：

```text
score → maimai.scoreCommand
bind  → maimai.bindCommand
```

执行时不再查外部 provider。

---

# 10. Core Command Namespace

Core Command 与 Plugin Command 分开：

```text
CommandRegistry
├── CORE
│   ├── status
│   ├── tasks
│   ├── stop
│   ├── new
│   ├── usage
│   └── help
│
└── PLUGIN
    ├── score
    ├── bind
    └── ...
```

规则：

- Plugin 不得覆盖 CORE；
- 两个 Plugin 注册同名 command 时启动/加载失败；
- 不使用 last-wins；
- alias 冲突同样视为冲突。

---

# 11. Plugin Context

Plugin handler 不直接依赖完整 platform raw event。

Gateway 应提供稳定 Context。

概念：

```ts
interface CommandContext {
  invocationId: string;

  requester: {
    platform: string;
    accountId: string;
    userId: string;
    principalId?: string;
  };

  conversation: {
    conversationId: string;
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
  };

  args: string[];
  rawArgs: string;

  pluginState: PluginStateHandle;
}
```

如插件需要调用 聊天平台相关能力，应通过 Gateway 提供的受控 helper，而不是自己依赖 SnowLuma 内部连接对象。

---

# 12. CommandResult

插件 handler 返回统一结果，而不是直接自行向任意聊天平台 destination 发送。

建议：

```ts
interface CommandResult {
  text?: string;

  artifacts?: ExternalArtifactRef[];

  context?: {
    type: string;
    summary: string;
    resultRef?: string;
  };
}
```

Router 负责：

```text
CommandResult
↓
render/send
↓
SnowLuma
```

这样：

- destination 仍由 Gateway 控制；
- Router 能保存结果上下文；
- 后续 reply 可以桥接给 Main。

---

# 13. Plugin Code 与 Plugin Data

插件代码和状态分离。

例如：

```text
plugins/
├── maimai/
├── weather/
└── ...

plugin-data/
├── maimai/
├── weather/
└── ...
```

语义：

```text
plugins/
= code / deployable

plugin-data/
= persistent authoritative plugin state
```

例如：

```text
QQ user → arcade account binding
```

属于：

```text
plugin-data/maimai
```

不属于：

- Agent Memory；
- Runtime DB；
- Agent Home `/state`。

---

# 14. PluginState

Gateway 为插件提供自己的 state root / database handle。

插件之间默认不能直接访问彼此状态。

概念：

```text
Plugin maimai
→ plugin-data/maimai

Plugin weather
→ plugin-data/weather
```

具体状态格式由插件决定：

- SQLite；
- JSON；
- KV；
- files。

但 authoritative business state 归插件所有。

---

# 15. Agent Action

插件可以选择向 Agent 注册能力。

例如：

```text
maimai.get_score
maimai.get_recent_scores
maimai.get_report
```

这类能力进入：

```text
AgentActionRegistry
```

而不是直接注册成 Pi Tool。

---

# 16. AgentActionRegistry

概念：

```ts
interface AgentActionDefinition {
  name: string;
  description: string;
  inputSchema: unknown;

  permission: string;
  pluginId: string;
}
```

Registry 同样保存：

```text
metadata
+
handler reference
```

调用时直接调用插件函数。

---

# 17. Direct Command 与 Agent Action 独立

一个功能可以同时有两个入口：

```text
queryScore()
   ▲       ▲
   │       │
/score   maimai.get_score
```

但不要求：

```text
Direct Command == Agent Action
```

例如：

```text
/bind
```

可以只有 Direct Command。

Main 默认不获得：

```text
bind_account
```

这样的高影响能力。

---

# 18. Bot Gateway MCP

Bot Gateway 自己暴露一个 MCP endpoint 给 Agent Home。

插件不需要实现 MCP。

建议 MCP 使用 progressive disclosure，而不是把全部 Action 都直接变成 Pi Tool：

```text
list_actions
search_actions
get_action
invoke_action
```

流程：

```text
Main / Worker
↓
Bot Gateway MCP
↓
AgentActionRegistry
↓
Runtime authorization / exposure check
↓
plugin handler()
```

新增插件后只需 Gateway 重新加载 Registry。

Main Pi Session 的固定 MCP Tool Schema 不需要变化。

---

# 19. 为什么 MCP 不属于插件

如果每个插件自己做 MCP：

```text
plugin
├ HTTP/MCP server
├ lifecycle
├ port
├ discovery
└ health
```

会把简单 Bot plugin 变成服务化组件。

当前没有这种需求。

因此：

> MCP 是 Gateway 对 Agent 的统一适配层，不是插件开发接口。

---

# 20. Agent Tool Exposure

AgentAction 注册成功不代表所有 Main/Worker 都可以调用。

调用链：

```text
Pi
↓ invoke_action
Bot Gateway MCP
↓
authorization / exposure
↓
AgentActionRegistry
↓
handler
```

至少依据：

- caller identity；
- Main / Worker；
- requester trust；
- Task capabilities；
- action permission。

插件元数据不能自行扩大权限。

---

# 21. Direct Command 不进入 Main History

例如：

```text
/score
```

执行完成后，不自动往 Pi Main Session 注入：

```text
“用户执行了 /score”
```

否则 Main context 会被无意义 command event 污染。

Direct Command 只有在后续自然语言需要引用时才桥接给 Main。

---

# 22. Router Durable State

Router 需要少量持久状态。

至少：

```text
CommandInvocation
Direct Command outgoing MessageBinding
Recent Interaction（可选）
```

推荐：

```text
bot-gateway-state.sqlite
```

它与：

```text
Agent Home state
Plugin business state
```

完全分开。

---

# 23. CommandInvocation

Direct Command 开始执行前创建：

```ts
interface CommandInvocation {
  id: string;

  command: string;
  pluginId: string;

  requesterId: string;
  conversationId: string;

  status:
    | "RUNNING"
    | "COMPLETED"
    | "FAILED"
    | "INTERRUPTED";

  resultRef?: string;
  contextSummary?: string;

  createdAt: string;
  updatedAt: string;
}
```

调用顺序：

```text
create RUNNING invocation
↓ COMMIT
call handler exactly once
↓
COMPLETED / FAILED
↓ COMMIT
send result
↓
store outgoing binding
```

---

# 24. 不自动重试 Plugin Handler

对于 Direct Command：

> **一个 CommandInvocation 最多自动调用一次业务 handler。**

如果 handler：

- 抛异常 → `FAILED`；
- timeout → `FAILED` 或 `INTERRUPTED`；
- Gateway 在 handler 中途 crash → restart 后将遗留 `RUNNING` 标成 `INTERRUPTED`。

Gateway 不尝试判断：

```text
这个命令是不是幂等？
```

也不自动重新执行。

用户再次发送命令：

```text
→ 新 CommandInvocation
```

这避免对 `/bind`、`/checkin` 等可能有副作用的命令重复执行。

---

# 25. Router Restart Recovery

Gateway / Router restart：

1. 打开 router state；
2. 查找遗留 `RUNNING` CommandInvocation；
3. 标记为 `INTERRUPTED`；
4. 恢复仍在 retention 内的 outgoing MessageBinding；
5. 恢复 Recent Interaction；
6. 重新加载 Plugins；
7. 重新建立 Controller control stream。

不重放旧 handler。

---

# 26. Direct Command MessageBinding

Direct Command 的 outgoing QQ message 应记录：

```text
QQ message ID
→ CommandInvocation ID
```

例如：

```text
#831
→ cmd_17
→ /score
→ maimai
→ report_99
```

Router 重启后 binding 仍可恢复。

---

## MessageBinding Namespace

Direct Command MessageBinding 同样必须使用完整平台 namespace：

```text
platform
accountId
platformConversationId
threadId?
messageId
```

不能只保存裸 `messageId`。

这样 QQ、Telegram、多 Bot account 同时存在时不会产生 binding collision。


# 27. Direct Command Follow-up

用户：

```text
/score
```

Bot：

```text
[成绩信息]  #831
```

用户 reply：

```text
这个为什么掉这么多？
```

Router：

```text
reply_to #831
↓
Direct Command MessageBinding
↓
CommandInvocation
```

然后生成：

```ts
externalContext = {
  type: "direct_command_result",
  command: "score",
  pluginId: "maimai",
  contextSummary: "...",
  resultRef: "report_99"
}
```

再：

```text
Router
↓
Controller
↓
Runtime
↓
Main
```

Main 如需更多数据，可以调用 Gateway MCP 中的相关 AgentAction。

---

# 28. Runtime 自己的 Binding

Router 只解析自己拥有的 Direct Command binding。

以下 binding 仍属于 Runtime：

```text
Task
PendingQuestion
Artifact
Main outgoing message
```

Router 不读取 Runtime DB。

如果 reply 不属于 Router Direct Command binding：

```text
原样交给 Agent Runtime
```

Runtime 自己解析。

---

# 29. Recent Interaction

为了支持：

```text
“刚才那个成绩”
```

Router 可以维护有界 Recent Interaction。

这属于短期 Conversation State，不是 Memory。

可以包含：

```text
recent CommandInvocation
recent Direct Command result
```

Retention 使用时间或数量限制。

---

# 30. Plugin Failure Isolation

插件和 Gateway 同进程，因此需要明确异常边界。

每次 handler 调用必须至少有：

```text
try/catch
timeout
structured logging
invocation ID
```

普通插件异常不能导致 Router state 损坏。

如果插件代码触发进程级 crash：

- Gateway supervisor 重启 Gateway；
- Controller reconnect；
- Router recovery；
- 遗留 invocation 标记 `INTERRUPTED`。

---

# 31. CPU-heavy / 特殊执行插件

插件 API 不因为某个功能需要 subprocess/container 而改变。

普通 handler 可以内部：

```text
spawn subprocess
call external executable
use sandbox
```

但这是插件实现细节。

对于不可信代码执行，应由专门插件内部使用 sandbox，而不是让整个 Gateway 或 Agent Home 获得不必要权限。

---

# 32. Plugin Reload

MVP 不要求复杂 hot reload。

推荐：

```text
修改插件
↓
restart Bot Gateway
↓
reload modules
↓
rebuild registries
```

因为：

- Agent Home 不重启；
- Worker 不停止；
- Runtime state 不丢；
- Router state 持久；
- Controller 可以重建 exec stream。

以后只有在 Gateway restart 真正成为问题时再设计 module hot reload。

---

# 33. Plugin Configuration

配置只负责：

```text
哪些插件启用
插件自己的 config
Gateway plugin search path
权限 override（如需要）
```

不再维护：

```text
/score → provider URL
```

这种重复路由配置。

Command route 的 source of truth 是插件注册代码本身。

---

# 34. Plugin Discovery

MVP 可以采用非常简单的加载策略，例如：

```text
plugins/enabled/*
```

或静态 enabled plugin list。

关键是：

```text
发现模块
→ import
→ self-registration
```

不需要：

- service discovery；
- MCP discovery；
- provider registry service。

---

# 35. Natural Language 调插件

普通自然语言：

```text
“看看我最近舞萌成绩”
```

路径：

```text
QQ
↓
SnowLuma
↓
Router
↓
Controller
↓
Runtime
↓
Main
↓ MCP
Bot Gateway
↓
AgentActionRegistry
↓
maimai handler
↓
Main
↓
SnowLuma
```

与：

```text
/score
```

的 Direct Command 路径不同，但可以复用同一底层业务函数。

---

# 36. 权限边界

Direct Command 权限：

```text
Router / Command authorization
```

Agent Action 权限：

```text
Runtime + MCP Gateway exposure/authorization
```

二者可以不同。

例如：

```text
/bind
Direct Command: allowed for requester
Agent Action: not exposed
```

这样 LLM 不会自主修改账户绑定。

---

# 37. State Ownership

```text
Agent Home state
├── Task
├── Memory
├── Runtime MessageBinding
└── Projects

Bot Gateway state
├── CommandInvocation
├── Direct Command MessageBinding
└── Recent Interaction

Plugin state
└── plugin-specific authoritative business state
```

禁止跨边界直接 SQL 访问。

---

# 38. Backup

需要区分：

```text
Agent Home Backup
```

与：

```text
Full Bot Deployment Backup
```

Full Bot Deployment Backup 至少考虑：

```text
Agent Home /state
Bot Gateway state
Plugin data
Plugin code/config or reproducible deployment source
SnowLuma config
deployment manifest
```

---

# 39. MVP 目录示意

概念上：

```text
bot-gateway/
├── src/
│   ├── router/
│   ├── controller/
│   ├── plugin-loader/
│   ├── command-registry/
│   ├── action-registry/
│   ├── mcp/
│   └── persistence/
│
├── plugins/
│   ├── maimai/
│   └── ...
│
└── plugin-data/
    ├── maimai/
    └── ...
```

实际目录可调整。

---

# 40. MVP 验收

至少真实验证：

## 40.1 Plugin Load

```text
Gateway start
→ import plugin
→ command registered
→ action registered
```

## 40.2 Direct Command

```text
/score
→ Router
→ CommandRegistry
→ plugin handler
→ SnowLuma
```

Main 不参与。

## 40.3 Agent Action

```text
Natural Language
→ Main
→ Bot Gateway MCP
→ AgentActionRegistry
→ plugin handler
→ Main
```

## 40.4 Shared Business Logic

Direct Command 和 Agent Action 可以复用同一插件内部 service/function。

## 40.5 Restart

Gateway restart 后：

- Plugin Registry 重建；
- Router state 保留；
- Direct Command MessageBinding 保留；
- Agent Home 不重启；
- Controller reconnect。

## 40.6 Interrupted Invocation

Gateway 在 Direct Command handler 执行中 crash：

```text
RUNNING
→ restart
→ INTERRUPTED
```

不得自动重新调用 handler。

## 40.7 Context Bridge

Direct Command result：

```text
#831 → cmd_17
```

用户 reply：

```text
→ Router externalContext
→ Main
```

Main 能正确理解引用对象。

---

# 41. 非目标

当前不设计：

- Agent 自动写插件；
- Agent 自动部署插件；
- 一插件一 MCP Server；
- 一插件一常驻服务；
- Plugin Service discovery；
- Plugin container orchestration；
- Plugin hot reload；
- dynamic Pi Tool schema；
- autonomous plugin permission changes。

---

# 42. 最终不变量

1. **插件位于 Agent Home 外，但默认与 Bot Gateway 同进程运行。**
2. **插件在 import/init 阶段自注册。**
3. **Router 对 Direct Command 直接调用已注册 handler。**
4. **插件不是独立 MCP Server。**
5. **Bot Gateway 是 Agent Home 唯一的插件 MCP Gateway。**
6. **AgentActionRegistry 与 CommandRegistry 分离。**
7. **Direct Command 与 Agent Action 可以复用业务逻辑，但不是同一个接口。**
8. **Direct Command 不进入 Main history。**
9. **Direct Command follow-up 通过 Router durable binding 桥接给 Main。**
10. **Router state、Plugin state、Agent state 相互独立。**
11. **一个 CommandInvocation 最多自动执行一次 handler，不做业务自动 retry。**
12. **Gateway restart 后 Registry 重建，durable Router state 恢复。**
13. **插件不能覆盖 Core Control Command。**
14. **Plugin Action 是否对 Main/Worker 可见由授权层决定。**
15. **插件代码修改不要求重建 Agent Home。**
16. **MVP 通过重启 Gateway 加载插件变更，不提前实现复杂 hot reload。**
