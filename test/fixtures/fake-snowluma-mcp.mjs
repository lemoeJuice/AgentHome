process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.trim()) handle(JSON.parse(line));
    newline = buffer.indexOf("\n");
  }
});

function handle(request) {
  if (request.method === "initialize") {
    respond(request.id, { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fake-snowluma", version: "1" } });
    return;
  }
  if (request.method === "tools/call") {
    const args = request.params?.arguments ?? {};
    const name = request.params?.name;
    const data = name === "query_action"
      ? { status: "ok", retcode: 0, data: { action: args.action, params: args.params } }
      : { status: "ok", retcode: 0, data: { message_id: 42 } };
    respond(request.id, { content: [{ type: "text", text: JSON.stringify(data) }] });
  }
}

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}
