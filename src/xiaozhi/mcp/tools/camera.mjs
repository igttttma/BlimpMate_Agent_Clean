// Camera tool: the LLM calls it when it needs to see. The photo goes back as an
// MCP image block in the tool result; the server attaches it to the conversation
// for the (multimodal) main LLM, so there is no separate upload or vision model.

const MAX_SIDE = 768; // px; enough for a multimodal LLM, keeps the WS message small
const JPEG_QUALITY = 0.75;
const SETTLE_MS = 500; // let auto exposure / focus settle before grabbing a frame

export async function capturePhoto({ facing = "user", maxSide = MAX_SIDE } = {}) {
  const media = globalThis.navigator?.mediaDevices;
  if (!media?.getUserMedia) throw new Error("Camera is not available on this device");
  const stream = await media.getUserMedia({
    video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false
  });
  try {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play();
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    const scale = Math.min(1, maxSide / Math.max(video.videoWidth, video.videoHeight));
    const width = Math.round(video.videoWidth * scale);
    const height = Math.round(video.videoHeight * scale);
    if (!width || !height) throw new Error("Camera returned no frames");
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d").drawImage(video, 0, 0, width, height);
    const dataUrl = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
    return { data: dataUrl.slice(dataUrl.indexOf(",") + 1), mimeType: "image/jpeg", width, height };
  } finally {
    stream.getTracks().forEach((track) => track.stop());
  }
}

export function registerCameraTools(server, { capture = capturePhoto } = {}) {
  server.registerTool({
    name: "camera.take_photo",
    description: "Take a photo with the device camera to see the user or the surroundings. Call this when the user asks you to look at something, what you can see, how they look, or what they are holding. The photo is attached to the conversation; answer from it.",
    inputSchema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "What to look for in the photo"
        },
        camera: {
          type: "string",
          enum: ["front", "back"],
          description: "front faces the user (default); back faces away, on devices that have one"
        }
      }
    },
    handler: async ({ question = "", camera = "front" } = {}) => {
      const photo = await capture({ facing: camera === "back" ? "environment" : "user" });
      return {
        content: [
          { type: "text", text: `Photo taken (${photo.width}x${photo.height})${question ? ` for: ${question}` : ""}.` },
          { type: "image", data: photo.data, mimeType: photo.mimeType }
        ]
      };
    }
  });
}
