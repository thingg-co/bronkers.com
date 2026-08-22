import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The runtime measurement: a hash over the runtime's own source bundle
 * (agent/src/**, package.json, package-lock.json), sorted by path. It is what
 * a reproducible build would produce and what a TEE would attest to; today it
 * is self-reported to the RuntimeRegistry and labelled as such.
 */
export function measureRuntime(root = new URL("..", import.meta.url).pathname): `0x${string}` {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts")) files.push(p);
    }
  };
  walk(join(root, "src"));
  for (const f of ["package.json", "package-lock.json"]) files.push(join(root, f));
  const h = createHash("sha256");
  for (const f of files) {
    h.update(f.slice(root.length));
    h.update("\0");
    h.update(readFileSync(f));
    h.update("\0");
  }
  return `0x${h.digest("hex")}`;
}
