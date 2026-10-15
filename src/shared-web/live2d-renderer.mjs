import * as PIXI from "pixi.js";
import { Live2DModel } from "pixi-live2d-display/cubism4";

Live2DModel.registerTicker(PIXI.Ticker);

function getAssetBase() {
  if (globalThis.__APP_ASSET_BASE__) {
    return globalThis.__APP_ASSET_BASE__;
  }

  if (globalThis.location?.hostname === "appassets.androidplatform.net") {
    return "https://appassets.androidplatform.net/assets/";
  }

  return "app://localhost/";
}

const ASSET_BASE = getAssetBase();
const MODEL_URL = `${ASSET_BASE}black_origin_face/black_origin_face.model3.json`;

let _app = null;
let _model = null;

export async function initLive2D(container, getParams, onTick) {
  _app = new PIXI.Application({
    width: container.clientWidth || 800,
    height: container.clientHeight || 600,
    backgroundAlpha: 0,
    antialias: true,
    autoDensity: true,
    resolution: window.devicePixelRatio || 1,
  });

  container.appendChild(_app.view);

  _app.ticker.add(() => {
    const dt = Math.min(0.033, _app.ticker.deltaMS / 1000);
    onTick(dt);
  });

  new ResizeObserver(() => {
    _app.renderer.resize(container.clientWidth, container.clientHeight);
    _fitModel();
  }).observe(container);

  try {
    _model = await Live2DModel.from(MODEL_URL, { autoInteract: false });
    _app.stage.addChild(_model);

    _model.internalModel.motionManager.stopAllMotions();

    _model.internalModel.on("beforeModelUpdate", () => {
      const params = getParams();
      const coreModel = _model.internalModel.coreModel;
      for (const [id, value] of Object.entries(params)) {
        coreModel.setParameterValueById(id, value);
      }
    });

    _fitModel();
    console.log("[Live2D] Model loaded successfully");
    return true;
  } catch (err) {
    console.error("[Live2D] Failed to load model:", err);
    return false;
  }
}

function _fitModel() {
  if (!_model || !_app) return;
  const { width, height } = _app.screen;
  _model.anchor.set(0.5, 0.5);
  _model.x = width / 2;
  _model.y = height / 2;
  const scale = height / _model.internalModel.originalHeight;
  _model.scale.set(scale);
}
