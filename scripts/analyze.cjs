#!/usr/bin/env node
"use strict";
// Static inspection only. The recovered program is never evaluated here.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { builtinModules } = require("node:module");
const acorn = require("acorn");
const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "src/ob1.cjs"), "utf8");
const ast = acorn.parse(source, { ecmaVersion: "latest", sourceType: "script", locations: true });
const report = (name, data) => fs.writeFileSync(path.join(root, "reports", name + ".json"), JSON.stringify(data, null, 2) + "\n");
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const keyOf = (n) => n?.name ?? (typeof n?.value === "string" ? n.value : null);
const labelOf = (n, parent) =>
  (parent?.type === "VariableDeclarator" ? parent.id.name :
    parent?.type === "AssignmentExpression" ? source.slice(parent.left.start, parent.left.end) : null) ?? n.id?.name;
const where = (n) => ({ line: n.loc.start.line, endLine: n.loc.end.line });
const units = [], bindings = [], calls = [], env = new Map(), requires = new Map();
const packages = [], classes = [], assets = [], texts = [], urls = new Map(), aliases = [];
const dynamicRequires = [];
const assetDir = path.join(root, "recovered/assets");
const textDir = path.join(root, "recovered/text");
fs.mkdirSync(assetDir, { recursive: true });
fs.mkdirSync(textDir, { recursive: true });
for (const n of ast.body) {
  if (n.type === "FunctionDeclaration") bindings.push({ name: n.id.name, kind: "function", ...where(n) });
  if (n.type === "VariableDeclaration") for (const d of n.declarations) {
    if (d.id.type === "Identifier") bindings.push({ name: d.id.name, kind: "variable", ...where(d) });
    if (d.init?.type === "CallExpression" && ["B", "x"].includes(d.init.callee.name))
      units.push({ name: d.id.name, kind: d.init.callee.name === "B" ? "esm-initializer" : "commonjs-wrapper", ...where(d), start: d.start, end: d.end, dependencies: [] });
  }
}
const unitNames = new Set(units.map((n) => n.name));
const unitByStart = new Map(units.map((n) => [n.start, n]));
const stack = [[ast, null, null]];
while (stack.length) {
  const [n, parent, inherited] = stack.pop();
  const unit = unitByStart.get(n.start) ?? inherited;
  if (n.type === "CallExpression") {
    if (n.callee.name === "du" && n.arguments[1]?.type === "ObjectExpression") {
      for (const p of n.arguments[1].properties) {
        if (p.type === "Property" && p.value?.type === "ArrowFunctionExpression" && p.value.body.type === "Identifier")
          aliases.push({ exportedName: keyOf(p.key), symbol: p.value.body.name,
            namespace: n.arguments[0]?.name, line: p.loc.start.line });
      }
    }
    if (n.callee.type === "Identifier" && unitNames.has(n.callee.name) && unit)
      unit.dependencies.push(n.callee.name);
    if (n.callee.type === "Identifier" && n.callee.name === "require") {
      const arg = n.arguments[0];
      if (arg?.type === "Literal" && typeof arg.value === "string") {
        if (!requires.has(arg.value)) requires.set(arg.value, []);
        requires.get(arg.value).push(n.loc.start.line);
      } else dynamicRequires.push({ expression: source.slice(n.start, n.end).slice(0, 200), ...where(n) });
    }
    if (n.callee.name === "pot" && typeof n.arguments[0]?.value === "string") {
      const content = Buffer.from(n.arguments[0].value, "base64");
      const isWasm = content.subarray(0, 4).equals(Buffer.from([0, 97, 115, 109]));
      const name = `${unit?.name ?? "asset"}-${n.loc.start.line}.${isWasm ? "wasm" : "bin"}`;
      fs.writeFileSync(path.join(assetDir, name), content);
      assets.push({ file: `recovered/assets/${name}`, owner: unit?.name, size: content.length, sha256: hash(content), wasmValid: isWasm ? WebAssembly.validate(content) : null, ...where(n) });
    }
  }
  if (n.type === "MemberExpression" && n.object?.type === "MemberExpression" &&
      n.object.object?.name === "process" && keyOf(n.object.property) === "env") {
    const name = keyOf(n.property);
    if (name) { if (!env.has(name)) env.set(name, []); env.get(name).push(n.loc.start.line); }
  }
  if (n.type === "ObjectExpression") {
    const fields = new Map(n.properties.filter((p) => p.type === "Property" && p.value?.type === "Literal").map((p) => [keyOf(p.key), p.value.value]));
    if (typeof fields.get("name") === "string" && typeof fields.get("version") === "string")
      packages.push({ name: fields.get("name"), version: fields.get("version"), license: fields.get("license") ?? null, evidence: "embedded object literal, not a complete dependency lockfile", ...where(n) });
  }
  if (n.type === "ClassDeclaration" || n.type === "ClassExpression") {
    classes.push({ name: labelOf(n, parent), owner: unit?.name, ...where(n),
      methods: n.body.body.map((m) => ({ name: keyOf(m.key), static: !!m.static, line: m.loc.start.line,
        ...(m.type === "PropertyDefinition" && m.static ? { value: m.value ? source.slice(m.value.start, m.value.end).slice(0, 140) : null } : {}) })) });
  }
  if ((n.type === "Literal" && typeof n.value === "string") || n.type === "TemplateLiteral") {
    const value = n.type === "Literal" ? n.value : n.quasis.map((q, i) => (q.value.cooked ?? q.value.raw) +
      (i < n.expressions.length ? "${" + source.slice(n.expressions[i].start, n.expressions[i].end) + "}" : "")).join("");
    if (value.length < 4000 && /^https?:\/\/[^\s]+$/.test(value)) {
      try {
        const url = new URL(value);
        const key = url.origin + url.pathname; // Omit credentials and query strings from the index.
        if (!urls.has(key)) urls.set(key, []);
        urls.get(key).push(n.loc.start.line);
      } catch {}
    }
    if (value.length >= 800 && value.length <= 1000000 && value.includes("\n")) {
      const owner = labelOf(n, parent) ?? unit?.name ?? "text";
      const name = `${n.loc.start.line}-${owner.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 60)}.${n.type === "TemplateLiteral" && n.expressions.length ? "template.txt" : "txt"}`;
      fs.writeFileSync(path.join(textDir, name), value);
      texts.push({ file: `recovered/text/${name}`, owner, length: value.length,
        interpolated: n.type === "TemplateLiteral" && n.expressions.length > 0, preview: value.trim().split("\n")[0].slice(0, 120), ...where(n) });
    }
  }
  const children = [];
  for (const [key, value] of Object.entries(n)) {
    if (["start", "end", "loc", "raw"].includes(key)) continue;
    if (Array.isArray(value)) { for (const child of value) if (child?.type) children.push(child); }
    else if (value?.type) children.push(value);
  }
  for (let i = children.length - 1; i >= 0; i--) stack.push([children[i], n, unit]);
}
for (const unit of units) { unit.dependencies = [...new Set(unit.dependencies)].sort(); delete unit.start; delete unit.end; }
const builtin = new Set(builtinModules.flatMap((n) => [n, n.startsWith("node:") ? n : "node:" + n]));
report("module-index", units);
report("symbols", bindings);
report("classes", classes);
report("environment", [...env].sort().map(([name, lines]) => ({ name, lines: [...new Set(lines)] })));
report("requires", { literal: [...requires].sort().map(([name, lines]) => ({ name, builtin: builtin.has(name), lines })), dynamic: dynamicRequires });
report("embedded-packages", packages);
report("export-aliases", aliases);
report("endpoints", [...urls].sort().map(([url, lines]) => ({ url, lines })));
report("assets", assets);
report("text-resources", texts);
const summary = { sourceSha256: hash(source), lines: source.split("\n").length,
  topLevelBindings: bindings.length, bundledModuleWrappers: units.length,
  classDefinitions: classes.length, environmentVariables: env.size, embeddedPackageRecords: packages.length, exportAliases: aliases.length,
  embeddedBinaryAssets: assets.length, textResources: texts.length,
  sourceMaps: false, originalTypescriptRecovered: false };
report("analysis-summary", summary);
console.log(JSON.stringify(summary, null, 2));
