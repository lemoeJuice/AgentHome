# 插件开发与运行规范

本文说明 Agent Home 当前插件机制、开发方式和授权边界。插件是 Gateway 进程内动态加载的模块，不是独立服务或进程。

## 1. 核对结论：当前实现

| 项目 | 当前代码行为 |
| --- | --- |
| 加载时机 | `GatewayApp.start()` 开始时调用 `loadPlugins()`，在 Gateway 对外开始接收消息之前动态 import 已启用模块。插件在 Gateway 进程内运行。 |
| 插件列表 | 由 `plugins.enabled` 提供模块路径；当前示例启用 `./dist/plugins/echo.js`。 |
| 路径解析 | `src/gateway/plugins.ts` 用进程当前工作目录解析相对路径，不是相对配置文件或插件目录解析。 |
| 注册方式 | 模块导出 `default` 或 `register` 函数，接收 `PluginContext`，注册 Direct Command 和可选 Agent Action；注册先收集到临时 registry，成功后再合并。 |
| Direct Command | Router 解析命令名并查找路由后，在 Gateway 进程内直接调用插件 handler，不经过 Main/Controller。handler 收到完整消息文本和调用上下文，由插件自行解析参数并返回 `CommandResult`。 |
| Gateway 权限 | Router 在调用插件前执行粗粒度 `permission` 检查：`admin` 匹配 `systemAdmins`；`user`、`public` 和 `command.*` 当前都允许。插件 handler 没有单独的权限配置载入机制。 |
| 插件隔离 | 每个插件的 import、注册、冲突及状态目录初始化独立捕获；失败会记录并跳过，后续插件继续加载。失败插件不会留下部分注册。 |
| 命令生命周期 | 命令没有 Gateway 强制 handler 超时。Gateway 跟踪每个插件的活动命令；停机时发出 AbortSignal、等待命令结束，再执行插件清理钩子。 |
| 状态 | 每个插件获得 `FilePluginState`，根目录是 `paths.pluginData/<插件文件名>`；只提供安全文件名的 JSON 读写接口。 |
| MCP Actions | `plugins.allowedActions` / `allowedPermissions` 用于 Agent Action 的 MCP 暴露/授权路径，不是 Direct Command 插件权限配置。 |
| 插件目录 | 当前 `.gitignore` 忽略 `dist/`，但没有忽略根目录 `plugins/`。本次添加 `/plugins/` 忽略规则，作为本地/部署插件代码目录；`src/plugins/` 仍是仓库内置示例/源码，不受影响。 |

以上结论以 `src/gateway/{app,plugins,registry,router,state}.ts`、`src/config.ts`、`config.example.json` 为准。

## 2. 插件位置与启用

- 仓库内置、随项目构建的插件源码放在 `src/plugins/`；这是受版本控制的应用源码。
- 本地开发或部署时单独放置的插件代码放在仓库根目录 `plugins/`。该目录已加入 `.gitignore`，不得把私有插件、构建产物或本地凭据提交到仓库。
- 插件运行数据放在 `paths.pluginData/<pluginId>/`，与插件代码分开；不得把可变状态写回插件代码目录。
- 通过 `config.json` 中的 `plugins.enabled` 显式启用模块。路径当前相对进程工作目录解析；部署应保证启动工作目录稳定，或配置绝对路径。
- 插件模块必须是 Node 可动态 import 的 JavaScript 模块。项目当前 `tsconfig` 只构建 `src/**/*.ts` 到 `dist/`；根目录 `plugins/` 下的插件不会自动编译。外部/本地插件需自行生成可运行的 JS，并确保依赖在 Gateway 运行环境中可用。

示例：

```json
{
  "paths": {
    "pluginData": ".agent-home/runtime-state/plugin-data"
  },
  "plugins": {
    "enabled": ["./plugins/weather/index.js"],
    "allowedActions": [],
    "allowedPermissions": []
  }
}
```

路径示例假设 Gateway 从项目根目录启动。若使用其他工作目录，应调整为对应路径或使用绝对路径。

## 3. 插件模块与注册 API

