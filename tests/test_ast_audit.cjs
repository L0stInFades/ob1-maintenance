"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const acorn = require("acorn");
const { fingerprintSource: fingerprint, staticMemberName } = require("../scripts/ast-utils.cjs");

for (const [name, left, right] of [
  ["whitespace", "const x=1;", "const x = 1;\n"],
  ["same-operator logical grouping", "a&&(b&&c)", "(a&&b)&&c"],
  ["static property spelling", "({a:1})", '({"a":1})'],
  ["regex flag order", "/foo/ig", "/foo/gi"],
]) test(`equivalent control: ${name}`, () => assert.equal(fingerprint(left), fingerprint(right)));

for (const [name, left, right] of [
  ["changed literal", "const x=1", "const x=2"],
  ["deleted function body", "function f(){return 1}", "function f(){}"],
  ["changed operator", "a&&b", "a||b"],
  ["reordered side effects", "a()&&b()", "b()&&a()"],
  ["arithmetic grouping", "a+(b+c)", "(a+b)+c"],
  ["changed template escape", "String.raw`a\\nb`", "String.raw`a\\\\nb`"],
  ["strict directive", 'function f(){"use strict"; return this}', "function f(){return this}"],
  ["computed property", "({[a]:1})", "({a:1})"],
  ["request argument order", "send(url,body)", "send(body,url)"],
  ["changed regex flags", "/foo/i", "/foo/g"],
]) test(`mutation must be detected: ${name}`, () => assert.notEqual(fingerprint(left), fingerprint(right)));

test("environment key extraction distinguishes literal names from dynamic bindings", () => {
  const member = (code) => acorn.parse(code, { ecmaVersion: "latest" }).body[0].expression;
  assert.equal(staticMemberName(member("process.env.OB1_API_KEY")), "OB1_API_KEY");
  assert.equal(staticMemberName(member('process.env["OB1_API_KEY"]')), "OB1_API_KEY");
  assert.equal(staticMemberName(member("process.env[r]")), null);
  assert.equal(staticMemberName(member("process.env[keys.openai]")), null);
  assert.equal(staticMemberName(member("process[env].OB1_API_KEY").object), null);
});
