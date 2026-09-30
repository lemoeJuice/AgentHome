# Guest 持久化沙箱与多用户隔离设计

> 历史设计文档。Principal/Workspace 身份、Worker UID/GID 和共享 Memory
> 以 `PRINCIPAL_WORKSPACE_SYSTEM_ADMIN_DESIGN.md` 与 `UID_GID_MEMORY_DESIGN.md`
> 为准；本文件中按 Owner/Guest 区分 Worker Unix 身份或 workspace 的段落已被替代。

## 1. 目标

系统需要允许 Guest 用户真正执行任务，而不是只能使用少量只读功能。

Guest 应当可以：

- 执行 shell 命令
- 使用已有的 Node.js / npm / Python / Go / Git 等工具
- 安装项目级依赖
- 创建和修改文件
- 长期保存项目和工作区
- 多次任务之间继续之前的工作
- 生成 artifact
- 在合理范围内访问公网

同时必须限制 Guest：

- 不能访问其他用户的数据
- 不能访问 Controller / Router 的内部状态
- 不能读取 secrets
- 不能控制宿主机
- 不能控制 Podman / Docker runtime
- 不能访问内网或宿主服务
- 不能获得系统级管理权限
- 不能无限消耗 CPU、内存、磁盘或进程数

核心原则：

> Guest 是低信任用户，而不是临时用户。

Guest 可以拥有长期持久化空间，只是该空间必须被严格隔离。

---

## 2. 总体架构

系统本身已经运行在一个外层 rootless Podman 容器中，因此不要再为每个 Guest 创建嵌套容器。

推荐架构：

```text
Host
│
└── Rootless Podman Container
    │
    ├── Router
    ├── Controller
    ├── Worker
    │
    ├── Shared Runtime
    │   ├── node
    │   ├── npm
    │   ├── python
    │   ├── go
    │   ├── git
    │   └── other tools
    │
    ├── Internal State
    │   ├── main SQLite
    │   ├── task queue
    │   ├── permissions
    │   └── secrets
    │
    └── Persistent User Data
        └── /data/principals/
            ├── <principal-a>/
            ├── <principal-b>/
            └── ...
```

不采用：

```text
Guest
  ↓
Container
  ↓
Container
```

即不做 Podman-in-Podman / Docker-in-Docker。

---

## 3. 核心隔离模型

隔离分为两个独立层次：

```text
Linux UID / GID
→ 文件和进程级隔离

Application Capability
→ 业务能力隔离
```

不要让应用层权限系统负责所有安全问题。

例如：

- “Guest A 能不能读取 Guest B 文件”由 Linux 文件权限决定。
- “Guest A 能不能让机器人给另一个群发消息”由 capability system 决定。

---

## 4. Principal 模型

不要直接把 QQ 用户 ID 当作内部目录或 Linux UID。

建立统一 Principal：

```ts
interface Principal {
  id: string
  platform: "qq" | "telegram" | string
  externalId: string
  runtimeUid: number
  runtimeGid: number
  role: "guest" | "trusted" | "owner"
}
```

例如：

```text
QQ user 123456
       ↓
principal_id = p_f81d...
       ↓
runtime_uid = 10037
```

以后 Telegram：

```text
telegram:user:98765
       ↓
principal_id = p_a21c...
```

整个执行系统只认识：

```text
principal_id
runtime_uid
capabilities
```

不关心具体聊天平台。

---

## 5. 每个用户使用独立 Linux UID

这是用户之间隔离的核心。

例如：

```text
controller      UID 1000
worker          UID 1001

guest A         UID 10001
guest B         UID 10002
guest C         UID 10003
```

Guest A 的任务：

```text
Worker
  ↓
setgid(10001)
setuid(10001)
  ↓
Agent / shell
```

Guest B：

```text
setgid(10002)
setuid(10002)
```

这样即使两个 Agent 都在同一个外层容器里，也不是同一个 OS 身份。

---

## 6. 用户不需要真实 /etc/passwd 账户

无需为每个 QQ 用户运行：

```bash
useradd ...
```

Linux 文件权限实际依赖 UID/GID 数字。

所以可以直接动态分配：

