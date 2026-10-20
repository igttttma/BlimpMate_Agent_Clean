import { registerSelfControlTools } from "./self-control.mjs";
import { registerSessionControlTools } from "./session-control.mjs";
import { registerCameraTools } from "./camera.mjs";

export function registerAllTools(mcp, bridge, sessionControl = {}) {
  registerSelfControlTools(mcp, bridge);
  registerSessionControlTools(mcp, sessionControl);
  registerCameraTools(mcp);
}
