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
] as const;

export default function registerWorkerTools(pi: PiExtensionApi): void {
  for (const definition of tools) {
    pi.registerTool({
      name: definition.name,
      label: definition.name,
      description: definition.description,
      parameters: definition.parameters,
      execute: async (_toolCallId, input, signal) => {
        try {
          const result = await callGateway(definition.method, input, signal);
          return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
        } catch (error) {
          return { content: [{ type: "text", text: String(error instanceof Error ? error.message : error) }], details: {}, isError: true };
        }
      },
    });
  }
}

async function callGateway(method: string, params: Record<string, JsonValue>, signal: AbortSignal): Promise<JsonValue> {
  const endpoint = process.env.AGENT_HOME_MCP_URL;
  const token = process.env.AGENT_HOME_MCP_TOKEN;
  if (!endpoint || !token) throw new Error("MCP_WORKER_CONTEXT_MISSING");
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
    signal,
  });
  const body = await response.json() as { result?: JsonValue; error?: { message?: string } };
  if (!response.ok || body.error) throw new Error(`MCP_REQUEST_FAILED:${body.error?.message ?? response.status}`);
  return body.result ?? null;
}
