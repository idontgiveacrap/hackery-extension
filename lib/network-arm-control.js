/**
 * Arm control for network rules, shared by the sidebar and the DevTools panel.
 *
 * One button the whole way through: disarmed it reads "Arm rules 10m", armed it
 * shows the countdown and splits into an extend half (left, green) and a
 * disable half (right, red) under a single label that spans both.
 */
import { MessageTypes } from "./message-types.js";

const EXTEND_TITLE = "Extend: restart the full timer";
const DISABLE_TITLE = "Disable network rules now";
const WAITING_TITLE =
  "Rules are armed but no rule is enabled, so no timer is running. Enable a rule to start the countdown.";

/**
 * Format remaining time as M:SS, floored at 0:00.
 * @param {number} expiresAt Epoch ms.
 * @returns {string}
 */
function countdownText(expiresAt) {
  const totalSec = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
  return `${Math.floor(totalSec / 60)}:${String(totalSec % 60).padStart(2, "0")}`;
}

/**
 * Mount the control into a container element.
 *
 * @param {HTMLElement} container Empty element to own the control markup.
 * @param {{ beforeArm?: () => Promise<void> | void }} [options] `beforeArm`
 *   runs before arming, for callers that must settle their own state first.
 * @returns {{ refresh: () => Promise<void>, render: (snapshot: object) => void }}
 */
export function createNetworkArmControl(container, options = {}) {
  const { beforeArm } = options;

  const armButton = document.createElement("button");
  armButton.type = "button";
  armButton.className = "arm-control-button";

  const live = document.createElement("div");
  live.className = "arm-control-live";
  live.hidden = true;

  const extendHalf = document.createElement("button");
  extendHalf.type = "button";
  extendHalf.className = "arm-control-half arm-control-extend";
  extendHalf.title = EXTEND_TITLE;
  extendHalf.setAttribute("aria-label", "Extend timer");

  const disarmHalf = document.createElement("button");
  disarmHalf.type = "button";
  disarmHalf.className = "arm-control-half arm-control-disarm";
  disarmHalf.title = DISABLE_TITLE;
  disarmHalf.setAttribute("aria-label", "Disable network rules");

  // Decorative: the halves carry the accessible names, and the label must not
  // swallow clicks aimed at whichever half is under the cursor.
  const label = document.createElement("span");
  label.className = "arm-control-label";
  label.setAttribute("aria-hidden", "true");

  live.append(extendHalf, disarmHalf, label);
  container.classList.add("arm-control");
  container.replaceChildren(armButton, live);

  let snapshot = { armed: false, waiting: false, expiresAt: 0, minutes: 10 };
  let tick = null;

  function stopTick() {
    if (tick) {
      clearInterval(tick);
      tick = null;
    }
  }

  function paintLabel() {
    if (snapshot.waiting || !snapshot.expiresAt) {
      label.textContent = "Ready";
      return;
    }
    label.textContent = countdownText(snapshot.expiresAt);
    if (snapshot.expiresAt <= Date.now()) {
      // The alarm fires in the background; re-read rather than trust 0:00.
      stopTick();
      void refresh();
    }
  }

  function render(next) {
    snapshot = { ...snapshot, ...(next || {}) };
    const armed = Boolean(snapshot.armed);
    armButton.hidden = armed;
    live.hidden = !armed;

    if (!armed) {
      stopTick();
      armButton.textContent = `Arm rules ${snapshot.minutes || 10}m`;
      armButton.title = `Arm network rules. The ${snapshot.minutes || 10}-minute timer starts once at least one rule is enabled.`;
      return;
    }

    const timed = !snapshot.waiting && Boolean(snapshot.expiresAt);
    extendHalf.disabled = !timed;
    extendHalf.title = timed ? EXTEND_TITLE : WAITING_TITLE;
    live.classList.toggle("is-waiting", !timed);
    paintLabel();

    if (timed && !tick) {
      tick = setInterval(paintLabel, 1000);
    } else if (!timed) {
      stopTick();
    }
  }

  async function send(message) {
    try {
      const response = await browser.runtime.sendMessage({
        type: MessageTypes.SET_NETWORK_ARM,
        ...message,
      });
      if (response?.ok) {
        render(response);
      }
    } catch {
      // Background asleep or mid-reload; the next broadcast or refresh recovers.
    }
  }

  async function refresh() {
    try {
      const response = await browser.runtime.sendMessage({
        type: MessageTypes.GET_NETWORK_ARM,
      });
      if (response?.ok) {
        render(response);
      }
    } catch {
      // ignore
    }
  }

  armButton.addEventListener("click", async () => {
    await beforeArm?.();
    await send({ armed: true });
  });
  extendHalf.addEventListener("click", () => send({ reset: true }));
  disarmHalf.addEventListener("click", () => send({ armed: false }));

  browser.runtime.onMessage.addListener((message) => {
    if (message?.type === MessageTypes.NETWORK_ARM_CHANGED) {
      render(message);
    }
  });

  render(snapshot);
  return { refresh, render };
}
