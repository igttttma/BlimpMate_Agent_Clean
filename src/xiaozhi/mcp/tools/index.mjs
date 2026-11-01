import { registerSelfControlTools } from "./self-control.mjs";
import { registerCameraTools } from "./camera.mjs";

export function registerAllTools(mcp, bridge) {
  registerSelfControlTools(mcp, bridge);
  registerCameraTools(mcp);
}