```text
10000+
```

例如数据库：

```sql
principals

id
platform
external_id
runtime_uid
runtime_gid
role
created_at
```

然后文件：

```text
owner = runtime_uid
group = runtime_gid
```

如果命令：

```bash
whoami
```

无法解析用户名也没关系。

可以注入：

```text
USER=guest
LOGNAME=guest
```

---

## 7. 持久化目录设计

每个 Principal 拥有长期存在的数据空间：

```text
/data/principals/<principal-id>/
├── home/
├── projects/
├── cache/
├── artifacts/
└── agent/
```

例如：

```text
/data/principals/p_f81d/
```

整个目录：

```text
owner = UID 10001
mode = 0700
```

另一用户：

```text
/data/principals/p_a21c/
owner = UID 10002
mode = 0700
```

因此 UID 10001 无法读取 UID 10002 的目录。

隔离依赖 Linux 内核强制执行，而不是依赖 Agent 是否遵守规则。

---

## 8. 持久化与任务生命周期分离

不要把“任务结束”等价为“删除 workspace”。

任务可以结束，但用户数据继续存在。

```text
Task
  ↓
start Agent process
  ↓
use principal workspace
  ↓
task finished
  ↓
kill process
  ↓
workspace remains
```

例如第一次：

```text
“帮我做一个 Vue 网站”
```

生成：

```text
projects/my-site/
```

第二天：

```text
“继续改昨天那个网站”
```

继续使用同一个：

```text
projects/my-site/
```

---

## 9. 共享系统工具

系统镜像已有：

```text
/usr/bin/node
/usr/bin/npm
/usr/bin/python
/usr/bin/go
/usr/bin/git
```

这些工具应允许所有 Guest 正常使用。

共享部分包括 `/usr/bin`、`/usr/lib`、`/usr/share`、语言运行时、编译器、npm、git、系统 CA 等。

原则是 Guest 对共享工具拥有 read + execute 权限，但不需要系统级写权限。

---

## 10. npm 使用方式

Guest 必须允许：

```bash
npm install
npm run build
npm test
npm create ...
```

项目依赖自然写入：

```text
project/node_modules/
```

为每个用户设置：

```bash
HOME=/data/principals/<id>/home
XDG_CACHE_HOME=/data/principals/<id>/cache

NPM_CONFIG_CACHE=$HOME/.cache/npm
NPM_CONFIG_PREFIX=$HOME/.npm-global
```

PATH：

```bash
PATH=$HOME/.npm-global/bin:$PATH
```

这样 `npm install -g package` 也只会修改该用户：

```text
home/.npm-global/
```

而不会修改 `/usr/lib/node_modules`。

---

## 11. Python / Go 等工具同理

Python 推荐使用：

```text
venv
pip --user
uv
```

用户自己的环境放在 `home/`、`projects/`、`cache/`。

Go：

```bash
GOPATH=$HOME/go
GOCACHE=$HOME/.cache/go-build
```

所有可写状态均指向该 Principal 的目录。

---

## 12. Controller 与 Guest 隔离

Controller、Router、Worker 的核心状态不能放在 Guest 可读目录中。

例如：

```text
/app/runtime/
├── state.db
├── secrets/
├── config/
└── queue/
```

权限应只允许系统进程读取。

例如：

```text
state.db
owner = controller
mode = 0600
```

Guest Agent 已经运行在 UID 10001+，因此即使尝试：

```bash
sqlite3 /app/runtime/state.db
```

也应该直接得到：

```text
Permission denied
```

---

## 13. Guest Capability

业务权限不要通过 shell 命令黑名单实现。

不要：

```ts
if (command.includes("rm")) deny()
```

建立 capability system：

```ts
type Capability =
  | "workspace.read"
  | "workspace.write"
  | "process.exec"
  | "network.public"
  | "artifact.export"
  | "memory.read"
  | "memory.write"
  | "message.current_session"
  | "message.cross_session"
  | "secret.read"
  | "network.private"
  | "host.access"
  | "container.manage"
  | "system.modify"
```

Guest 默认可拥有：

