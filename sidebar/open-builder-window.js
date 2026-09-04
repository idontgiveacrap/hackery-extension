import { captureTabPrefillForBuilder } from "./link-quick-add.js";
import { StorageKeys } from "../lib/storage-keys.js";

const BUILDER_PAGE = "builder/builder.html";
const { LINK_BUILDER_PREFILL_KEY, LINK_BUILDER_SECTION_KEY } = StorageKeys;

async function stashBuilderPrefill(sectionName) {
  const prefill = await captureTabPrefillForBuilder();
  await browser.storage.session.set({ [LINK_BUILDER_PREFILL_KEY]: prefill });
  if (sectionName) {
    await browser.storage.session.set({ [LINK_BUILDER_SECTION_KEY]: sectionName });
  }
}

export async function openLinkBuilderWindow({ editId, sectionName } = {}) {
  const baseUrl = browser.runtime.getURL(BUILDER_PAGE);
  const params = new URLSearchParams();
  if (editId) {
    params.set("edit", editId);
  } else {
    params.set("new", "1");
    if (sectionName) {
      params.set("section", sectionName);
    }
  }
  const targetUrl = `${baseUrl}?${params.toString()}`;

  if (!editId) {
    await stashBuilderPrefill(sectionName);
  }

  const windows = await browser.windows.getAll({ populate: true });
  for (const win of windows) {
    for (const tab of win.tabs || []) {
      if (tab.url?.startsWith(baseUrl) && win.id != null) {
        await browser.windows.update(win.id, { focused: true });
        if (tab.id != null) {
          await browser.tabs.update(tab.id, { active: true, url: targetUrl });
        }
        return;
      }
    }
  }

  await browser.windows.create({
    url: targetUrl,
    type: "popup",
    width: 960,
    height: 720,
  });
}
