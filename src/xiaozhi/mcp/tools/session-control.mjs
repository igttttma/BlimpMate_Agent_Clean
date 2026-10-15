export function registerSessionControlTools(server, { endSession } = {}) {
  if (typeof endSession !== "function") return;

  server.registerTool({
    name: "session.end",
    description: "End the current conversation and return the device to offline wake-word mode. Call this when the user says goodbye, bye, see you, asks to stop talking, or otherwise clearly ends the conversation.",
    inputSchema: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Short reason for ending the conversation, such as user_said_goodbye"
        }
      }
    },
    handler: ({ reason = "assistant_requested" } = {}) => {
      // Let McpServer send the tool result before the conversation socket closes.
      setTimeout(() => {
        Promise.resolve(endSession({ reason })).catch(() => {});
      }, 250);
      return {
        success: true,
        action: "session.end",
        message: "Conversation is ending; the device will return to wake-word mode.",
        reason
      };
    }
  });
}