插件必须导出 `default` 或命名导出 `register`。注册函数可以同步或异步执行。`context.pluginId` 当前来自模块文件名，需确保文件名稳定且不会与其他插件产生状态目录冲突。模块和 handler 都在 Gateway 进程内执行，不会启动独立服务或进程。

```ts
import type { PluginContext } from "../gateway/registry.js";

export default function register(context: PluginContext): void {
  const listener = startPluginListener({ signal: context.signal });
  context.onDispose(() => listener.close());

  context.registerCommand(
    {
      name: "weather",
      aliases: ["wx"],
      permission: "public",
      kind: "PLUGIN",
    },
    async (command) => {
      // Gateway 用命令名选择 handler；参数由插件从原始消息中解析。
      const location = command.message.text.trim()
        .replace(/^@\S+\s+(?=\/)/, "")
        .replace(/^\/\S+\s*/, "")
        .trim();
      if (!location) {
        return { text: "用法：/weather <地点>" };
      }

      return {
        text: `查询地点：${location}`,
        context: { type: "weather", summary: `天气查询：${location}` },
      };
    },
  );
}
```

API 要点：

- 命令名和 alias 全局唯一；冲突会使发生冲突的插件加载失败，但不会阻断其他插件或 Gateway 启动。
- 插件命令不能覆盖 Gateway 的 Core 命令（如 `status`、`help`、`bind`）。命名冲突通过避免使用 Core 名称和其他插件已占用名称来规避。
- handler 返回 `CommandResult`，由 Gateway 负责回复和持久化调用结果。插件不要自行选择任意聊天目标或绕过 Gateway 直接发送消息。
- 文件产物必须通过受支持的 Gateway Artifact 结果接口登记；不可将未经校验的本地路径直接交给平台发送。
- Agent Action 是可选能力，应仅在有明确 Agent 调用需求时注册；Direct Command 和 Agent Action 是不同入口，可以复用插件内部业务函数，但授权策略应分别考虑。

## 4. 参数、错误与运行时边界

- 将聊天参数视为不可信输入：检查缺失、长度、格式及资源范围；对外错误信息给出简明用法，不泄漏密钥、内部路径或堆栈。
- handler 应使用异步 I/O，避免同步阻塞 Gateway 事件循环；CPU 密集工作应交由合适的异步/worker 能力处理。Gateway 不再对 Direct Command handler 设置显式超时。
- 插件生命周期提供 `PluginContext.signal`（插件级）和 `CommandContext.signal`（单次命令级），以及 `PluginContext.onDispose(cleanup)`。插件应将 signal 传给可取消的 I/O/资源，并用清理钩子释放在注册阶段创建的监听器、定时器、连接等资源。
- Gateway 停机时停止接收新事件，取消插件生命周期及活动命令，并等待活动命令结束后按逆序执行清理钩子。插件必须响应 AbortSignal 并确保 finally/cleanup 路径能完成；忽略取消或永不结束的 handler 会阻塞有序停机。不要以 detached timer/process 或未跟踪的后台 Promise 留下资源。
- Direct Command 执行结果由 Gateway 记录 invocation 和审计事件；handler 异常会产生失败日志及通用用户提示。插件应避免重复记录敏感用户数据。
- 插件与 Gateway 同进程执行，拥有 Gateway 进程可访问的权限；动态 import 不是沙箱。只启用可信代码，避免插件执行无约束 shell、读取无关密钥或修改 Gateway 状态。
- 不要依赖未公开的 Gateway 内部对象或直接操作 Gateway SQLite；插件状态使用 `context.state`。当前状态接口仅支持插件状态根目录内的 JSON 文件。

## 5. 插件加载失败隔离

加载语义是：**插件加载错误在加载阶段被报告，单个插件失败不会阻断 Gateway 或其他插件。** 实现包括：

