import { createConnection } from "node:net";

type JsonValue = string | number | boolean | null | { [key: string]: JsonValue } | JsonValue[];

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
};

type PiExtensionApi = {
  registerTool(definition: {
    name: string;
    label: string;
    description: string;
    parameters: Record<string, unknown>;
    execute: (toolCallId: string, input: Record<string, JsonValue>, signal: AbortSignal) => Promise<ToolResult>;
  }): void;
};

const artifactSchema = { type: "object", properties: { authority: { type: "string", enum: ["agent-home"] }, artifactId: { type: "string" } }, required: ["authority", "artifactId"], additionalProperties: false };
const messageRefSchema = { type: "object", properties: { platform: { type: "string" }, accountId: { type: "string" }, platformConversationId: { type: "string" }, threadId: { anyOf: [{ type: "string" }, { type: "null" }, { type: "object" }] }, messageId: { type: "string" } }, required: ["platform", "accountId", "platformConversationId", "threadId", "messageId"], additionalProperties: false };
const TOOL_DEFINITIONS: Array<{ name: string; description: string; action: string; parameters: Record<string, unknown> }> = [
  { name: "get_current_message", description: "Always read the current trigger message before answering a user-triggered message through the authorized SnowLuma-backed capability; the result includes attachment references for get_attachment.", action: "get_current_message", parameters: { type: "object", properties: {}, additionalProperties: false } },
  { name: "get_message", description: "Read one message from the current authorized conversation.", action: "get_message", parameters: { type: "object", properties: { ref: messageRefSchema }, required: ["ref"], additionalProperties: false } },
  { name: "get_reply_context", description: "Read the message currently being replied to, if any.", action: "get_reply_context", parameters: { type: "object", properties: {}, additionalProperties: false } },
  { name: "get_history", description: "Read recent messages from the current authorized conversation.", action: "get_history", parameters: { type: "object", properties: { limit: { type: "number" }, beforeMessageId: { type: "string" } }, additionalProperties: false } },
  { name: "get_attachment", description: "Fetch one attachment from the current authorized message only when its content is needed. Call get_current_message first if the attachment reference is not already in context; Runtime binds the read to the current trigger message. Returns an Agent Home artifact reference.", action: "get_attachment", parameters: { type: "object", properties: { attachment: { type: "object", properties: { type: { type: "string", enum: ["image", "file", "video", "audio", "unknown"] }, id: { type: "string" }, url: { type: "string" }, filename: { type: "string" }, mime: { type: "string" }, size: { type: "number" } }, required: ["type"], additionalProperties: false }, messageRef: messageRefSchema }, required: ["attachment"], additionalProperties: false } },
  { name: "list_tasks", description: "List tasks visible in the current conversation.", action: "list_tasks", parameters: { type: "object", properties: {}, additionalProperties: false } },
  { name: "get_task", description: "Read one task visible in the current conversation.", action: "get_task", parameters: { type: "object", properties: { taskId: { type: "string" } }, required: ["taskId"], additionalProperties: false } },
  { name: "create_task", description: "Create a durable task using only the current conversation capability.", action: "create_task", parameters: { type: "object", properties: { title: { type: "string" }, goal: { type: "string" }, parentTaskId: { type: "string" }, requestedCapabilities: { type: "object" } }, required: ["title", "goal"], additionalProperties: false } },
  { name: "spawn_worker", description: "Start a Worker under an existing visible task capability.", action: "spawn_worker", parameters: { type: "object", properties: { taskId: { type: "string" }, objective: { type: "string" }, workspaceId: { type: "string" }, workspaceAccess: { type: "string", enum: ["READ", "WRITE"] }, artifactRefs: { type: "array", items: artifactSchema }, requestedCapabilities: { type: "object" } }, required: ["taskId", "objective"], additionalProperties: false } },
  { name: "cancel_task", description: "Cancel a visible task when the current capability allows it.", action: "cancel_task", parameters: { type: "object", properties: { taskId: { type: "string" } }, required: ["taskId"], additionalProperties: false } },
  { name: "follow_up_task", description: "Add a follow-up to a visible task in the current conversation.", action: "follow_up_task", parameters: { type: "object", properties: { taskId: { type: "string" }, content: { type: "string" } }, required: ["taskId", "content"], additionalProperties: false } },
  { name: "finish_task", description: "Commit an authorized final Task outcome after all Workers are terminal.", action: "finish_task", parameters: { type: "object", properties: { taskId: { type: "string" }, outcome: { type: "string", enum: ["COMPLETED", "PARTIAL", "FAILED"] }, summary: { type: "string" }, artifacts: { type: "array", items: { type: "string" } } }, required: ["taskId", "outcome", "summary"], additionalProperties: false } },
  { name: "retrieve_memory", description: "Retrieve memory through the authorized Memory service.", action: "retrieve_memory", parameters: { type: "object", properties: { text: { type: "string" }, limit: { type: "number" } }, required: ["text"], additionalProperties: false } },
  { name: "remember", description: "Store explicit memory through the authorized Memory service.", action: "remember", parameters: { type: "object", properties: { scope: { type: "string" }, content: { type: "string" }, provenance: { type: "array", items: { type: "string" } } }, required: ["scope", "content"], additionalProperties: false } },
  { name: "send_message", description: "Send text only to the current authorized conversation.", action: "send_message", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false } },
  { name: "list_snowluma_actions", description: "Discover OneBot actions exposed by SnowLuma MCP, optionally filtered by category.", action: "list_snowluma_actions", parameters: { type: "object", properties: { category: { type: "string" } }, additionalProperties: false } },
  { name: "search_snowluma_actions", description: "Search SnowLuma OneBot actions by keyword before calling them.", action: "search_snowluma_actions", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } },
  { name: "get_snowluma_action", description: "Read the full SnowLuma OneBot action documentation and argument schema before invocation.", action: "get_snowluma_action", parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false } },
  { name: "query_snowluma_action", description: "Call a read-only SnowLuma OneBot action. This operation is restricted to the configured Owner.", action: "query_snowluma_action", parameters: { type: "object", properties: { action: { type: "string" }, params: { type: "object" } }, required: ["action"], additionalProperties: false } },
  { name: "invoke_snowluma_action", description: "Invoke a SnowLuma OneBot action that may have side effects, such as sending a private message or friend request. Discover and read its schema first. This operation is restricted to the configured Owner.", action: "invoke_snowluma_action", parameters: { type: "object", properties: { action: { type: "string" }, params: { type: "object" } }, required: ["action"], additionalProperties: false } },
  { name: "inspect_artifact", description: "Inspect an authorized Artifact without exposing its filesystem path.", action: "inspect_artifact", parameters: { type: "object", properties: { ref: artifactSchema }, required: ["ref"], additionalProperties: false } },
  { name: "read_artifact", description: "Read bounded text from an authorized Artifact without exposing its filesystem path.", action: "read_artifact", parameters: { type: "object", properties: { ref: artifactSchema, maxBytes: { type: "number" } }, required: ["ref"], additionalProperties: false } },
  { name: "send_artifact", description: "Send an authorized Artifact to the current conversation.", action: "send_artifact", parameters: { type: "object", properties: { ref: artifactSchema, filename: { type: "string" } }, required: ["ref"], additionalProperties: false } },
  { name: "list_actions", description: "List Gateway plugin actions allowed by the server.", action: "list_actions", parameters: { type: "object", properties: {}, additionalProperties: false } },
  { name: "search_actions", description: "Search Gateway plugin actions allowed by the server.", action: "search_actions", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } },
  { name: "invoke_action", description: "Invoke one Gateway plugin action after server-side authorization.", action: "invoke_action", parameters: { type: "object", properties: { name: { type: "string" }, input: { type: "object" } }, required: ["name"], additionalProperties: false } },
];

