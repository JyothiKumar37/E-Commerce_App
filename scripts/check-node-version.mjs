#!/usr/bin/env node
/**
 * Warns (never fails) when the local Node major differs from the one the
 * Docker images use. A mismatch is the usual cause of "works on my machine".
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

try {
  const expected = (await readFile(join(root, ".nvmrc"), "utf8")).trim();
  const expectedMajor = Number(expected.split(".")[0]);
  const actualMajor = Number(process.versions.node.split(".")[0]);

  if (actualMajor !== expectedMajor) {
    console.warn(
      `\n  Node ${process.versions.node} detected; this project targets ${expected} ` +
        `(see .nvmrc). Behaviour may differ from CI and the Docker images.\n`,
    );
  }
} catch {
  // .nvmrc missing or unreadable is not worth failing an install over.
}
