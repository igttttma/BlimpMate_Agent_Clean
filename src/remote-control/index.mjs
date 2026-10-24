import { AbortReason, DeviceState } from "../xiaozhi/index.mjs";
import { ControlChannel } from "./control-channel.mjs";
import { MediaPlayback } from "./media-playback.mjs";
import { VideoCache } from "./video-cache.mjs";

// Realtime control from the server portal: the Blimp shows as online while the
// control socket is open, reports what it is doing, and plays portal audio and
// video. Videos are prefetched into a local cache so they start at once. The
// portal can also set the avatar's expression and blinking (like the Debug
// panel) and drive the conversation (like the Chat panel).

/** The portal's HTTP origin: the conversation server's host on its HTTP port. */
function httpOrigin(wsUrl, httpPort) {
  const url = new URL(wsUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  if (httpPort) url.port = String(httpPort);
  return url.origin;
}

export function startRemoteControl({ conversation, identity, callController, getWakeCoordinator, avatar, log = () => {} }) {
  const channel = new ControlChannel({ wsUrl: conversation.wsUrl, token: conversation.wsToken, identity });
  const playback = new MediaPlayback({ conversation, getWakeCoordinator, callController, log });
  const videos = new VideoCache({ log });
  const expressions = avatar.getExpressionTypes();

  const avatarState = () => {
    const settings = avatar.getSettings();
    return {
      expression: avatar.getSnapshot().targetExpression,
      auto_blink: settings.autoBlink,
      auto_recover: settings.autoRecoverExpression,
      expressions
    };
  };

  const snapshot = () => {
    const device = conversation.state.device;
    const inConversation = conversation._autoSessionActive || device !== DeviceState.IDLE;
    const call = callController?.state || "off";
    return {
      type: "state",
      activity: callController?.busy ? call : playback.active ? "playing" : inConversation ? "conversation" : "idle",
      conversation: inConversation && device === DeviceState.IDLE ? "connecting" : device,
      connected: conversation.state.connected,
      call,
      wake: !!getWakeCoordinator()?.running,
      playback: playback.playback,
      loop: playback.loop,
      videos: videos.status(),
      avatar: avatarState(),
      // Lists this Blimp in the portal (several can share one server)
      client: { user_agent: navigator.userAgent, platform: globalThis.hostInfo?.platform || "" }
    };
  };
  // Coalesce bursts (a takeover changes several things at once) into one report
  let pending = false;
  const report = () => {
    if (pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      channel.send(snapshot());
    });
  };

  channel.addEventListener("status", (e) => {
    const { state, reason } = e.detail;
    const messages = {
      connected: ["info", "Server control connected"],
      disconnected: ["warn", "Server control disconnected; reconnecting"],
      blocked: ["warn", "Another Blimp is connected to this server; this one is blocked (retrying)"],
      replaced: ["warn", "This device connected to the server again elsewhere; control here is off"]
    };
    const [level, message] = messages[state] || ["info", `Server control: ${state}`];
    log(level, message, reason ? { reason } : {});
    if (state === "connected") report();
  });
  channel.addEventListener("command", (e) => {
    const msg = e.detail;
    if (msg.type === "play" && typeof msg.path === "string") {
      const kind = msg.kind === "video" ? "video" : "audio";
      // A cached video plays from the local copy; otherwise stream the signed link
      const cached = kind === "video" ? videos.urlFor(msg.id) : null;
      const url = cached || new URL(msg.path, httpOrigin(conversation.wsUrl, msg.http_port)).toString();
      playback.play({ kind, id: msg.id, title: msg.title || (kind === "video" ? "Video" : "Audio"), url, source: cached ? "cache" : "stream" });
    } else if (msg.type === "settings") {
      const bargeIn = msg.barge_in === true;
      if (conversation.bargeIn !== bargeIn) {
        log("info", `Interrupt ${bargeIn ? "on" : "off"} (from the next time the Blimp listens)`);
      }
      conversation.bargeIn = bargeIn;
    } else if (msg.type === "config_reloaded") {
      // Portal Save: the conversation link takes the new settings when it reopens
      conversation.markLinkStale();
    } else if (msg.type === "videos" && Array.isArray(msg.videos)) {
      const origin = httpOrigin(conversation.wsUrl, msg.http_port);
      videos.sync(msg.videos.map((v) => ({ ...v, url: new URL(v.path, origin).toString() })));
    } else if (msg.type === "stop_audio") {
      playback.stop("stopped from the portal");
    } else if (msg.type === "pause_media") {
      if (!playback.pause()) log("info", "Portal pause ignored: nothing is playing");
    } else if (msg.type === "resume_media") {
      if (!playback.resume()) log("info", "Portal resume ignored: nothing is paused");
    } else if (msg.type === "set_loop") {
      playback.setLoop(msg.loop === true);
    } else if (msg.type === "answer_call") {
      // Fallback when the spoken "answer" isn't heard; ignored unless ringing
      if (!callController?.answer("portal")) log("info", "Portal answer ignored: no call is ringing");
    } else if (msg.type === "decline_call") {
      if (!callController?.decline("portal")) log("info", "Portal decline ignored: no call is ringing");
    } else if (msg.type === "end_call") {
      if (!callController?.end("portal")) log("info", "Portal end call ignored: no call");
    } else if (msg.type === "avatar") {
      setAvatar(msg);
    } else if (msg.type === "conversation") {
      runConversation(msg).catch((err) => log("error", `Portal ${msg.action} failed`, { error: String(err) }));
    }
  });

  // Like the Debug panel: expression buttons, Blink, and the two switches
  function setAvatar(msg) {
    if (msg.expression === "None") avatar.clearExpression();
    else if (expressions.includes(msg.expression)) avatar.setExpression(msg.expression);
    if (msg.blink === true) avatar.triggerBlink();
    if (typeof msg.auto_blink === "boolean") avatar.setAutoBlink(msg.auto_blink);
    if (typeof msg.auto_recover === "boolean") avatar.setAutoRecoverExpression(msg.auto_recover);
    report();
  }

  // Like the Chat panel; "start" is the wake word ("Hey Blimp") without saying it
  async function runConversation({ action, text }) {
    if (callController?.busy && action !== "disconnect" && action !== "interrupt") {
      log("info", `Portal ${action} ignored: a video call has the microphone`);
      return;
    }
    log("info", `Portal: ${action}`);
    if (action === "connect") {
      await conversation.connect();
    } else if (action === "disconnect") {
      await conversation.endSession();
    } else if (action === "start") {
      const event = { word: "Hey Blimp", source: "portal" };
      const wake = getWakeCoordinator();
      await (wake ? wake.activate(event) : conversation.activateFromWake(event));
    } else if (action === "interrupt") {
      await conversation.abort(AbortReason.USER_INTERRUPTION);
    } else if (action === "send_text" && typeof text === "string") {
      await conversation.sendText(text);
    }
  }

  // Expressions also change on their own (the AI's emotions, returning to
  // neutral): report those too
  let lastExpression = avatarState().expression;
  setInterval(() => {
    const expression = avatar.getSnapshot().targetExpression;
    if (expression !== lastExpression) {
      lastExpression = expression;
      report();
    }
  }, 500);

  playback.addEventListener("change", report);
  videos.addEventListener("change", report);
  conversation.state.addEventListener("device", report);
  conversation.addEventListener("wake", report);
  conversation.addEventListener("session-ended", report);
  conversation.state.addEventListener("connected", report);
  callController?.addEventListener("status", report);
  getWakeCoordinator()?.addEventListener("status", report);

  channel.connect();
  return { channel, playback, videos };
}
