# Principal / Workspace / System Admin 身份模型设计

## 1. 目标

系统不再把 Owner / Guest / Trusted 作为 Agent 执行权限等级。

普通 Agent 执行统一使用：

```text
Principal
+
Conversation Workspace
+
Worker
+
Unix UID/GID
```

不同用户之间的执行隔离依赖：

```text
Principal UID
Workspace GID
Main / Worker 进程边界
Unix filesystem permissions
```

而不是依赖 Owner / Guest 角色决定是否可以运行 shell、使用 npm/Python/Go/Git、写 workspace、创建工具、执行工具或持久化项目。

核心身份模型收敛为三个正交概念：

```text
Principal Identity
Conversation Membership
System Administration
```

分别表示：

```text
Principal Identity
→ 这个人是谁

Conversation Membership
→ 这个人属于哪些 conversation / workspace

System Administration
→ 这个人能否管理 Main / Runtime
```

## 2. Principal

Principal 表示一个稳定的执行身份。

概念上：

```ts
interface Principal {
  id: string
  platform: string
  externalId: string
  runtimeUid: number
  runtimeGid: number
}
```

不同 Principal 使用不同 UID。

Principal 只负责表示“谁在执行”，不负责决定当前 Workspace。

## 3. Workspace

每个 conversation 对应一个 Workspace：

```text
conversation_id
→ workspace_id
```

Workspace 不关心它在平台语义上属于私聊、群聊、频道还是其他会话类型，只表示这一段 conversation 共享的持久化执行空间。

## 4. Conversation Membership

conversation 自身已经拥有成员关系，因此：

```text
Conversation Membership
→ Workspace Membership
```

不需要在 Workspace 层额外维护一套 workspace member / workspace.read / workspace.write / workspace.manage ACL。

Principal 属于当前 conversation，即可进入当前 Workspace。

## 5. Unix UID / GID 模型

Principal UID 表示“谁在执行”，并隔离 Principal 私有状态。

每个 Workspace 分配稳定 Unix GID，表示当前进程可以参与哪个共享 Workspace。

例如：

```text
Workspace X
→ GID 20001
```

目录建议：

```text
/data/workspaces/<workspace-id>
```

权限：

```text
owner = runtime/system user
group = workspace GID
mode = 2770
```

使用 setgid，保证 Workspace 中新建文件继承 Workspace GID。

## 6. Worker 执行身份

Principal A 在 Workspace X 中运行：

```text
uid = 10001
primary gid = 10001
supplementary groups = [20001]
cwd = /data/workspaces/X
```

Principal B：

```text
uid = 10002
primary gid = 10002
supplementary groups = [20001]
cwd = /data/workspaces/X
```

共享的是 Workspace GID，不是 UID。

## 7. 每个任务只注入当前 Workspace GID

一个 Principal 可以参与多个 conversation，但每次任务只获得当前 Workspace 所需的 supplementary GID。

不要因为 A 属于 X、Y、Z，就在 X 的任务里同时给它 X/Y/Z 三个 GID。

这样单次 Worker 只能直接访问当前 conversation 的 Workspace。

## 8. ExecutionContext

ExecutionContext 显式组合 Principal 与 Workspace：

```ts
interface ExecutionContext {
  taskId: string

  principal: {
    id: string
    uid: number
    gid: number
  }

  workspace: {
    id: string
    path: string
    gid: number
  }
}
```

核心原则：

```text
Principal != Workspace
```

不要隐式使用：

```text
workspace = principal.workspace
```

## 9. Workspace 内普通操作

普通 Worker 操作直接由 Unix 权限决定：

```text
read
write
edit
mkdir
rm
rename
shell
git
npm
python
go
build
test
```

Worker 只需要正确设置 UID、primary GID、supplementary Workspace GID、cwd、HOME 和 umask。

## 10. Shared Workspace 文件模式

多人协作时必须保证同 Workspace 成员能继续修改彼此创建的文件。

推荐：

```text
Workspace directory: 2770
Worker umask: 0002
```

