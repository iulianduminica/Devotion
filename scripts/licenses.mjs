/**
 * Print every installed package and its license.
 *
 * Reads the `license` field from each package.json in node_modules, falling
 * back to the LICENSE file name when a package declares no field. Used by
 * THIRD-PARTY-NOTICES.md, so the list can be regenerated rather than hand-kept.
 *
 * Usage: node scripts/licenses.mjs [--direct]
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const modules = join(root, "node_modules");
const directOnly = process.argv.includes("--direct");

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const direct = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]);

/** Every package directory, descending into @scoped groups. */
function packageDirs(dir, prefix = "") {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    if (entry.name.startsWith("@") && !prefix) {
      out.push(...packageDirs(join(dir, entry.name), `${entry.name}/`));
      continue;
    }
    out.push(prefix + entry.name);
  }
  return out;
}

function licenseOf(name) {
  const file = join(modules, name, "package.json");
  if (!existsSync(file)) return "unknown";
  try {
    const json = JSON.parse(readFileSync(file, "utf8"));
    const lic = json.license;
    if (typeof lic === "string") return lic;
    if (lic && typeof lic === "object") return String(lic.type ?? "unknown");
    // pre-SPDX convention: a LICENSE file, no field
    for (const candidate of ["LICENSE", "LICENSE.md", "license"]) {
      if (existsSync(join(modules, name, candidate))) return "(see LICENSE file)";
    }
    return "unknown";
  } catch {
    return "unreadable";
  }
}

const names = packageDirs(modules).filter((n) => !n.includes("node_modules"));
const rows = (directOnly ? names.filter((n) => direct.has(n)) : names)
  .map((n) => ({ name: n, license: licenseOf(n) }))
  .sort((a, b) => a.name.localeCompare(b.name));

const width = Math.max(...rows.map((r) => r.name.length), 4);
console.log(`${"package".padEnd(width)}  license`);
console.log(`${"-".repeat(width)}  -------`);
for (const r of rows) console.log(`${r.name.padEnd(width)}  ${r.license}`);

const counts = new Map();
for (const r of rows) counts.set(r.license, (counts.get(r.license) ?? 0) + 1);
console.log(`\n${rows.length} packages`);
for (const [lic, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${lic}`);
}
