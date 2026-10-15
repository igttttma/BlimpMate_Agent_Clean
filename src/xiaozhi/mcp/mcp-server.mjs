// Device-side MCP server. Wire-level: server delivers JSON-RPC via
// {type:"mcp", payload:{...}}; we reply by sending mcp messages back.
export class McpServer {
  constructor() {
    this._tools = new Map();
    this._sendMcp = null;
    this._log = null;
    this._serverInfo = { name: "l2d-face-control-device", version: "0.1.0" };
  }

  setSender(fn) { this._sendMcp = fn; }
  setLogger(fn) { this._log = typeof fn === "function" ? fn : null; }

  _emitLog(level, message, detail) {
    if (typeof this._log === "function") {
      this._log(level, message, detail);
    }
  }

  _safeStringify(value) {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  registerTool({ name, description, inputSchema, handler }) {
    this._tools.set(name, { name, description, inputSchema: inputSchema || { type: "object", properties: {} }, handler });
  }

  async callTool(name, args = {}) {
    const tool = this._tools.get(name);
    if (!tool) throw new Error(`Tool not found: ${name}`);
    return normalizeToolResult(name, await tool.handler(args || {}));
  }

  async handleIncoming(payload) {
    if (!payload || payload.jsonrpc !== "2.0") return;
    const id = payload.id;
    const method = payload.method;
    const params = payload.params || {};

    const methodPrefix = typeof id === "undefined" || id === null ? "notification" : "request";
    this._emitLog("info", `mcp ${methodPrefix}: ${method}`, {
      id,
      tool: params?.name,
      params: this._safeStringify(params)
    });

    try {
      if (method === "initialize") {
        this._reply(id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: this._serverInfo
        });
      } else if (method === "tools/list") {
        this._reply(id, {
          tools: [...this._tools.values()].map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema
          }))
        });
      } else if (method === "tools/call") {
        const tool = this._tools.get(params.name);
        if (!tool) {
          const hint = `Available tools: ${Array.from(this._tools.keys()).sort().join(", ")}`;
          this._emitLog("warn", `mcp tool not found: ${params.name}`, {
            id,
            method,
            hint
          });
          this._error(id, -32601, `Tool not found: ${params.name}`, {
            action: "tools/call",
            requested: params?.name,
            suggested_action: "Check the tool name or refresh the tool list",
            hint
          });
          return;
        }
        let result;
        try {
          const args = params.arguments || {};
          result = await tool.handler(params.arguments || {});
          const normalizedResult = normalizeToolResult(tool.name, result);
          const isSuccess = normalizedResult?.success !== false;
          const summary = typeof normalizedResult?.note === "string"
            ? normalizedResult.note
            : typeof normalizedResult?.message === "string"
              ? normalizedResult.message
              : "";
          const logLevel = isSuccess ? "info" : "warn";
          this._emitLog(logLevel, `mcp tool ${isSuccess ? "success" : "rejected"}: ${params.name}`, {
            id,
            tool: params.name,
            action: tool.name,
            success: isSuccess,
            summary,
            args: this._safeStringify(args)
          });
          const content = Array.isArray(normalizedResult.content)
            ? normalizedResult.content
            : [{ type: "text", text: JSON.stringify(normalizedResult) }];
          this._reply(id, { content, isError: false });
        } catch (err) {
          const normalized = normalizeToolError(err);
          this._emitLog("error", `mcp tool failed: ${params.name}`, {
            id,
            tool: params.name,
            code: normalized.code,
            message: normalized.message
          });
          this._error(id, normalized.code, normalized.message, normalized.errorData);
          return;
        }
      } else if (method === "notifications/initialized") {
        // no-op
      } else {
        this._error(id, -32601, `Method not found: ${method}`);
      }
    } catch (err) {
      this._emitLog("error", `mcp dispatch error: ${method}`, {
        id,
        message: err && err.message ? err.message : String(err)
      });
      this._error(id, -32603, err && err.message ? err.message : "Internal error");
    }
  }

  _reply(id, result) {
    if (id === undefined || id === null || !this._sendMcp) return;
    this._sendMcp({ jsonrpc: "2.0", id, result });
  }
  _error(id, code, message, data = null) {
    if (id === undefined || id === null || !this._sendMcp) return;
    if (data) {
      this._sendMcp({ jsonrpc: "2.0", id, error: { code, message, data } });
    } else {
      this._sendMcp({ jsonrpc: "2.0", id, error: { code, message } });
    }
  }
}

