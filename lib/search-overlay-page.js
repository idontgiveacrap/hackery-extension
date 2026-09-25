globalThis.__HackeryLabSyncSearchOverlay = function syncHackeryLabSearchOverlay(visible, text) {
  const ROOT_ID = "hackery-lab-search-overlay";

  function removeOverlay() {
    document.getElementById(ROOT_ID)?.remove();
  }

  if (!visible) {
    removeOverlay();
    return;
  }

  let root = document.getElementById(ROOT_ID);
  if (!root) {
    root = document.createElement("div");
    root.id = ROOT_ID;
    root.setAttribute("role", "status");
    root.setAttribute("aria-live", "polite");
    root.setAttribute("aria-label", "Search links");
    root.style.cssText = [
      "position:fixed",
      "top:48px",
      "left:50%",
      "transform:translateX(-50%)",
      "z-index:2147483647",
      "width:min(320px,calc(100vw - 24px))",
      "pointer-events:none",
      "box-sizing:border-box",
    ].join(";");

    const box = document.createElement("div");
    box.dataset.HackeryLabSearchBox = "true";
    box.style.cssText = [
      "padding:8px 12px",
      "border:1px solid rgba(129,181,161,0.22)",
      "border-radius:8px",
      "background:rgba(24,24,28,0.12)",
      "backdrop-filter:blur(3px)",
      "-webkit-backdrop-filter:blur(3px)",
      "color:#f3f4f6",
      "font:14px/1.3 system-ui,-apple-system,Segoe UI,sans-serif",
      "box-shadow:none",
      "text-shadow:0 0 6px rgba(0,0,0,0.75)",
      "min-height:1.3em",
      "white-space:pre",
    ].join(";");

    root.appendChild(box);
    (document.documentElement || document.body).appendChild(root);
  }

  const box = root.querySelector('[data-hackery-lab-search-box="true"]');
  if (box) {
    box.textContent = text || "";
  }
};
