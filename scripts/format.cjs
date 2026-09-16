#!/usr/bin/env node
"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const prettier = require("prettier");

(async () => {
  const root = path.resolve(__dirname, "..");
  const destination = path.join(root, "src/ob1.cjs");
  if (await fs.stat(destination).then(() => true, () => false)) {
    throw new Error("src/ob1.cjs already exists; refusing to overwrite maintenance edits.");
  }
  const source = await fs.readFile(path.join(root, "recovered/ob1.bundle.cjs"), "utf8");
  const formatted = await prettier.format(source, {
    parser: "babel", printWidth: 100, endOfLine: "lf",
  });
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, formatted, { flag: "wx" });
  console.log(`Recovered editable source: ${destination} (${formatted.split("\n").length} lines)`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
