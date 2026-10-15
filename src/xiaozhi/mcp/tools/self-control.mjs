import { ExpressionType } from "../../../core/expression-data.mjs";
import { listKnownEmotions } from "../../emotion/emotion-map.mjs";

export function registerSelfControlTools(server, bridge) {
  const expressionNames = Object.values(ExpressionType);

  server.registerTool({
    name: "self.list_expressions",
    description: "List all available Live2D expression names that the avatar can switch to.",
    inputSchema: { type: "object", properties: {} },
    handler: () => ({ expressions: expressionNames })
  });

  server.registerTool({
    name: "self.set_expression",
    description: "Set the avatar's facial expression. Use to express emotion alongside speech.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", enum: expressionNames, description: "Expression name" },
        immediate: { type: "boolean", description: "If true, skip the smooth transition" }
      },
      required: ["name"]
    },
    handler: ({ name, immediate }) => {
      if (!expressionNames.includes(name)) {
        throw new Error(`Unknown expression: ${name}`);
      }
      bridge.setExpression(name, !!immediate);
      return `Expression set to ${name}`;
    }
  });

  server.registerTool({
    name: "self.set_emotion",
    description: "Set facial expression by emotion keyword (happy/sad/angry/...). Useful when the LLM wants to react with a named feeling instead of a specific expression slot.",
    inputSchema: {
      type: "object",
      properties: {
        emotion: { type: "string", enum: listKnownEmotions() },
        immediate: { type: "boolean" }
      },
      required: ["emotion"]
    },
    handler: ({ emotion, immediate }) => {
      bridge.setEmotion(emotion, !!immediate);
      return `Emotion set to ${emotion}`;
    }
  });

  server.registerTool({
    name: "self.clear_expression",
    description: "Clear the active expression, returning the avatar to neutral.",
    inputSchema: {
      type: "object",
      properties: { immediate: { type: "boolean" } }
    },
    handler: ({ immediate } = {}) => {
      bridge.clearExpression(!!immediate);
      return "Expression cleared";
    }
  });

  server.registerTool({
    name: "self.trigger_blink",
    description: "Make the avatar blink once.",
    inputSchema: { type: "object", properties: {} },
    handler: () => {
      bridge.triggerBlink();
      return "Blinked";
    }
  });

  server.registerTool({
    name: "self.get_state",
    description: "Return current avatar state snapshot (expression, eye position, mouth).",
    inputSchema: { type: "object", properties: {} },
    handler: () => bridge.getSnapshot()
  });
}