```text
workspace.read
workspace.write
process.exec
network.public
artifact.export
memory.read
memory.write
message.current_session
```

默认禁止：

```text
secret.read
host.access
container.manage
system.modify
network.private
message.cross_session
```

---

## 14. Guest 可以自由破坏自己的空间

不要试图阻止 Guest：

```bash
rm -rf ~/projects/foo
```

如果这是他自己的文件，这是合理行为。

核心原则：

> 用户可以自由破坏自己的世界，但不能破坏其他人的世界或系统世界。

因此更重要的是保证：

```text
自己的目录       RW
别人的目录       NONE
系统敏感目录     NONE
共享 runtime     RO
```

而不是维护危险命令列表。

---

## 15. 网络权限

Guest 应允许正常公网访问，否则开发任务能力会严重受限。

应该允许 GitHub、npm registry、PyPI、普通 HTTPS API、公开网站，即：

```text
network.public = true
```

但需要阻断：

```text
127.0.0.0/8
10.0.0.0/8
172.16.0.0/12
192.168.0.0/16
169.254.0.0/16
Tailscale CGNAT / 内网地址
宿主服务
Podman API
本地管理端口
```

防止 Guest 使用 Agent 扫描局域网、访问宿主服务、metadata service 或其他内部组件。

这部分应在外层容器或宿主防火墙层实现，而不是靠 Agent 自觉。

---

## 16. 资源限制

不要通过禁止编译、安装依赖等方式控制资源。

应直接限制：

```text
CPU
Memory
PIDs
Disk quota
Task runtime
Artifact size
Cache size
```

例如：

```yaml
guest:
  cpu: 2
  memory: 2GiB
  pids: 128

  task_timeout: 10m

  workspace_quota: 2GiB
  cache_quota: 1GiB
  artifact_quota: 512MiB
```

即使用户执行无限循环，也只能消耗自己允许的资源。

---

## 17. 数据 Scope

持久化对象最好区分作用域：

```ts
type Scope =
  | "task"
  | "session"
  | "principal"
  | "group"
  | "system"
```

含义：

```text
task       任务结束后删除
session    当前对话生命周期
principal  用户长期数据
group      群共享数据
system     系统级数据
```

例如：

```text
/tmp                         task
conversation scratch         session
user projects                principal
shared group project         group
controller config            system
```

---

## 18. 第一阶段不需要实现 Group Workspace

第一版优先完成 `principal` scope。

未来再添加 `group` scope，并引入：

```text
group.read
group.write
group.admin
```

不要为了未来需求一开始把实现搞复杂。

---

## 19. Worker 执行流程

```text
收到消息
   │
   ▼
Router
   │
resolve platform identity
   │
   ▼
Principal
   │
load role / capabilities
   │
   ▼
Controller
   │
resolve runtime UID
resolve workspace
   │
   ▼
Worker
   │
prepare environment
   │
setgid
setuid
   │
   ▼
Agent / harness
```

伪代码：

```ts
const principal = await resolvePrincipal(message.sender)

const env = buildUserEnvironment(principal)

const child = spawn(agentCommand, args, {
  cwd: principal.workspace,
  env,
})

dropPrivileges(child, {
  uid: principal.runtimeUid,
  gid: principal.runtimeGid,
})
```

实际实现时应确保：

```text
setgid
setgroups
setuid
```

顺序正确，并清理继承的 supplementary groups。

---

## 20. 用户环境变量

Worker 启动 Agent 时设置：

```text
HOME=/data/principals/<id>/home
USER=guest
LOGNAME=guest

XDG_CACHE_HOME=$HOME/.cache
XDG_CONFIG_HOME=$HOME/.config
XDG_DATA_HOME=$HOME/.local/share

NPM_CONFIG_CACHE=$HOME/.cache/npm
NPM_CONFIG_PREFIX=$HOME/.npm-global

GOPATH=$HOME/go
GOCACHE=$HOME/.cache/go-build
```

PATH：

```text
$HOME/.npm-global/bin
$HOME/.local/bin
/usr/local/bin
/usr/bin
/bin
```

---

## 21. 不允许暴露给 Guest 的东西

必须确保 Guest Agent 无法获得：

