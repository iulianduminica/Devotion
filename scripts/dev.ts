/**
 * Dev runner: API on :8790 + vite on :5175 (which proxies /api and /media).
 *
 * stdio is inherited, not piped: on Windows under a restricted sandbox,
 * capturing a child's stdout through a pipe fails with EPERM, while inherit
 * works. That is a deliberate choice, not an oversight.
 */

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "node_modules", ".bin");
const isWin = process.platform === "win32";

interface Child {
  kill: () => void;
}

const children: Child[] = [];

function run(cmd: string, args: string[], label: string): void {
  const exe = isWin ? join(BIN, `${cmd}.cmd`) : join(BIN, cmd);
  const child = spawn(exe, args, { cwd: ROOT, stdio: "inherit", env: process.env, shell: isWin });

  child.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      console.error(`[${label}] exited with code ${code}`);
      shutdown(code);
    }
  });

  children.push({ kill: () => child.kill("SIGTERM") });
}

function shutdown(code = 0): void {
  for (const c of children) {
    try {
      c.kill();
    } catch {
      // already gone
    }
  }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

run("tsx", ["watch", "server/index.ts"], "api");
run("vite", [], "web");

console.log("\n  Devotion dev\n  app: http://127.0.0.1:5175\n  api: http://127.0.0.1:8790\n");
