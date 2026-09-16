#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const stateHome = path.join(root, ".work/dev-home");
fs.mkdirSync(path.join(stateHome, ".ob1/scripts"), { recursive: true });
fs.cpSync(path.join(root, "scripts/optimize"), path.join(stateHome, ".ob1/scripts/optimize"), { recursive: true });
const result = spawnSync(process.execPath, [path.join(root, "src/ob1.cjs"), ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, HOME: stateHome, GEMINI_CLI_HOME: stateHome,
    XDG_CONFIG_HOME: path.join(stateHome, ".config"), SENTRY_ENABLED: process.env.SENTRY_ENABLED ?? "false" },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