export default function registerAgentHomeTools(pi: PiExtensionApi): void {
  for (const definition of TOOL_DEFINITIONS) {
    pi.registerTool({
      name: definition.name,
      label: definition.name,
      description: definition.description,
      parameters: definition.parameters,
      execute: async (_toolCallId, input, signal) => {
        try {
          const result = await callRuntime(definition.action, input, signal);
          return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
        } catch (error) {
          return { content: [{ type: "text", text: String(error instanceof Error ? error.message : error) }], details: {}, isError: true };
        }
      },
    });
  }
}

async function callRuntime(action: string, input: Record<string, JsonValue>, signal: AbortSignal): Promise<JsonValue> {
  const socketPath = process.env.AGENT_HOME_RUNTIME_TOOL_SOCKET;
  const token = process.env.AGENT_HOME_RUNTIME_TOOL_TOKEN;
  if (!socketPath || !token) throw new Error("RUNTIME_TOOL_CONTEXT_MISSING");
  const response = await new Promise<{ ok: boolean; result?: JsonValue; error?: string }>((resolve, reject) => {
    const connection = createConnection(socketPath);
    let buffer = "";
    const abort = () => { connection.destroy(new Error("TOOL_ABORTED")); };
    signal.addEventListener("abort", abort, { once: true });
    connection.setEncoding("utf8");
    connection.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      signal.removeEventListener("abort", abort);
      try { resolve(JSON.parse(buffer.slice(0, newline)) as { ok: boolean; result?: JsonValue; error?: string }); }
      catch (error) { reject(error); }
      connection.destroy();
    });
    connection.on("error", (error) => { signal.removeEventListener("abort", abort); reject(error); });
    connection.on("connect", () => connection.write(`${JSON.stringify({ token, action, input })}\n`));
  });
  if (!response.ok) throw new Error(response.error ?? "RUNTIME_TOOL_FAILED");
  return response.result ?? null;
}
