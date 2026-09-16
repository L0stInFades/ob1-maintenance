"use strict";
// Loaded into a disposable OB1 process via NODE_OPTIONS. No inspector port is
// opened: the Session talks to V8 inside the same process.
const inspector = require("node:inspector");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const output = process.env.OB1_AUDIT_CAPTURE_DIR;
if (!output) throw new Error("OB1_AUDIT_CAPTURE_DIR is required");
fs.mkdirSync(output, { recursive: true });
const session = new inspector.Session();
session.connect();
let captured = false;
const observed = [];
session.on("Debugger.scriptParsed", ({ params }) => {
  observed.push({ url: params.url, length: params.length, scriptId: params.scriptId });
  if (captured || !(params.length >= 10000000)) return;
  session.post("Debugger.getScriptSource", { scriptId: params.scriptId }, (error, result) => {
    if (error) throw error;
    if (captured) return;
    captured = true;
    const source = Buffer.from(result.scriptSource, "utf8");
    fs.writeFileSync(path.join(output, "engine-source.cjs"), source);
    fs.writeFileSync(path.join(output, "capture.json"), JSON.stringify({
      node: process.version, url: params.url, bytes: source.length,
      sha256: crypto.createHash("sha256").update(source).digest("hex"),
      method: "V8 Inspector Debugger.getScriptSource (in-process session)",
    }, null, 2) + "\n");
  });
});
session.post("Debugger.enable");
process.on("exit", () => {
  fs.writeFileSync(path.join(output, "observed-scripts.json"), JSON.stringify(observed, null, 2));
  if (!captured) {
    fs.writeFileSync(path.join(output, "capture-failed.txt"), "The main script was not observed.\n");
  }
});
