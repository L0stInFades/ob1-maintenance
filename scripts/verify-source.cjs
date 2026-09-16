#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const acorn = require("acorn");
const root = path.resolve(__dirname, "..");
function fingerprint(file) {
  const ast = acorn.parse(fs.readFileSync(path.join(root, file), "utf8"), {
    ecmaVersion: "latest", sourceType: "script",
  });
  const hash = crypto.createHash("sha256");
  // Preserve every semantic AST field while ignoring formatting and locations.
  const stack = [ast];
  while (stack.length) {
    let value = stack.pop();
    if (value?.type === "LogicalExpression") {
      // Formatting removes parentheses around associative && / || expressions.
      // Preserve operand order; never reassociate arithmetic or mixed operators.
      const operands = [];
      const pending = [value];
      while (pending.length) {
        const part = pending.pop();
        if (part.type === "LogicalExpression" && part.operator === value.operator)
          pending.push(part.right, part.left);
        else operands.push(part);
      }
      value = { type: "LogicalChain", operator: value.operator, operands };
    }
    if (["Property", "MethodDefinition", "PropertyDefinition"].includes(value?.type) &&
        !value.computed && ["Identifier", "Literal"].includes(value.key?.type)) {
      value = { ...value, key: { type: "StaticPropertyKey", value: String(value.key.name ?? value.key.value) } };
    }
    if (value?.type === "Literal" && value.regex)
      value = { ...value, regex: { ...value.regex, flags: [...value.regex.flags].sort().join("") } };
    if (Array.isArray(value)) {
      hash.update(`array:${value.length};`);
      for (let i = value.length - 1; i >= 0; i--) stack.push(value[i]);
    } else if (value && typeof value === "object" && !(value instanceof RegExp)) {
      const keys = Object.keys(value).filter((k) => !["start", "end", "loc"].includes(k) && !(k === "raw" && value.type === "Literal")).sort();
      hash.update(`object:${keys.length};`);
      for (let i = keys.length - 1; i >= 0; i--) { stack.push(value[keys[i]]); stack.push(keys[i]); }
    } else {
      const text = value instanceof RegExp ? value.toString() : String(value);
      hash.update(`${typeof value}:${Buffer.byteLength(text)}:${text};`);
    }
  }
  return hash.digest("hex");
}
const extracted = fingerprint("recovered/ob1.bundle.cjs");
if (global.gc) global.gc();
const readable = fingerprint("src/ob1.cjs");
const result = { extractedAstSha256: extracted, readableAstSha256: readable,
  equal: extracted === readable, parser: `acorn ${acorn.version}`,
  normalizations: ["source positions", "literal spelling", "noncomputed property key spelling", "same-operator logical association with operand order preserved", "regular expression flag order"],
  note: "Normalized AST comparison checks the initial formatting pass. Future maintenance changes should intentionally differ." };
fs.writeFileSync(path.join(root, "reports/source-equivalence.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
if (!result.equal) process.exitCode = 1;
