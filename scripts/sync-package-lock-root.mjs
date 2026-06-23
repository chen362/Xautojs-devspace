#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const packageJsonPath = resolve(root, "package.json");
const packageLockPath = resolve(root, "package-lock.json");

const packageJson = readJson(packageJsonPath);
const packageLock = readJson(packageLockPath);
let changed = false;

changed = set(packageLock, "name", packageJson.name) || changed;
changed = set(packageLock, "version", packageJson.version) || changed;

packageLock.packages ??= {};
packageLock.packages[""] ??= {};
const rootPackage = packageLock.packages[""];

changed = set(rootPackage, "name", packageJson.name) || changed;
changed = set(rootPackage, "version", packageJson.version) || changed;
changed = set(rootPackage, "license", packageJson.license) || changed;
changed = setJson(rootPackage, "bin", packageJson.bin) || changed;
changed = setJson(rootPackage, "engines", packageJson.engines) || changed;

if (changed) {
  writeFileSync(packageLockPath, `${JSON.stringify(packageLock, null, 2)}\n`);
  console.log("Synced package-lock.json root metadata from package.json.");
} else {
  console.log("package-lock.json root metadata is already in sync.");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function set(target, key, value) {
  if (target[key] === value) return false;
  target[key] = value;
  return true;
}

function setJson(target, key, value) {
  if (JSON.stringify(target[key]) === JSON.stringify(value)) return false;
  target[key] = value;
  return true;
}
