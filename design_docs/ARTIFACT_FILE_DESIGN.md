# Artifact & File Design

> 状态：详细设计基线  
> 上位设计：`AGENT_HOME_DESIGN.md`  
> 权限基线：`AUTHORIZATION_CAPABILITY_DESIGN.md`  
> 相关设计：`TASK_RUNTIME_DESIGN.md`、`AGENT_HOME_CONTAINER_CONTROL_DESIGN.md`、`EXTERNAL_PLUGIN_COMMAND_DESIGN.md`

---

# 1. 目标

本设计负责文件在系统中的受控生命周期：

```text
Chat Platform inbound file/image（当前 QQ/SnowLuma）
Agent/Worker generated file
Gateway Plugin generated file
        ↓
      Artifact
        ↓
validate / authorize
        ↓
read / reference / publish / send
```

核心问题不是：

```text
文件放哪个目录？
```

而是：

```text
谁能读这个文件？
谁能把它注册成 Artifact？
Artifact 属于哪个 Task/Conversation？
谁能把它发到哪个 Chat destination？
```

---

# 2. 核心安全原则

必须成立：

```text
File Read
≠
Artifact Registration
≠
Artifact Publication
≠
Chat Send
```

读取一个文件不自动意味着可以把它发送给用户。

任何 Chat Platform file/image send 都不能直接接受任意 raw filesystem path。

禁止：

```text
qq_send_file("/state/home/.ssh/id_rsa")
```

推荐接口只接受：

```text
ArtifactRef
```

---

# 3. Artifact 是受控引用

概念：

```ts
interface ArtifactRef {
  authority: "agent-home" | "bot-gateway";
  artifactId: string;
}
```

`authority` 表示 Artifact 的持有域。

Agent Home 与 Bot Gateway 不共享 filesystem。

因此：

```text
agent-home artifact
```

与：

```text
bot-gateway artifact
```

可以使用统一逻辑引用格式，但底层文件存储独立。

---

# 4. Agent Home Artifact

概念 metadata：

```ts
interface AgentArtifact {
  id: string;

  ownerTaskId?: string;
  producerWorkerId?: string;

  sourceType:
    | "QQ_INBOUND"
    | "WORKER_OUTPUT"
    | "MAIN_OUTPUT"
    | "IMPORTED";

  canonicalPath?: string;

  filename: string;
  mime?: string;
  size: number;

  status:
    | "AVAILABLE"
    | "PUBLISHED"
    | "EXPIRED"
    | "DELETED";

  createdAt: string;
  expiresAt?: string;
}
```

Metadata 是 durable truth。

实际临时 materialization 可以是 ephemeral。

---

# 5. Gateway Artifact

Bot Gateway Plugin 可能生成：

```text
score image
report
temporary export
```

这些文件属于 Gateway domain。

概念：

```ts
interface GatewayArtifact {
  id: string;
  pluginId: string;

  invocationId?: string;

  filename: string;
  mime?: string;
  size: number;

  createdAt: string;
  expiresAt?: string;
}
```

Agent Home 不直接读取：

```text
plugin-data/.../file.png
```

跨域访问必须通过 Bot Gateway capability / transfer API。

---

# 6. Artifact Ownership

Artifact 必须有清晰 ownership/context。

Agent Worker output 默认绑定：

```text
Task
+
producer Worker
```

Chat Platform inbound file 默认绑定：

```text
source Conversation
+
requesting Task / Main turn
```

Gateway Plugin output 默认绑定：

```text
CommandInvocation
+
Plugin
```

Ownership 用于授权和生命周期，不代表 filesystem Unix owner。

---

# 7. Agent Home 文件区域

概念语义：

```text
/state/inbox
/state/artifacts
/state/projects
/scratch
```

## `/state/inbox`

受控持久输入。

用于：

- 聊天平台用户上传；
- 明确导入到 Agent Home 的外部文件。

## `/state/artifacts`

受控持久输出。

用于需要在 Task 完成后仍可引用的生成物。

## `/state/projects`

项目工作区。

项目文件不是自动 Artifact。

## `/scratch`

临时文件。

Runtime restart / container recreation 可以丢失。

---

# 8. Project File ≠ Artifact

例如 Worker 读取：

```text
/state/projects/moneko/package.json
```

不意味着它自动成为可发送 Artifact。

需要显式：

```text
publishArtifact(path)
```

才能进入 Artifact 系统。

---

# 9. Worker Artifact Publication

标准流程：

```text
Worker
↓
publishArtifact(path, metadata)
↓
Artifact Service
↓
authorization
↓
realpath / root validation
↓
symlink validation
↓
file type / size
↓
register Artifact
↓
ArtifactRef
```

Worker 不直接调用 SnowLuma file send。

---

