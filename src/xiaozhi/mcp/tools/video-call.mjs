// The device has one contact: whoever is on the call page. Any request to
// call someone, whatever name the user says, calls that remote user.
export function registerVideoCallTools(server, callController) {
  if (!callController) return;

  server.registerTool({
    name: "call.start",
    description: "Start a video call. The device has exactly one contact, the remote user on the call page, so call this for any request to call, video call, ring or phone someone, whatever name the user says. The conversation closes while the call rings; if the result says the call can't be placed, tell the user why.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "The name the user said, if any (only used in your reply)"
        }
      }
    },
    handler: () => {
      const result = callController.placeCall();
      if (result.ok) {
        return { success: true, message: "Calling the remote user now. The conversation is closing while the call rings." };
      }
      const why = {
        not_connected: "The video call service is not connected.",
        offline: "The remote user is not online right now.",
        busy: "The remote user is busy in another call."
      }[result.reason] || "The call could not be placed.";
      // Explicit guidance: the MCP server's generic failure hints say "retry",
      // which made the model repeat the tool name instead of answering
      return {
        success: false,
        error: result.reason,
        message: why,
        suggested_action: "Do not call the tool again. Tell the user, in one short sentence, that the call can't be made and why.",
        fallback: "None needed",
        retry_after: null
      };
    }
  });
}
