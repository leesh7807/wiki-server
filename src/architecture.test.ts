import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const srcRoot = path.dirname(fileURLToPath(import.meta.url));
const allowedDependencies: Record<string, Set<string>> = {
  config: new Set(["config", "jobs"]),
  http: new Set(["http", "jobs"]),
  jobs: new Set(["jobs"]),
  retrieval: new Set(["jobs", "retrieval"]),
  runners: new Set(["jobs", "runners"]),
};

test("runtime modules stay grouped under documented domains", () => {
  const rootRuntimeModules = readdirSync(srcRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));

  assert.deepEqual(rootRuntimeModules, ["server.ts"]);
});

test("domain imports follow the documented dependency direction", () => {
  for (const [domain, allowed] of Object.entries(allowedDependencies)) {
    const domainRoot = path.join(srcRoot, domain);
    for (const file of readdirSync(domainRoot, { withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith(".ts")) continue;
      const filePath = path.join(domainRoot, file.name);
      const source = readFileSync(filePath, "utf8");
      for (const specifier of relativeImportSpecifiers(source)) {
        const target = path.resolve(path.dirname(filePath), specifier);
        const relativeTarget = path.relative(srcRoot, target);
        const targetDomain = relativeTarget.split(path.sep)[0];
        assert.equal(
          allowed.has(targetDomain),
          true,
          `${path.relative(srcRoot, filePath)} must not import ${relativeTarget}`,
        );
      }
    }
  }
});

function relativeImportSpecifiers(source: string) {
  return [...source.matchAll(/\bfrom\s+["'](\.[^"']+)["']/g)].map((match) => match[1]);
}
