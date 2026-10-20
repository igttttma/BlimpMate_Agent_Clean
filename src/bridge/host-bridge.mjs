import { ExpressionType } from "../core/expression-data.mjs";
import { mapEmotionToExpression } from "../xiaozhi/emotion/emotion-map.mjs";

function defaultStorage() {
  return {
    get(key) {
      try {
        const v = window.localStorage.getItem(key);
        return v === null ? null : v;
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        window.localStorage.setItem(key, value);
      } catch {}
    },
    remove(key) {
      try {
        window.localStorage.removeItem(key);
      } catch {}
    }
  };
}

export function createLocalHostBridge(core, options = {}) {
  const storage = options.storage || defaultStorage();
  const hostInfo = options.hostInfo || { platform: "web", arch: "unknown" };

  return {
    tick(dt) {
      core.update(dt);
    },
    setExpression(name, immediate = false) {
      core.setExpression(name, immediate);
    },
    clearExpression(immediate = false) {
      core.clearExpression(immediate);
    },
    setEmotion(emotion, immediate = false) {
      const target = mapEmotionToExpression(emotion);
      if (!target || target === ExpressionType.None) {
        core.clearExpression(immediate);
      } else {
        core.setExpression(target, immediate);
      }
    },
    setMouthOpen(value) {
      core.setExternalMouthOpen(value);
    },
    clearMouthOpen() {
      core.clearExternalMouthOpen();
    },
    triggerBlink() {
      core.triggerBlink();
    },
    setRandomEyeMovement(enable) {
      core.setRandomEyeMovement(enable);
    },
    setRandomBrowMovement(enable) {
      core.settings.enableRandomBrowMovement = enable;
    },
    setRandomMouthMovement(enable) {
      core.settings.enableRandomMouthMovement = enable;
    },
    setAutoRecoverExpression(enable) {
      core.settings.autoRecoverExpression = enable;
    },
    /** Random blinking on/off; triggerBlink() still blinks once either way. */
    setAutoBlink(enable) {
      core.settings.enableAutoBlink = enable;
    },
    setBlinkSettings(minInterval, maxInterval, duration) {
      core.setBlinkSettings(minInterval, maxInterval, duration);
    },
    setEyeMovementSettings({ interval, speed, range, returnDelay }) {
      core.settings.eyeMovementInterval = interval;
      core.settings.eyeMovementSpeed = speed;
      core.settings.eyeMovementRange = range;
      core.settings.eyeReturnDelay = returnDelay;
    },
    setMouthMovementRange(range) {
      core.settings.mouthMovementRange = range;
    },
    getSettings() {
      return {
        blinkDuration: core.settings.blinkDuration,
        autoBlink: core.settings.enableAutoBlink,
        autoRecoverExpression: core.settings.autoRecoverExpression,
        eyeMovementInterval: core.settings.eyeMovementInterval,
        eyeReturnDelay: core.settings.eyeReturnDelay
      };
    },
    getExpressionTypes() {
      return Object.values(ExpressionType);
    },
    getLive2DParameters() {
      const p = core.parameters;
      return {
        ParamAngleX:    p[0],
        ParamAngleY:    p[1],
        ParamEyeLOpen:  p[2],
        ParamEyeLSmile: p[3],
        ParamEyeROpen:  p[4],
        ParamEyeRSmile: p[5],
        ParamEyeBallX:  p[6],
        ParamEyeBallY:  p[7],
        ParamBrowLY:    p[8],
        ParamBrowLX:    p[9],
        ParamBrowRY:    p[10],
        ParamBrowRX:    p[11],
        ParamBrowLAngle:p[12],
        ParamBrowRAngle:p[13],
        ParamMouthForm: p[14],
        ParamMouthOpenY:p[15],
        LoveID:         p[16],
        HardWorkParam:  p[17],
        QuestionParam:  p[18],
        AngerParam:     p[19],
        SweatParam:     p[20],
        SadParam:       p[21],
        HappyParam:     p[22]
      };
    },
    getSnapshot() {
      return core.snapshot();
    },
    storage,
    hostInfo
  };
}
