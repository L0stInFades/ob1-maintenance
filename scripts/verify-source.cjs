#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const acorn = require("acorn");
const { fingerprintSource } = require("./ast-utils.cjs");
const root = path.resolve(__dirname, "..");
function fingerprint(file) {
  return fingerprintSource(fs.readFileSync(path.join(root, file), "utf8"));
}
const extracted = fingerprint("recovered/ob1.bundle.cjs");
if (global.gc) global.gc();
const readable = fingerprint("src/ob1.cjs");
const result = { extractedAstSha256: extracted, readableAstSha256: readable,
  extractedFileSha256: crypto.createHash("sha256").update(fs.readFileSync(path.join(root, "recovered/ob1.bundle.cjs"))).digest("hex"),
  readableFileSha256: crypto.createHash("sha256").update(fs.readFileSync(path.join(root, "src/ob1.cjs"))).digest("hex"),
  checkedAt: new Date().toISOString(),
  equal: extracted === readable, parser: `acorn ${acorn.version}`,
  normalizations: ["source positions", "literal spelling", "noncomputed property key spelling", "same-operator logical association with operand order preserved", "regular expression flag order"],
  note: "Structural equivalence of the formatting pass; does not claim identical stack locations or Function.prototype.toString() output." };
fs.writeFileSync(path.join(root, "reports/source-equivalence.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
if (!result.equal) process.exitCode = 1;
