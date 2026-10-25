import * as PIXI from "pixi.js";
import { Live2DModel } from "pixi-live2d-display/cubism4";
import { FACE_BOUNDS, layoutVertices } from "./face-layout.mjs";

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
  // Create the WebGL context only once the page has loaded. On a cold start of
  // the Android app (seen on the emulator), a context created while the page is
  // still loading gets a canvas buffer that never shows what is drawn; the
  // face stayed invisible until something resized the canvas.
  if (document.readyState !== "complete") {
    await new Promise((resolve) => addEventListener("load", resolve, { once: true }));
  }
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
    _applyFaceLayout(_model.internalModel.coreModel);

    _fitModel();
    console.log("[Live2D] Model loaded successfully");
    return true;
  } catch (err) {
    console.error("[Live2D] Failed to load model:", err);
    return false;
  }
}

// The renderer reads every drawable's vertices through getDrawableVertices;
// icon drawables get moved copies (face-layout.mjs), the rest pass through
function _applyFaceLayout(coreModel) {
  const original = coreModel.getDrawableVertices.bind(coreModel);
  const buffers = new Map();
  coreModel.getDrawableVertices = (index) => {
    const src = original(index);
    let out = buffers.get(index);
    if (!out) {
      out = new Float32Array(src.length);
      buffers.set(index, out);
    }
    const id = coreModel.getDrawableId(index);
    return layoutVertices(id, src, out, coreModel.getDrawableVertexIndices(index)) || src;
  };
}

// Fit the face band (not the whole canvas, whose icon space would leave the
// face small); the canvas origin is the model's anchor centre
function _fitModel() {
  if (!_model || !_app) return;
  const { width, height } = _app.screen;
  const unit = _model.internalModel.originalHeight; // canvas height = 1 model unit
  const bandWidth = (FACE_BOUNDS.x1 - FACE_BOUNDS.x0) * unit;
  const bandHeight = (FACE_BOUNDS.y1 - FACE_BOUNDS.y0) * unit;
  const scale = Math.min(width / bandWidth, height / bandHeight);
  _model.anchor.set(0.5, 0.5);
  _model.scale.set(scale);
  _model.x = width / 2 - ((FACE_BOUNDS.x0 + FACE_BOUNDS.x1) / 2) * unit * scale;
  _model.y = height / 2 + ((FACE_BOUNDS.y0 + FACE_BOUNDS.y1) / 2) * unit * scale;
}
