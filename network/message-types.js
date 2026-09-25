/**
 * Runtime message type strings for the network-rules plugin.
 * Senders and handlers must use these constants (not raw strings).
 */
export const NetworkMessageTypes = {
  INSTALL_NETWORK_HOOK: "INSTALL_NETWORK_HOOK",
  REFRESH_NETWORK_RULES: "REFRESH_NETWORK_RULES",
  GET_NETWORK_RULES: "GET_NETWORK_RULES",
  SAVE_NETWORK_RULES: "SAVE_NETWORK_RULES",
  NETWORK_RULE_LOG: "NETWORK_RULE_LOG",
  NETWORK_SHARED_STATE: "NETWORK_SHARED_STATE",
  CLEAR_NETWORK_RULE_LOG: "CLEAR_NETWORK_RULE_LOG",
  TEST_NETWORK_RULE: "TEST_NETWORK_RULE",
};

export const NetworkMessageTypeSet = new Set(
  Object.values(NetworkMessageTypes)
);
