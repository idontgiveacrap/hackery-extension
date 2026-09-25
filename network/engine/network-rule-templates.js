import { normalizeRulePatternModes } from "./network-rules-shared.js";

export async function loadNetworkRuleTemplates() {
  const response = await fetch(
    browser.runtime.getURL("network/data/network-rule-templates.json")
  );
  if (!response.ok) {
    throw new Error("Failed to load rule templates.");
  }
  const data = await response.json();
  return Array.isArray(data.templates) ? data.templates : [];
}

export function instantiateNetworkRuleTemplate(template) {
  if (!template?.rule || typeof template.rule !== "object") {
    throw new Error("Invalid rule template.");
  }
  const rule = normalizeRulePatternModes(JSON.parse(JSON.stringify(template.rule)));
  rule.id = crypto.randomUUID();
  return rule;
}