```text
Podman socket
Docker socket
host root filesystem
controller database
router state
service credentials
bot tokens
API keys
SSH keys
other users' directories
host PID namespace
privileged devices
```

特别禁止：

```text
/run/podman/podman.sock
/var/run/docker.sock
```

如果 Agent 能访问 container runtime socket，则多数隔离措施都会失去意义。

---

## 22. 第一版可以不实现额外 filesystem sandbox

第一阶段可以只依赖：

```text
rootless outer container
+
per-principal UID/GID
+
Unix file permissions
+
capability system
```

未来如果需要进一步限制 Guest 对 `/etc`、`/proc`、`/app` 等 world-readable 内容的可见性，再考虑：

```text
bubblewrap
Landlock
seccomp
```

不要一开始引入复杂的嵌套沙箱。

---

## 23. 推荐权限结构

```text
Host user
│
└── Rootless Container
    │
    ├── Controller
    │   └── privileged inside container only
    │
    ├── Router
    │
    ├── Worker
    │
    ├── Shared Toolchain
    │   ├── node/npm
    │   ├── python
    │   ├── go
    │   └── git
    │
    ├── Guest A
    │   UID 10001
    │   └── /data/principals/A
    │
    ├── Guest B
    │   UID 10002
    │   └── /data/principals/B
    │
    └── System State
        Guest inaccessible
```

---

## 24. 安全模型总结

系统最终依靠三层：

```text
Layer 1
Rootless container
→ 保护宿主机

Layer 2
Per-principal UID/GID + filesystem permissions
→ 保护不同用户

Layer 3
Application capabilities
→ 保护业务能力
```

对应关系：

```text
Guest A 读取 Guest B 文件
→ Linux 阻止

Guest A 读取 secrets
→ Linux + capability 阻止

Guest A 控制 Podman
→ socket 不暴露

Guest A 给其他群发消息
→ capability 阻止

Guest A rm -rf 自己的项目
→ 允许

Guest A npm install
→ 允许

Guest A 长期维护项目
→ 允许
```

---

## 25. 第一阶段实现目标

Agent 优先完成以下内容：

1. 增加 Principal 数据模型。
2. 为 Principal 分配持久 runtime UID/GID。
3. 创建 `/data/principals/<id>`。
4. 设置 owner 与 `0700` 权限。
5. Worker 以对应 UID/GID 启动 Agent。
6. 清理 supplementary groups。
7. 给每个用户设置独立 HOME。
8. 配置 npm / Python / Go cache 和用户级安装路径。
9. 保证 Node/npm/Python/Go/Git 可以正常使用。
10. 将 Controller SQLite、secrets、配置目录从 Guest 权限中隔离。
11. 增加 Guest capability 配置。
12. 默认允许 workspace RW、exec、公网访问。
13. 默认禁止 host、secret、container runtime、cross-session action。
14. 添加 CPU、内存、PID、磁盘和任务时长限制。
15. 添加针对其他用户 workspace 的隔离测试。

---

## 26. 必须补充的测试

### 文件隔离

Guest A：

```text
可以读写自己的 workspace
不能读取 Guest B workspace
```

Guest B 同理。

### 系统状态隔离

Guest：

```text
不能读取 controller DB
不能读取 secrets
```

### Runtime

Guest 可以：

```text
node --version
npm --version
python --version
go version
git --version
```

### npm

Guest 可以：

```text
npm install
npm run build
```

并且文件写入自己的 workspace/cache。

### 持久化

任务 1 创建：

```text
hello.txt
```

任务结束。

任务 2 仍然可以读取 `hello.txt`。

### 权限

Guest 不可以：

```text
访问 Podman socket
读取另一个 Principal
调用 owner-only capability
```

---

## 27. 非目标

第一阶段暂时不要实现：

```text
nested containers
per-task VM
复杂 syscall policy
动态 seccomp generation
完整 group workspace
跨 Principal 文件共享
复杂权限审批 UI
命令黑名单
Agent 自动提权
```

优先保持实现简单。

---

## 28. 最终设计原则

> 系统工具共享，用户身份隔离。