# 10. Allowed Source Roots

Artifact Service 必须根据 Worker capability 确定允许来源。

例如可能允许：

```text
Task artifact workspace
authorized project root
task scratch output
```

不允许默认扫描整个：

```text
/state/home
/state/secrets
```

Source root 来源于 authorization，不由 Worker 通过 path 字符串扩大。

---

# 11. Realpath Validation

必须在注册 Artifact 前解析：

```text
realpath
```

然后检查：

```text
realpath ∈ allowed roots
```

不能只做：

```text
string startsWith("/state/projects/foo")
```

否则可能被：

```text
../
symlink
mount-like indirection
```

绕过。

---

# 12. Symlink Policy

MVP 推荐：

```text
允许文件本身是普通文件
```

对于 symlink：

```text
resolve realpath
↓
最终 target 必须仍在 allowed root
```

如果无法可靠确认：

```text
deny
```

不要通过扩展状态机表达。

---

# 13. Sensitive Path Deny

即使某个 execution 具有较大的 filesystem read ability，也可以对 Artifact Publication 设置额外 deny。

典型敏感类别：

```text
credentials
SSH keys
auth tokens
browser credential DB
runtime secret files
Pi auth storage
private deployment credentials
```

具体 path list 由部署实现维护。

这是一层 defense-in-depth。

---

# 14. File Read 与 Publish 分离

例如 Worker 拥有：

```text
ProjectCapability(project=moneko, READ)
```

允许读取项目。

但要发布：

```text
README.md
```

仍需：

```text
Artifact publish capability
```

因此：

```text
read access
≠ exfiltration permission
```

---

# 15. Artifact Publish Capability

Artifact Service 在注册/发布时检查：

```text
caller
task
source root
artifact operation
```

概念：

```ts
interface ArtifactCapability {
  readableArtifactAuthorities: string[];

  publishTaskIds: string[];

  allowedDestinations: string[];
}
```

具体结构可以在实现时调整。

核心是可做 subset 判断。

---

# 16. Chat Send Capability

Artifact 成为合法 Artifact 后，发送仍然需要：

```text
Artifact authorization
∩
Chat send authorization
```

例如：

```text
Artifact belongs to Task #17
Task notificationConversation = group:123
```

并不自动意味着：

```text
send to private:owner
```

合法。

---

# 17. Agent Outbound Artifact Flow

推荐：

```text
Worker
↓ publishArtifact()
Agent ArtifactRef
↓
Main decides to present
↓
SnowLuma Capability
↓ authorize destination
↓
stream/upload artifact
↓
QQ
```

SnowLuma Capability 不接受任意 local path。

---

# 18. Agent Home 与 SnowLuma 不共享路径

Host 与 Agent Home filesystem 隔离。

所以不能依赖：

```text
SnowLuma sees /state/artifacts/xxx
```

真实传输必须使用 SnowLuma 当前 API 支持的：

- upload；
- stream；
- bytes；
- temporary accessible URL；
- 或其他当前官方支持机制。

实现 Agent必须参考当前 SnowLuma/OneBot 文档/API选择真实可用方式。

设计要求只有：

> 不通过 Host bind mount 把整个 Agent Home filesystem 暴露给 SnowLuma。

---

# 19. QQ Inbound File

本节描述的是 **Main 决定读取附件之后**的导入与授权路径，不是 Main turn 的启动前置条件。
Router 只按唤醒策略判断是否形成 Main turn，并传递文本摘要及可信消息引用；不得
为了检查或登记附件而提前下载附件。Main 可以仅凭摘要回答，也可以按需调用
SnowLuma MCP 的原生 OneBot action 查询消息、历史或下载附件。

流程：

```text
Main invokes a SnowLuma MCP Stream Action
↓
Runtime validates the returned file is inside the MCP download root
↓
stream into Artifact Service
↓
validate size, source scope and content metadata
↓
on-demand Main/Task scoped ArtifactRef
```

Runtime 不信任：

- 用户提供的 filename；
- MIME；
- extension；
- URL content。

都只作为 metadata。

---

# 20. Inbound Materialization

QQ inbound 文件可以：

```text
durably import to /state/inbox
```

或：

```text
临时 materialize to /scratch
```

选择依据：

- Task 是否需要 restart continuity；
- 文件是否需要长期引用；
- size / retention policy。

如果 Task 需要长时间运行，输入文件应进入 durable inbox。

---

# 21. Inbound Artifact Capability

用户在某 Conversation 上传文件：

```text
该文件可供这个 turn / derived Task 使用
```

不等于：

```text
所有其他 Task 都可读
```

Artifact Service 根据：

- requester；
- conversation；
- Task；
- capability；

控制访问。

---

# 22. Image 与 File

图片也是 Artifact。

区别只是：

