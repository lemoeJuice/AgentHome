type JsonValue = string | number | boolean | null | { [key: string]: JsonValue } | JsonValue[];

type PiExtensionApi = {
  registerTool(definition: {
    name: string;
    label: string;
    description: string;
    parameters: Record<string, unknown>;
    execute: (toolCallId: string, input: Record<string, JsonValue>, signal: AbortSignal) => Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown>; isError?: boolean }>;
  }): void;
};

const tools = [
  { name: "list_gateway_actions", description: "List Gateway Agent Actions allowed for this Worker.", method: "list_actions", parameters: { type: "object", properties: {}, additionalProperties: false } },
  { name: "search_gateway_actions", description: "Search Gateway Agent Actions allowed for this Worker.", method: "search_actions", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } },
  { name: "invoke_gateway_action", description: "Invoke one Gateway Agent Action allowed for this Worker.", method: "invoke_action", parameters: { type: "object", properties: { name: { type: "string" }, input: { type: "object" } }, required: ["name"], additionalProperties: false } },
  { name: "report_progress", description: "Report verified progress on this Task to Main. Call this after processing a user follow-up or when there is a meaningful update.", method: "report_progress", parameters: { type: "object", properties: { summary: { type: "string" }, phase: { type: "string" } }, required: ["summary"], additionalProperties: false } },
  { name: "worker_exec", description: "Run a shell command as this Worker's authenticated Principal in its own workspace. Owner and Guest commands use the same Runtime ExecutionBackend; Linux UID/GID, workspace capability, cancellation, limits, and applicable network policy are enforced by Runtime.", method: "worker_exec", parameters: { type: "object", properties: { command: { type: "string" }, cwd: { type: "string" }, timeoutMs: { type: "number" } }, required: ["command"], additionalProperties: false } },
  { name: "workspace_read", description: "Read a UTF-8 file through the Principal ExecutionBackend.", method: "workspace_read", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } },
  { name: "workspace_write", description: "Write a UTF-8 file in the Principal workspace through the Principal ExecutionBackend.", method: "workspace_write", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false } },
  { name: "workspace_edit", description: "Replace one unique text occurrence in a Principal workspace file through the Principal ExecutionBackend.", method: "workspace_edit", parameters: { type: "object", properties: { path: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" } }, required: ["path", "oldText", "newText"], additionalProperties: false } },
  { name: "workspace_mkdir", description: "Create a directory in the Principal workspace through the Principal ExecutionBackend.", method: "workspace_mkdir", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } },
  { name: "workspace_remove", description: "Remove a file or directory in the Principal workspace through the Principal ExecutionBackend.", method: "workspace_remove", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } },
  { name: "workspace_list", description: "List a directory in the Principal workspace through the Principal ExecutionBackend.", method: "workspace_list", parameters: { type: "object", properties: { path: { type: "string" } }, additionalProperties: false } },
  { name: "workspace_stat", description: "Inspect a path in the Principal workspace through the Principal ExecutionBackend.", method: "workspace_stat", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } },
] as const;

export default function registerWorkerTools(pi: PiExtensionApi): void {
  for (const definition of tools) {
    if (definition.method.startsWith("worker_") || definition.method.startsWith("workspace_")) {
      if (!process.env.AGENT_HOME_RUNTIME_TOOL_SOCKET || !process.env.AGENT_HOME_RUNTIME_TOOL_TOKEN) continue;
    }
    pi.registerTool({
      name: definition.name,
      label: definition.name,
      description: definition.description,
      parameters: definition.parameters,
      execute: async (_toolCallId, input, signal) => {
        try {
          const result = await callRuntimeTool(definition.method, input, signal);
          return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
        } catch (error) {
          return { content: [{ type: "text", text: String(error instanceof Error ? error.message : error) }], details: {}, isError: true };
        }
      },
    });
  }
}

async function callRuntimeTool(action: string, input: Record<string, JsonValue>, signal: AbortSignal): Promise<JsonValue> {
  const socketPath = process.env.AGENT_HOME_RUNTIME_TOOL_SOCKET;
  const token = process.env.AGENT_HOME_RUNTIME_TOOL_TOKEN;
  if (!socketPath || !token) throw new Error("RUNTIME_TOOL_CONTEXT_MISSING");
  const { createConnection } = await import("node:net");
  const response = await new Promise<{ ok: boolean; result?: JsonValue; error?: string }>((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    const abort = () => socket.destroy(new Error("TOOL_ABORTED"));
    const cleanup = () => signal.removeEventListener("abort", abort);
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      cleanup();
      try { resolve(JSON.parse(buffer.slice(0, newline)) as { ok: boolean; result?: JsonValue; error?: string }); }
      catch (error) { reject(error); }
      socket.destroy();
    });
    socket.on("error", (error) => { cleanup(); reject(error); });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { abort(); return; }
    socket.on("connect", () => socket.write(`${JSON.stringify({ token, action, input })}\n`));
  });
  if (!response.ok) throw new Error(response.error ?? "RUNTIME_TOOL_FAILED");
  return response.result ?? null;
}
