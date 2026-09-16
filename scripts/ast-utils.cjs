"use strict";
const crypto = require("node:crypto");
const acorn = require("acorn");

function staticMemberName(node) {
  if (node?.type !== "MemberExpression") return null;
  if (!node.computed && node.property.type === "Identifier") return node.property.name;
  if (node.computed && node.property.type === "Literal" && typeof node.property.value === "string")
    return node.property.value;
  return null;
}

function fingerprintSource(source) {
  const ast = acorn.parse(source, { ecmaVersion: "latest", sourceType: "script" });
  const hash = crypto.createHash("sha256");
  const stack = [ast];
  while (stack.length) {
    let value = stack.pop();
    if (value?.type === "LogicalExpression") {
      const operands = [], pending = [value];
      while (pending.length) {
        const part = pending.pop();
        if (part.type === "LogicalExpression" && part.operator === value.operator)
          pending.push(part.right, part.left);
        else operands.push(part);
      }
      value = { type: "LogicalChain", operator: value.operator, operands };
    }
    if (["Property", "MethodDefinition", "PropertyDefinition"].includes(value?.type) &&
        !value.computed && ["Identifier", "Literal"].includes(value.key?.type))
      value = { ...value, key: { type: "StaticPropertyKey", value: String(value.key.name ?? value.key.value) } };
    if (value?.type === "Literal" && value.regex)
      value = { ...value, regex: { ...value.regex, flags: [...value.regex.flags].sort().join("") } };
    if (Array.isArray(value)) {
      hash.update(`array:${value.length};`);
      for (let i = value.length - 1; i >= 0; i--) stack.push(value[i]);
    } else if (value && typeof value === "object" && !(value instanceof RegExp)) {
      const keys = Object.keys(value).filter((key) => !["start", "end", "loc"].includes(key) && !(key === "raw" && value.type === "Literal")).sort();
      hash.update(`object:${keys.length};`);
      for (let i = keys.length - 1; i >= 0; i--) { stack.push(value[keys[i]]); stack.push(keys[i]); }
    } else {
      const text = value instanceof RegExp ? value.toString() : String(value);
      hash.update(`${typeof value}:${Buffer.byteLength(text)}:${text};`);
    }
  }
  return hash.digest("hex");
}

module.exports = { staticMemberName, fingerprintSource };
