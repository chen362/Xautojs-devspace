#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const EXPECTED_PACKAGE_NAME = "xautojs-devspace";
const EXPECTED_CLI_BIN = "devspace";
const EXPECTED_CLI_TARGET = "dist/cli.js";
const EXPECTED_REPOSITORY = "chen362/Xautojs-devspace";
const REQUIRED_FILES = ["dist", "docs", "examples", "migrations", "scripts", "README.md", "README-cn.md"];

const root = resolve(new URL("..", import.meta.url).pathname);
const packageJson = readJson(resolve(root, "package.json"));
const packageLock = readJson(resolve(root, "package-lock.json"));
const failures = [];

expect(packageJson.name === EXPECTED_PACKAGE_NAME, `package.json name must be ${EXPECTED_PACKAGE_NAME}.`);
expect(packageJson.bin?.[EXPECTED_CLI_BIN] === EXPECTED_CLI_TARGET, `package.json bin.${EXPECTED_CLI_BIN} must point to ${EXPECTED_CLI_TARGET}.`);
expect(packageJson.publishConfig?.access === "public", "package.json publishConfig.access must be public.");
expect(String(packageJson.repository?.url ?? "").includes(EXPECTED_REPOSITORY), `package.json repository must point to ${EXPECTED_REPOSITORY}.`);
expect(String(packageJson.homepage ?? "").includes(EXPECTED_REPOSITORY), `package.json homepage must point to ${EXPECTED_REPOSITORY}.`);
expect(String(packageJson.bugs?.url ?? "").includes(EXPECTED_REPOSITORY), `package.json bugs.url must point to ${EXPECTED_REPOSITORY}.`);

for (const entry of REQUIRED_FILES) {
  expect(packageJson.files?.includes(entry), `package.json files must include ${entry}.`);
}

expect(packageLock.name === packageJson.name, "package-lock.json top-level name must match package.json name.");
expect(packageLock.version === packageJson.version, "package-lock.json top-level version must match package.json version.");
expect(packageLock.packages?.[""]?.name === packageJson.name, "package-lock.json packages[\"\"].name must match package.json name.");
expect(packageLock.packages?.[""]?.version === packageJson.version, "package-lock.json packages[\"\"].version must match package.json version.");
expect(packageLock.packages?.[""]?.bin?.[EXPECTED_CLI_BIN] === EXPECTED_CLI_TARGET, `package-lock.json packages[\"\"].bin.${EXPECTED_CLI_BIN} must point to ${EXPECTED_CLI_TARGET}.`);
expect(!JSON.stringify({ packageJson, rootLock: packageLock.packages?.[""] }).includes("@waishnav/devspace"), "Release-facing package metadata must not contain @waishnav/devspace.");

if (failures.length > 0) {
  console.error("Release packaging check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Release packaging check passed for ${packageJson.name}@${packageJson.version}.`);

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function expect(condition, message) {
  if (!condition) failures.push(message);
}