function normalizeToolError(err) {
  if (err && typeof err === "object") {
    const code = Number.isFinite(err.code) ? Number(err.code) : -32000;
    const message = typeof err.message === "string" && err.message.trim()
      ? err.message
      : "Tool execution failed";
    const recommended = inferSuggestedAction(message, code, err);
    const retryAfter = inferRetryAfter(message, code, err);
    const fallback = inferFallback(message, code, err);
    return {
      code,
      message,
      errorData: {
        code,
        action: err.tool || "unknown",
        details: sanitizeErrorData(err),
        suggested_action: recommended,
        retry_after: retryAfter,
        fallback
      }
    };
  }
  const message = String(err) || "Tool execution failed";
  return {
    code: -32000,
    message,
    errorData: {
      code: -32000,
      action: "unknown",
      details: null,
      suggested_action: inferSuggestedAction(message, -32000, null),
      retry_after: inferRetryAfter(message, -32000, null),
      fallback: inferFallback(message, -32000, null)
    }
  };
}

function sanitizeErrorData(err) {
  if (!err || typeof err !== "object") return null;
  return {
    name: typeof err.name === "string" ? err.name : null,
    message: typeof err.message === "string" ? err.message : null,
    stack: typeof err.stack === "string" ? err.stack : null
  };
}

function inferSuggestedAction(message, code, err) {
  const raw = String(message || "").toLowerCase();
  if (raw.includes("connect") || raw.includes("offline") || raw.includes("network") || code === -32000) {
    return "Reconnect the session, then retry";
  }
  if (raw.includes("permission") || raw.includes("forbidden") || raw.includes("not authorized")) {
    return "Check permissions, then retry";
  }
  if (raw.includes("not found") || raw.includes("does not exist")) {
    return "Confirm the target and arguments are valid, then retry";
  }
  if (raw.includes("index") || raw.includes("parameter") || raw.includes("argument")) {
    return "Check argument types and ranges";
  }
  if (err && (err.name === "ValidationError" || String(err.status).startsWith("4"))) {
    return "Adjust the arguments to match the tool docs, then retry";
  }
  return "Fix the arguments from the error, or try again later";
}

function inferRetryAfter(message, code, err) {
  const raw = String(message || "").toLowerCase();
  if (raw.includes("timeout") || raw.includes("rate limit")) return 3;
  if (raw.includes("not connected") || raw.includes("disconnected") || raw.includes("offline")) return 2;
  if (code === -32000 && err && String(err).includes("fetch")) return 5;
  return null;
}

function inferFallback(message, code, err) {
  if (String(message || "").includes("not connected") || String(message || "").includes("offline")) {
    return "Run system.get_status and check the session and host connection";
  }
  if (String(message || "").includes("permission") || String(message || "").includes("forbidden") || String(message || "").includes("unauthorized")) {
    return "Confirm device authorization and the current host service status";
  }
  if (String(message || "").includes("not found") || String(message || "").includes("does not exist")) {
    return "Check that the required native service is installed";
  }
  if (code === -32000) {
    return "Try a prompt-style instruction and call the tool again";
  }
  return null;
}

function normalizeToolResult(toolName, result) {
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const normalized = { ...result };
    if (typeof normalized.success === "undefined") normalized.success = true;
    if (!normalized.action) normalized.action = toolName;
    if (normalized.success === false) {
      normalized.fallback = normalized.fallback || inferFallback(normalized.message || "", -32000, { message: normalized.message });
      normalized.suggested_action = normalized.suggested_action || inferSuggestedAction(normalized.message || "", -32000, { message: normalized.message });
      normalized.retry_after = Number.isFinite(normalized.retry_after) ? normalized.retry_after : inferRetryAfter(normalized.message || "", -32000, normalized);
    }
    return normalized;
  }
  if (typeof result === "string") {
    return {
      success: true,
      action: toolName,
      message: result
    };
  }
  if (Array.isArray(result)) {
    return {
      success: true,
      action: toolName,
      payload: result
    };
  }
  if (typeof result === "boolean") {
    return {
      success: Boolean(result),
      action: toolName
    };
  }
  return {
    success: true,
    action: toolName,
    result: result === undefined ? null : result
  };
}
