// FILE: index.js
// Purpose: Small entrypoint wrapper for bridge lifecycle commands.
// Layer: CLI entry
// Exports: startBridge, startWebApp, resetBridgePairing, openLastActiveThread, watchThreadRollout
// Depends on: ./bridge, ./secure-device-state, ./session-state, ./rollout-watch

const { startBridge } = require("./bridge");
const { startWebApp } = require("./web-server");
const { resetBridgeDeviceState } = require("./secure-device-state");
const { openLastActiveThread } = require("./session-state");
const { watchThreadRollout } = require("./rollout-watch");

module.exports = {
  startBridge,
  startWebApp,
  resetBridgePairing: resetBridgeDeviceState,
  openLastActiveThread,
  watchThreadRollout,
};