> 数据可以长期持久化，但权限不能跨 Principal。

> Linux 负责文件与进程安全，业务系统负责 capability。

> Guest 可以自由使用和破坏自己的 workspace。

> 不依赖 Agent 自觉遵守安全规则。

> 不通过限制 npm、编译器、shell 等正常工具来获得安全性。

> 外层 rootless container 保护宿主，多 UID 模型保护容器内部不同用户。

---

## 实现增补：统一 Model Plane / Execution Plane

本文件早期章节中“Guest 使用特殊 Pi/沙箱 harness”的描述已由当前实现收敛为：**Owner 和 Guest 共用 Trusted Pi Runtime + Principal-scoped ExecutionBackend**。以下增补为当前代码的权威运行时约束。

```text
Control Plane (Runtime/Task/Principal/SQLite)
            │ authenticated Runtime tool socket
            ▼
Model Plane (trusted Pi UID 10002, provider auth)
            │ fixed trusted extension tool calls
            ▼
Execution Plane (TaskService ExecutionBackend)
       ┌────┴────┐
  Owner UID   Guest UID
```

- 固定 Owner UID/GID 为 `10001`；Principal UID/GID 分配范围为 `20000–60000`；Trusted Pi Model Plane 使用 `10002`，不属于任何 Principal。Conversation workspace 使用独立 UID 范围：Owner 私聊 `10003–19999`，Guest/群聊 `60001–65535`。
- Owner、Guest Worker 都以 `PRINCIPAL_BROKERED` 模式运行：Pi 进程是 Model Plane；workspace command 由 `agent-home-guest-exec` 以当前 Conversation 的 workspace UID/GID 启动，调用者的授权仍使用独立 Principal 和 Capability。
- Trusted Pi 的 bwrap mount 只提供 Pi command/runtime、`/state/model/pi/agent`、Model Plane session、Unix Runtime Tool socket 和固定 Runtime extension；不 bind Principal workspace。`--no-builtin-tools --no-extensions --no-skills --no-context-files` 禁止项目 extensions 自动加载。
- Principal 的 home/cache/artifacts 位于 `/state/principals/uid-<runtime-uid>/`；项目 workspace 位于 `/state/workspaces/conversations/<sha256(conversation-id)>/projects/`。不创建 `/state/home`、`/state/projects` 兼容 symlink；Pi auth/session 位于 Model Plane。
- Owner/Guest 的 shell 和 workspace read/write/edit/mkdir/remove/list/stat 工具均由 ExecutionBackend 执行。`ExecutionContext` 的 task、worker、principal、uid/gid、role、capability、workspace 由 Runtime 的持久记录生成；模型只发送 operation 参数。
- Model Plane auth 位于 `/state/model/pi/agent`，UID 10002 所有，Principal UID 无目录访问权。Pi provider 凭据不进入 Principal home、workspace、tool env 或 Worker process；Execution Plane 不提供 Pi auth mount。
- Model Plane 直接连接模型 provider；Guest 和 guest/group Conversation workspace UID nftables 限制不阻挡 Model Plane provider 网络。
- `guest.enabled` 默认为关闭；启用执行要求外层 rootless Podman user namespace 映射完整 Principal UID 范围、容器 root 能 setuid/setgid、`NET_ADMIN` 可用、nftables 安装成功。state volume 不使用 `:U`，保留 numeric owner。
- CPU/AS/NPROC/FSIZE/NOFILE 当前由 helper 的 RLIMIT 与 wall-clock/output/workspace 检查控制；Pi/Node 22 的 undici WebAssembly 需要 16 GiB `RLIMIT_AS` address-space ceiling 才能启动，但这不是 16 GiB resident-memory/cgroup 限制。尚无 per-worker cgroup 和 filesystem quota。现有 Guest active-worker quota 保持每 Principal 单 Worker；Owner process cleanup 按 Worker process group，避免跨 Worker UID 清理。
- 当前没有通用 `secret.read`、`secret.use` 或 `secret.export` Principal tool。Pi provider credentials 只属于 Model Plane；未来普通服务凭据的 `secret.use`/`secret.export` 需要单独授权 API，raw export 默认关闭。
