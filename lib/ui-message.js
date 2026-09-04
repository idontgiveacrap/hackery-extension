export function createUiMessage(element, { onChange } = {}) {
  let hideTimer = 0;

  const hideMessage = () => {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = 0;
    }
    if (!element) {
      return;
    }
    element.replaceChildren();
    element.classList.add("hidden");
    onChange?.();
  };

  if (!element) {
    return {
      showMessage() {},
      hideMessage() {},
    };
  }

  return {
    /**
     * @param {string} text
     * @param {{ actionLabel?: string, onAction?: () => void|Promise<void>, timeoutMs?: number }} [options]
     */
    showMessage(text, options = {}) {
      if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = 0;
      }
      element.replaceChildren();
      const textEl = document.createElement("span");
      textEl.className = "message-text";
      textEl.textContent = text;
      element.appendChild(textEl);
      if (options.actionLabel && options.onAction) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "message-action";
        button.textContent = options.actionLabel;
        button.addEventListener("click", async () => {
          hideMessage();
          await options.onAction();
        });
        element.appendChild(button);
      }
      element.classList.remove("hidden");
      if (options.timeoutMs > 0) {
        hideTimer = setTimeout(hideMessage, options.timeoutMs);
      }
      onChange?.();
    },
    hideMessage,
  };
}
