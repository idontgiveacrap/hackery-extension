import { overlayExport, serializeLinkNode } from "../lib/link-catalog.js";

function writeClipboardText(text) {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    if (!document.execCommand("copy")) {
      throw new Error("Clipboard copy failed.");
    }
  } finally {
    textarea.remove();
  }
}

export function formatLinkNodeJson(node) {
  return JSON.stringify(serializeLinkNode(node), null, 2);
}

export async function copyLinkNodeJson(node) {
  await writeClipboardText(formatLinkNodeJson(node));
}

export function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function downloadOverlayJson(overlay) {
  downloadJson("custom-links.json", overlayExport(overlay));
}
