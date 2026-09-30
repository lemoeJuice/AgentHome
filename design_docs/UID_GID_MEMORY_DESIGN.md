# UID / GID Memory 持久化模型设计

## 1. 目标

Memory 不再作为一个独立的权限系统存在。

它直接整合进容器内部已经存在的 Principal / Workspace 持久化模型。

核心映射：

```text
Principal UID
→ 用户长期 Memory

Workspace GID
→ 当前 Conversation 共享 Memory
```

Memory 系统不关心私聊还是群聊，只关心 Principal scope 与 Workspace scope。

## 2. 两种 Memory Scope

### Principal-scoped Memory

属于具体用户，用于：

- 用户长期偏好
- 用户长期事实
- 用户自己的 Agent state
- 跨 conversation 可复用的个人上下文
- 用户级索引、缓存或辅助状态

### Workspace-scoped Memory

属于当前 conversation 对应的 Workspace，用于：

- 当前 conversation 的共享上下文
- 项目知识
- 当前会话形成的决策
- 共享摘要
- Workspace 工具状态
- Workspace 索引
- 多成员共同维护的信息

## 3. 推荐目录结构

Principal Memory：

```text
/data/principals/<principal-id>/memory/
```

或者：

```text
$HOME/.agent/memory/
```

Workspace Memory：

```text
/data/workspaces/<workspace-id>/.agent/memory/
```

即：

```text
$HOME/.agent/memory
→ Principal-scoped

$WORKSPACE/.agent/memory
→ Workspace-scoped
```

## 4. 权限模型

Principal Memory：

```text
owner = Principal UID
mode = 0700
```

Workspace Memory：

```text
group = Workspace GID
mode = 2770
```

不需要额外维护 memory.read / memory.write / memory.share 等权限层。

## 5. Worker 进入任务时天然得到正确 Memory

Worker 已经运行在：

```text
uid = Principal UID
supplementary group = Workspace GID
```

因此天然可以访问：

```text
自己的 Principal Memory
+
当前 Workspace Memory
```

但不能访问其他 Principal Memory 或其他 Workspace Memory。

例如 Principal A 在 Workspace X：

```text
Principal A memory ✓
Workspace X memory ✓
Workspace Y memory ✗
Principal B memory ✗
```

进入 Workspace Y：

```text
Principal A memory ✓
Workspace Y memory ✓
Workspace X memory ✗
Principal B memory ✗
```

## 6. Memory 不关心聊天类型

不要设计：

```text
privateChatMemory
groupChatMemory
```

因为 Workspace 已经抽象了 conversation。

Memory 只需要：

```text
Principal Memory
Workspace Memory
```

## 7. Memory 与 Workspace 生命周期

Workspace Memory 与 Workspace 一起长期持久化。

任务结束只意味着 Worker 进程结束，不意味着 Workspace Memory 删除。

Principal Memory 同样随 Principal 长期存在。

## 8. Memory 可以视为普通持久化文件

Memory 可以是容器内持久化文件系统中的约定目录。

例如：

```text
memory/
├── summary.md
├── facts.json
├── decisions.md
├── state.sqlite
├── index/
└── embeddings/
```

具体格式由上层 Memory 模块选择。

权限完全由所在目录的 UID/GID 决定。

## 9. 推荐语义结构

Principal Memory：

```text
memory/
├── profile/
├── facts/
├── preferences/
├── history/
└── agent-state/
```

Workspace Memory：

```text
.agent/memory/
├── summary/
├── knowledge/
├── decisions/
├── index/
└── agent-state/
```

这是语义组织，不是权限层。

## 10. Harness 无关

Memory 应尽量脱离具体 Harness。

不要让 Pi、SnowLuma、OpenCode 各自拥有完全独立、互不兼容的持久化 Memory。

它们应尽量围绕统一的：

```text
Principal Memory
Workspace Memory
```

读取和写入。

Harness 可以有自己的格式适配器，但底层 scope 和存储边界保持一致。

## 11. Agent 可以自行维护 Memory

因为 Memory 位于 Worker 可访问的正常持久化目录，所以 Agent 可以：

- 更新摘要
- 创建索引
- 写入结构化状态
- 维护 SQLite
- 写 embedding index
- 创建辅助 metadata

这些都属于普通 Workspace / Principal 文件操作。

## 12. 多成员共享 Memory

同一 Workspace 的不同 Principal：

```text
A UID 10001
B UID 10002
Workspace GID 20001
```

都能访问：

```text
/workspace/.agent/memory
```

所以：

- A 形成的项目摘要，B 后续可以继续使用
- B 写入的决策记录，A 后续可以读取
- Workspace 工具和 Memory 可以共同演进

## 13. 文件 mode 与 umask

Workspace Memory 与 Workspace 普通文件使用同一共享策略：

```text
Workspace setgid
Worker umask = 0002
```

保证新建文件继承 Workspace GID，并允许同组成员继续修改。

Principal Memory 则保持 UID 私有权限。

## 14. Memory API 可选，但不是安全边界

未来可以提供统一 Memory API，例如：

```ts
memory.get(...)
memory.put(...)
memory.search(...)
memory.summarize(...)
```

但这个 API 只是为了：

- 统一格式
- 检索
- 索引
- abstraction
- harness integration

真正访问边界仍然来自：

```text
Principal UID
Workspace GID
Unix filesystem permissions
```

## 15. Main / Worker 边界

Memory 属于 Worker 可操作的持久化状态。

Main 仍然负责：

- Principal resolution
- Workspace resolution
- Task orchestration
- trusted runtime state

系统 credential、Controller DB、provider auth 等内容不属于 Memory。

## 16. 推荐运行时环境

Worker 启动时可以明确提供：

```text
HOME=/data/principals/<principal-id>/home
WORKSPACE=/data/workspaces/<workspace-id>

AGENT_PERSONAL_MEMORY=$HOME/.agent/memory
AGENT_WORKSPACE_MEMORY=$WORKSPACE/.agent/memory
```

这只是便利性，不是权限控制。

Harness 也可以通过 Runtime context 直接得到对应路径。

## 17. 最终结构

```text
Principal UID
│
├── home/
├── cache/
└── .agent/
    └── memory/
        └── personal long-term state


Workspace GID
│
├── project files
├── tools
├── artifacts
└── .agent/
    └── memory/
        └── conversation shared state
```

Worker：

```text
UID = Principal
supplementary GID = Current Workspace
```

因此天然获得：

```text
personal memory
+
current conversation memory
```

## 18. 核心原则

> 属于“人”的长期状态挂 Principal UID。

> 属于“当前协作上下文”的状态挂 Workspace GID。

> Memory 不区分私聊和群聊。

> Memory 不再维护独立 ACL。

> Memory 与普通 Workspace 持久化使用同一 Unix 权限模型。

> Principal Memory 跨 conversation 跟随用户。

> Workspace Memory 跟随 conversation / workspace。

> 一个任务只看到当前 Workspace 的共享 Memory。

> Memory 可以被不同 Harness 共享使用。

> Memory API 是功能抽象，不是安全边界。
