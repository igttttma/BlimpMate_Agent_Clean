import { ensureActivated } from "./ota/activation.mjs";
import { ensureDeviceIdentity } from "./config/device-identity.mjs";
import { Conversation } from "./conversation/conversation.mjs";

export { ListeningMode, DeviceState, AbortReason } from "./protocol/message-types.mjs";

export async function createXiaozhiAgent({ bridge, assetUrls, onActivationRequired }) {
  const storage = bridge.storage;
  const identity = await ensureDeviceIdentity(storage);
  const { wsUrl, wsToken } = await ensureActivated(storage, onActivationRequired);
  const conversation = new Conversation({ bridge, identity, wsUrl, wsToken, assetUrls });
  await conversation.init();
  return { conversation, identity };
}