这样典型文件为 0664，目录为 0775/2775，并继承 Workspace GID。

## 11. Principal 私有状态

Principal 可以拥有私有目录：

```text
/data/principals/<principal-id>/
```

例如 home、cache、config、state。

权限：

```text
owner = Principal UID
mode = 0700
```

因此：

```text
Principal private state
→ UID 隔离

Conversation Workspace
→ GID 共享
```

## 12. HOME 与 CWD

Worker 启动时：

```text
HOME=/data/principals/<principal-id>/home
cwd=/data/workspaces/<workspace-id>
```

用户级 cache/config 属于 Principal；源码、项目、workspace tools、会话产物属于 Workspace。

## 13. Agent 自写工具

Agent 可以在 Workspace 中创建工具：

```text
/workspace/tools/read-image.ts
/workspace/tools/search.py
```

同一 conversation 的其他成员可以继续维护和调用。

执行身份始终属于当前调用者：

```text
Workspace tool
→ Worker
→ 当前 Principal UID
→ 当前 Workspace GID
```

Workspace tool 不能因为被共享就进入 Main / Trusted Runtime 权限域。

## 14. System Admin

Owner 不再作为 Worker 执行等级。

如需系统管理身份，则单独表示为 System Admin。

System Admin 只用于 Main / Control Plane 管理操作，例如：

- 修改系统配置
- 管理 provider credential
- 管理模型默认配置
- 管理平台连接
- runtime maintenance
- trusted extension 管理
- 系统日志与数据库维护
- 停止或升级整个服务

System Admin 不影响普通 Worker 权限。

## 15. System Admin 与 Principal 正交

推荐：

```text
Principal
├── runtime UID/GID
├── platform identity
├── conversation memberships
└── maybe System Admin
```

而不是：

```text
Principal
└── role = guest / trusted / owner
```

System Admin 可以用独立表或现有 allowlist 表示。

## 16. System Admin 不进入普通 ExecutionContext

普通 Worker 不需要知道 isOwner / isGuest / isAdmin。

即使 Principal 是 System Admin，其普通任务仍只获得：

```text
Principal UID
+
当前 Workspace GID
+
当前 Workspace path
```

不能因此使用 root UID、获得所有 Workspace GID、访问 Main 内部状态或 provider credential。

## 17. Conversation Role 与 System Admin 分离

平台中的 member/admin/owner 属于 Conversation-level authority，与 System Admin 不是同一个概念。

群管理员不自动成为系统管理员；系统管理员也不自动成为所有 conversation 的 Workspace 成员。

## 18. Main / Worker 边界

Pi/provider credentials、Controller DB、bot tokens、runtime internal state、container runtime socket、trusted config 等敏感状态继续由 Main / Worker 分离保护。

这与 Principal / Workspace 的 Unix 文件模型是两个不同安全边界。

## 19. 推荐最终结构

```text
Message
  │
  ├── sender
  │      ↓
  │   Principal
  │      ↓ UID
  │
  └── conversation
         ↓
      Workspace
         ↓ GID
          │
          ▼
   ExecutionContext
          │
          ▼
        Worker
          │
   UID + Workspace GID
          │
          ▼
      Unix Kernel
          │
          ▼
       Workspace
```

系统管理操作：

```text
Principal
    ↓
Main / Control Plane
    ↓
System Admin check
    ↓
trusted operation
```

## 20. 核心原则

> Principal 表示“谁”。

> Conversation 决定共享上下文与 Workspace membership。

> Workspace 表示“在哪工作”。

> 不同 Principal 始终使用不同 UID。

> 同一 Workspace 通过 GID 共享。

> 每个任务只获得当前 Workspace 的 supplementary GID。

> 普通文件和进程权限交给 Unix。

> System Admin 只是 Control Plane 管理身份，不是 Worker 权限等级。

> Agent 自写工具属于 Workspace，但以当前 Principal 身份执行。

> Main / Worker 分离继续负责系统敏感状态。
