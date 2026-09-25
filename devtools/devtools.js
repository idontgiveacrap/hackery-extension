// Static icon path only — no runtime drawing/recoloring.
// Root-absolute path (leading /). Empty string falls back to the extension icon.
browser.devtools.panels
  .create(
    "Network Rules",
    "/icons/devtools-icon-default-16.png",
    "/network/ui/rules.html"
  )
  .catch((error) => {
    console.error("Hackery Lab: failed to create Network Rules panel", error);
    return browser.devtools.panels.create(
      "Network Rules",
      "",
      "/network/ui/rules.html"
    );
  });

browser.devtools.panels
  .create(
    "Link log",
    "/icons/devtools-icon-default-16.png",
    "/activity-log/activity-log.html"
  )
  .catch((error) => {
    console.error("Hackery Lab: failed to create Link log panel", error);
    return browser.devtools.panels.create(
      "Link log",
      "",
      "/activity-log/activity-log.html"
    );
  });
