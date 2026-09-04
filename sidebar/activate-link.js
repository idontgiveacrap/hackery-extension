import { activateLinkNode } from "../lib/activate-link.js";

/**
 * UI wrapper: shows messages; does not close the sidebar on navigate.
 */
export function createActivateLink({ showMessage, hideMessage }) {
  return async function activateLink(node, row = null) {
    hideMessage();
    try {
      const outcome = await activateLinkNode(node, { row, trigger: "sidebar" });
      if (!outcome.ok) {
        showMessage(outcome.message || "Action failed.");
        return;
      }
      if (outcome.behaviorId === "run") {
        showMessage("Script ran — check the page console.");
      }
    } catch (error) {
      showMessage(error.message || String(error));
    }
  };
}
