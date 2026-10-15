import assert from "node:assert/strict";
import { registerSessionControlTools } from "../../mcp/tools/session-control.mjs";
import { MouthDriver } from "../../conversation/mouth-driver.mjs";
import { Live2DControlCore, ExpressionType } from "../../../core/live2d-control-core.mjs";
import { createLocalHostBridge } from "../../../bridge/host-bridge.mjs";

async function testSessionEndTool() {
  let tool = null;
  let ended = null;
  const server = {
    registerTool(definition) { tool = definition; }
  };
  registerSessionControlTools(server, {
    endSession: ({ reason }) => { ended = reason; }
  });

  assert.equal(tool.name, "session.end");
  const result = tool.handler({ reason: "user_said_goodbye" });
  assert.equal(result.success, true);
  assert.equal(result.action, "session.end");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(ended, "user_said_goodbye");
}

async function testMouthWatchdogClosesOnSilence() {
  const values = [];
  let cleared = 0;
  const driver = new MouthDriver({
    setMouthOpen(value) { values.push(value); },
    clearMouthOpen() { cleared += 1; }
  }, { watchdogMs: 20 });

  driver.begin();
  driver.feedRms(0.2);
  assert.ok(values.at(-1) > 0);
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(values.at(-1), 0);
  driver.end();
  assert.equal(values.at(-1), 0);
  assert.equal(cleared, 0);
}

function testExpressionCannotOpenSilentMouth() {
  const core = new Live2DControlCore({ enableRandomMouthMovement: false });
  const bridge = createLocalHostBridge(core, {
    storage: { get: () => null, set() {}, remove() {} }
  });
  const driver = new MouthDriver(bridge);

  core.setExpression(ExpressionType.Happy, true);
  core.update(0.05);
  assert.equal(core.snapshot().mouthOpen, 0);

  driver.begin();
  driver.feedRms(0.2);
  assert.ok(core.snapshot().mouthOpen > 0);
  driver.end();
  core.update(0.05);
  assert.equal(core.snapshot().mouthOpen, 0);
}

function testDefaultMouthGainAndLimit() {
  const values = [];
  const driver = new MouthDriver({
    setMouthOpen(value) { values.push(value); }
  }, { smoothing: 0, floor: 0, watchdogMs: 1000 });

  driver.begin();
  driver.feedRms(0.1);
  assert.ok(Math.abs(values.at(-1) - 0.6) < 1e-9);
  driver.feedRms(1);
  assert.equal(values.at(-1), 0.7);
  driver.end();
}

function testExpressionAutoRecoversAfterDefaultDuration() {
  const core = new Live2DControlCore({ expressionTransitionDuration: 0.01 });

  assert.equal(core.settings.autoRecoverExpression, true);
  assert.equal(core.settings.expressionDuration, 6);
  core.setExpression(ExpressionType.Happy, true);
  core.update(5.9);
  assert.equal(core.targetExpression, ExpressionType.Happy);
  core.update(0.2);
  assert.equal(core.targetExpression, ExpressionType.None);
}

await testSessionEndTool();
await testMouthWatchdogClosesOnSilence();
testExpressionCannotOpenSilentMouth();
testDefaultMouthGainAndLimit();
testExpressionAutoRecoversAfterDefaultDuration();
console.log("session control and mouth watchdog tests: ok");
