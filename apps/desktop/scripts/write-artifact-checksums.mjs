import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const bundleRoot = join(desktopRoot, "src-tauri", "target", "release", "bundle");
const checksumTextPath = join(bundleRoot, "SHA256SUMS.txt");
const checksumJsonPath = join(bundleRoot, "SHA256SUMS.json");
const ignored = new Set(["SHA256SUMS.txt", "SHA256SUMS.json"]);

const files = listFiles(bundleRoot)
  .filter((file) => !ignored.has(relative(bundleRoot, file).replaceAll(sep, "/")))
  .sort((left, right) => left.localeCompare(right));

if (files.length === 0) {
  throw new Error(`No desktop artifacts found under ${bundleRoot}`);
}

const checksums = files.map((file) => {
  const relativePath = relative(bundleRoot, file).replaceAll(sep, "/");
  return {
    path: relativePath,
    sha256: createHash("sha256").update(readdirSafe(file)).digest("hex"),
  };
});

mkdirSync(bundleRoot, { recursive: true });
writeFileSync(checksumTextPath, checksums.map((entry) => `${entry.sha256}  ${entry.path}`).join("\n") + "\n");
writeFileSync(checksumJsonPath, JSON.stringify({ algorithm: "sha256", files: checksums }, null, 2) + "\n");

console.log(`Wrote ${checksums.length} artifact checksums to ${checksumTextPath}`);

function listFiles(root) {
  const result = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      result.push(...listFiles(path));
      continue;
    }
    if (entry.isFile()) result.push(path);
  }
  return result;
}

function readdirSafe(file) {
  if (!statSync(file).isFile()) {
    throw new Error(`Expected a file artifact, got ${file}`);
  }
  return readFileSync(file);
}