```text
presentation / MIME / helper APIs
```

不要建立完全独立的安全模型。

统一：

```text
ArtifactRef
```

即可。

---

# 23. Quoted / Replied Attachment

当 Main 被唤醒后按需读取 reply target：

```text
SnowLuma
↓
message metadata
↓
attachment refs
```

只有实际需要时才 ingest。

不要求 Router 把所有历史附件提前下载。

---

# 24. Large File

MVP 不建立复杂分片协议。

要求：

- 不默认一次性读入内存；
- 优先 stream；
- 允许 temporary file；
- 有 configurable size limit；
- 超过 limit 返回结构化拒绝或要求用户使用其他方式。

---

# 25. MIME 与 Filename

`filename` 用于展示，不作为安全判断。

`mime` 可以参考：

- source metadata；
- content sniffing；
- application knowledge。

但不能根据：

```text
foo.txt
```

就假定内容安全。

---

# 26. Artifact Result Contract

Main / Worker / Plugin 不需要获得 arbitrary server filesystem path。

应优先返回：

```ts
interface ArtifactDescriptor {
  ref: ArtifactRef;
  filename: string;
  mime?: string;
  size: number;
}
```

内部需要 materialized path 时，由对应 authority 的 Artifact Service 在受控调用中提供。

---

# 27. Artifact Retention

至少区分：

```text
temporary
task-lifetime
persistent
```

## temporary

允许自动清理。

## task-lifetime

至少保留到 Task terminal + retention window。

## persistent

明确保留，直到用户/系统清理。

MVP 不需要复杂 archival tier。

---

# 28. Artifact Deletion

删除 Artifact：

```text
metadata status
+
underlying file
```

应保持一致。

如果 file 删除失败：

- 不创造复杂 Artifact state taxonomy；
- 记录 runtime/cleanup exception；
- 保留可解释 metadata；
- 后续 cleanup 重试或交给 Main/operator。

---

# 29. Task Completion

Task COMPLETED 不自动删除 Artifact。

Task Runtime 只保存：

```text
artifact reference
```

Artifact Service 决定 retention。

---

# 30. Plugin-generated Artifact

Gateway Plugin 直接处理 Direct Command：

```text
/score
↓
plugin handler
↓
Gateway Artifact
↓
Router
↓
SnowLuma
```

这个流程完全可以不进入 Agent Home。

---

# 31. Plugin Artifact Follow-up

如果用户随后：

```text
reply score image
“这里为什么掉了？”
```

Router binding：

```text
QQ message
→ CommandInvocation
→ resultRef / Gateway ArtifactRef
```

再向 Main 提供：

```text
externalContext
```

Main 需要进一步读取时，通过 Bot Gateway MCP Action 请求。

Agent Home不直接挂载 plugin-data。

---

# 32. Agent 需要 Plugin Artifact

如果 Main/Worker 确实要把 Gateway Artifact 作为 Task input：

```text
Bot Gateway Artifact
↓ explicit transfer
Agent Home Artifact ingest
↓
new Agent ArtifactRef
```

这是一次显式跨 authority copy。

不要让：

```text
Agent Home ArtifactRef
```

直接指向 Gateway 本地 path。

---

# 33. Plugin State ≠ Artifact

例如：

```text
plugin-data/maimai/state.db
```

是 Plugin authoritative state。

它不是可发送 Artifact。

Plugin 需要导出报告时：

```text
state
↓
render/export
↓
Gateway Artifact
```

不能直接发布 DB 文件。

---

# 34. Artifact Service API

概念：

```text
ingestQQAttachment()
registerLocalArtifact()
getArtifactMetadata()
openArtifact()
publishArtifact()
deleteArtifact()
```

具体函数签名由实现决定。

安全判断集中在 Artifact Service，不散落在 Main prompt。

---

# 35. Publish 与 Send

建议把：

```text
publishArtifact()
```

定义成：

> 将一个本地文件注册为受控 Artifact，并确认其允许作为外部输出候选。

而：

```text
sendArtifact()
```

属于 Chat Platform capability。

因此：

```text
publish
≠ send
```

---

# 36. Artifact 与 Main

Main 可以决定：

- 是否把 Artifact 告诉用户；
- 是否发送；
- 是否需要进一步转换；
- 如何解释内容。

Main 不能：

- 绕过 Artifact Service；
- 直接传任意 path 给 QQ；
- 扩大 Artifact destination scope。

---

# 37. Artifact 与 Worker

Worker 可以：

- 创建文件；
- 请求注册 Artifact；
- 返回 ArtifactRef。

Worker 默认不能：

- 任意发 QQ；
- 修改 Artifact ownership；
- 把其他 Task Artifact 当自己的输出；
- 访问 Gateway filesystem。

---