1. 对每个启用项独立执行路径检查、动态 import、注册和初始化。
2. 某插件出错时记录结构化错误（至少包括 pluginId/path、失败阶段和错误摘要），将其标记为 failed/disabled，继续尝试后续插件。
3. 只在插件成功完成注册后记录 loaded；启动健康状态/日志应能区分成功和失败插件，便于运维发现错误。
4. 使用临时 registry 收集注册结果；命令/别名和 Action 都通过冲突检查后再合并，失败插件不会留下半注册的命令/Action。
5. 插件名、命令、alias、Action 冲突应归属并报告到导致冲突的插件，不允许静默覆盖已注册功能。
6. 只有 Gateway 自身关键依赖失败才阻断启动；普通可选插件加载失败不阻断 Gateway adapter、Core commands 或其他成功插件运行。

失败插件不会出现在 `/help` 中。`doctor` 将插件状态标记为 degraded，并列出失败插件；运维仍应查看加载错误日志并修复插件。

## 6. 插件授权及调用方信息

插件可以根据自己的业务规则授权 Direct Command。当前 `CommandContext` 提供调用方身份和完整消息文本，但 Gateway 的粗权限检查仍先于 handler；目前没有插件专用权限策略配置。后续配置和授权 API 应遵循：

- 每个插件在自己的配置中声明权限策略（例如插件专属配置文件/配置项），不要把业务授权规则混入全局 `plugins.allowedPermissions`。配置应有明确默认拒绝、格式校验和安全的密钥存储方式。
- Gateway 将经过平台适配和身份绑定的调用方元信息传给 handler；最少包含平台、accountId、userId、principalId（若已绑定）、会话类型/ID和当前命令调用 ID。元信息由 Gateway 构造，插件不得从命令文本自行声明身份。
- 插件 handler 或插件自己的授权 helper 根据上述可信身份和插件配置作授权判定。拒绝时不执行副作用，返回适当提示，并记录不含敏感信息的拒绝原因。
- 需要 Gateway 层通用保护的系统管理命令仍由 Gateway 在调用插件前强制执行，不应允许插件配置绕过系统管理员边界。插件级授权是附加细化，不是提升权限或绕过 Gateway 安全策略。
- Agent Action 的调用方 (`MAIN`/`WORKER`)、任务和能力边界属于另一条 MCP 授权路径；不能把 Direct Command 的用户配置直接当成 Agent Action 授权，也不能仅凭 Agent 提供的字段信任其身份。

**当前上下文：**`CommandContext.requester` 有 `platform/accountId/userId/principalId?`，conversation 有 `conversationId/kind/platformConversationId/threadId`，message 有 `messageId/replyTo/text`。调用方元信息已经传给 handler；尚缺少的是插件自己的配置/授权加载约定和稳定的明确授权 API。当前 handler 收到调用前，Router 已执行粗粒度 permission 判定。

## 7. 测试与发布检查清单

新增或更新插件时至少检查：

- [ ] 模块能在目标 Gateway Node 环境中动态 import。
- [ ] 注册函数存在并完成初始化；命令、alias、Action 名称无冲突。
- [ ] 参数校验、空参数和异常路径均有测试。
- [ ] 鉴权覆盖允许、拒绝、未绑定身份和跨平台/account 的情况；身份来自 Gateway context，不来自用户输入。
- [ ] 插件拒绝时无业务副作用；日志不暴露敏感配置。
- [ ] 插件状态使用独立 pluginId 目录，路径不能逃出状态根目录。
- [ ] Handler 使用非阻塞 I/O；生命周期 signal 能取消活动工作，`onDispose` 会清理注册期资源。
- [ ] 失败插件隔离测试：失败插件不会阻断后续插件、Core 命令或 Gateway 启动，也不遗留部分注册。
- [ ] 本地插件位于被忽略的根 `plugins/` 目录；配置路径与 Gateway 启动工作目录一致。
- [ ] 构建及测试通过，并确认 `plugins/` 下的私有代码/密钥没有进入提交。

## 8. 责任边界摘要

```text
Gateway: 加载模块、维护 registry、构造可信 requester context、应用系统级保护、记录 invocation/audit、发送结果
Plugin: 参数校验、业务逻辑、读取自身配置、按插件业务策略授权、管理自身 plugin state
MCP authorization: 控制 Agent Action 对 Main/Worker 的暴露和调用权限，与 Direct Command 授权分开
```

插件加载成功不意味着命令天然安全；插件自定义授权也不能代替 Gateway 的系统级安全检查。
