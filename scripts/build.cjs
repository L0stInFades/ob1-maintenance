#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
async function main() {
const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");
fs.mkdirSync(path.join(dist, "bin"), { recursive: true });
fs.mkdirSync(path.join(dist, "bundle"), { recursive: true });
execFileSync(process.execPath, ["--check", path.join(root, "src/ob1.cjs")], { stdio: "inherit" });
fs.copyFileSync(path.join(root, "src/ob1.cjs"), path.join(dist, "bundle/gemini-sea.cjs"));
fs.cpSync(path.join(root, "scripts/optimize"), path.join(dist, "scripts/optimize"), { recursive: true });
for (const entry of fs.readdirSync(path.join(root, "src"))) {
  if (entry !== "policies" && !entry.endsWith(".sb")) continue;
  // SEA looks beside the executable; normal Node mode resolves beside the bundle.
  for (const dir of ["bin", "bundle"])
    fs.cpSync(path.join(root, "src", entry), path.join(dist, dir, entry), { recursive: true });
}
// Always supply a plain Node entry point, even if SEA building is unavailable.
fs.writeFileSync(path.join(dist, "ob1-node"), '#!/bin/sh\nset -eu\nOB1_BUILD_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec node "$OB1_BUILD_DIR/bundle/gemini-sea.cjs" "$@"\n', { mode: 0o755 });
const hash = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const metadata = JSON.parse(fs.readFileSync(path.join(root, "recovered/extraction.json"), "utf8"));
const template = path.join(root, "original/bin/ob1");
if (hash(template) !== metadata.binary_sha256) throw new Error("Original executable checksum mismatch");
if (metadata.header_size !== 9 || metadata.flags !== 1 || metadata.asset_names.length)
  throw new Error("Repacker expects this capture's plaintext Node 24 SEA layout");
// Preserve the installed, working Node 24.16.0 runtime. Node 26 --build-sea
// produced a dyld initializer crash on this Intel Mac during validation.
const header = Buffer.alloc(9);
header.writeUInt32LE(0x0143da20, 0);
header.writeUInt32LE(metadata.flags, 4);
header[8] = metadata.exec_argv_extension;
function string(bytes) {
  const size = Buffer.alloc(8);
  size.writeBigUInt64LE(BigInt(bytes.length));
  return Buffer.concat([size, bytes]);
}
const codePath = path.join(dist, "bundle/gemini-sea.cjs");
const blob = Buffer.concat([header, string(Buffer.from(metadata.entry_path)), string(fs.readFileSync(codePath))]);
const staging = path.join(root, ".work/build/ob1");
fs.mkdirSync(path.dirname(staging), { recursive: true });
fs.copyFileSync(template, staging);
if (process.platform === "darwin")
  execFileSync("/usr/bin/codesign", ["--remove-signature", staging], { stdio: "inherit" });
const payloadPath = path.join(root, ".work/build/sea.blob");
fs.writeFileSync(payloadPath, blob);
execFileSync("python3", [path.join(root, "scripts/repack_macho.py"), staging, payloadPath], { stdio: "inherit" });
if (process.platform === "darwin") {
  execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", staging], { stdio: "inherit" });
  execFileSync("/usr/bin/codesign", ["--verify", "--strict", staging], { stdio: "inherit" });
}
fs.chmodSync(staging, 0o755);
const output = path.join(dist, "bin/ob1");
fs.renameSync(staging, output);
fs.writeFileSync(path.join(root, "reports/build.json"), JSON.stringify({
  builderRuntime: process.version, targetRuntime: "Node 24.16.0 from original/bin/ob1",
  templateSha256: metadata.binary_sha256, method: "resize original SEA segment; preserve native code and data; relocate LINKEDIT file offsets",
  platform: "darwin", arch: "x64", sourceSha256: hash(codePath),
  executableSha256: hash(output), executableSize: fs.statSync(output).size,
  signing: process.platform === "darwin" ? "local ad-hoc" : null,
  builtAt: new Date().toISOString(), useSnapshot: false, useCodeCache: false,
}, null, 2) + "\n");
console.log(`Built ${output}`);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