# 38. Artifact 与 Router

Router 主要负责 Gateway Artifact 和 Direct Command result。

Router 不读取 Agent Home `/state/artifacts`。

Agent user-facing file send 走 Agent Home → SnowLuma 的受控网络路径。

---

# 39. Artifact 与 Controller

Controller 不参与文件业务流。

Controller：

```text
不 proxy artifact bytes
不 mount artifact directory
不决定 file permission
```

除非未来明确引入独立管理/备份接口。

---

# 40. Artifact 与 Memory

Artifact 本身不是 Memory。

Memory 可以保存：

```text
artifact semantic reference
result summary
important provenance
```

但不把大文件内容复制进 Memory canonical store。

---

# 41. Integrity

可选 metadata：

```text
sha256
```

适用于：

- import/export；
- dedup；
- corruption detection；
- backup verification。

MVP 可实现，但不是每个临时 Artifact 的强制前置条件。

---

# 42. Filename Sanitization

发送给用户的 filename 需要：

- 去除危险路径部分；
- 不接受 `../`；
- 不把绝对路径暴露给用户；
- 保留合理扩展名。

例如：

```text
/state/projects/foo/output.zip
```

用户只看到：

```text
output.zip
```

---

# 43. Temporary URLs

如果 SnowLuma 当前 API 需要 URL：

- URL 必须短期有效；
- scope 到单 Artifact；
- 不暴露目录 listing；
- 不暴露 Agent Home filesystem；
- 过期后不可继续访问。

不要启动一个永久公开：

```text
/state/
```

的静态文件服务器。

---

# 44. Backups

Agent Home backup：

```text
/state
```

会包含 durable inbox/artifacts。

Gateway deployment backup：

```text
bot-gateway-state
plugin-data
gateway artifact persistent data（如果配置为 durable）
```

临时 Artifact 可以不进入 backup。

---

# 45. Authorization Failure

正常拒绝：

```text
source path outside allowed root
artifact belongs to another task
destination not allowed
size exceeds policy
sensitive path
```

返回结构化 denial。

不创建新的 Task status。

Main 可以解释给用户。

---

# 46. Runtime Exception

异常情况例如：

```text
filesystem metadata inconsistent
artifact record points to missing durable file
SnowLuma upload returns impossible state
```

记录：

```text
RuntimeException / ArtifactException
```

停止不安全操作并交给 Main/operator。

---

# 47. MVP Tests

至少覆盖：

## Path safety

- `../` escape 被拒绝；
- symlink target 越界被拒绝；
- sensitive credential path 被拒绝；
- authorized project output 可注册。

## Permission separation

- Worker 能读项目但没有 publish capability → publish denied；
- Artifact 合法但 Chat destination 不允许 → send denied；
- 另一个 Task 不能直接读取不属于自己的 Artifact。

## QQ inbound

- Chat file 正确 ingest；
- spoofed filename 不影响 canonical path；
- Runtime restart 后 durable input 仍可读取。

## QQ outbound

- SnowLuma 接收的是受控 Artifact transfer，不是任意 local path；
- send failure 不删除 Artifact。

## Plugin

- `/score` Gateway Artifact 可直接发送；
- Agent Home 不能直接读取 plugin-data；
- 显式 transfer 可以生成新的 Agent Artifact。

## Restart

- durable Artifact metadata 恢复；
- temporary Artifact 缺失不会被谎称存在。

---

# 48. 非目标

当前不设计：

- S3/object storage 必选依赖；
- CDN；
- content moderation pipeline；
- antivirus service framework；
- distributed blob store；
- dedup storage engine；
- complex versioned document system；
- arbitrary public file hosting。

---

# 49. 最终不变量

1. **Chat Platform file/image send 不接受任意 raw filesystem path。**
2. **Project file 不自动成为 Artifact。**
3. **File Read、Artifact Publish、Chat Send 是不同权限。**
4. **Artifact Service 是 Agent Home 文件外发的强制边界。**
5. **Artifact source 必须做 realpath + allowed-root validation。**
6. **symlink 不能绕过 source root。**
7. **敏感 credential 路径不能作为 Artifact 外发。**
8. **Artifact 绑定 Task/requester/context，不能无条件跨 Task 使用。**
9. **Agent Home 与 Bot Gateway 不共享 filesystem。**
10. **Gateway Plugin output 属于 Gateway Artifact domain。**
11. **跨 Agent Home / Gateway 必须显式 transfer/copy，而不是共享 path。**
12. **Controller 不代理普通 Artifact 数据。**
13. **Inbound Chat Platform attachment 只有按需 ingest 后才能成为 Task input。**
14. **大文件优先 stream，不默认整文件进内存。**
15. **正常权限拒绝返回结构化 denial，不扩张 Task 状态机。**
