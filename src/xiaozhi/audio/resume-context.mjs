/**
 * Resume a suspended AudioContext without hanging forever.
 *
 * Some WebView builds keep AudioContexts suspended until the page has had a user
 * gesture (the Blimp: after a cold start the mic only opened once someone touched
 * the screen). The Android host taps the page itself after each load; if that
 * hasn't landed yet, carry on after `timeoutMs` instead of blocking the
 * conversation. The pending resume() still completes once the page is activated.
 */
export async function resumeContext(ctx, what, timeoutMs = 3000) {
  if (!ctx || ctx.state !== "suspended") return true;
  let timer;
  const resumed = await Promise.race([
    ctx.resume().then(() => true, () => false),
    new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); })
  ]);
  clearTimeout(timer);
  if (!resumed) {
    console.warn(`[audio] ${what} AudioContext still suspended after ${timeoutMs} ms ` +
      "(page has had no user gesture); continuing");
  }
  return resumed;
}
