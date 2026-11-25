/**
 * Boot check: start the real server, hit it over HTTP, shut it down.
 *
 * The suites use Fastify's in-process `inject()`, which is fast and needs no
 * port — and which therefore never exercises the listen path, the static shell,
 * the token injection, or Node's TypeScript handling. This script does, on
 * whatever machine runs it, which is the point: it is the test that says "this
 * starts on Linux/macOS/Windows" instead of asserting it in a README.
 *
 * Plain JavaScript on purpose: Node's type stripping applies to .ts files, so a
 * .mjs script must not carry annotations.
 *
 * Usage: node scripts/boot-check.mjs [--port 8123]
 */

import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");

const argOf = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const port = Number(argOf("--port", "8123"));
// A caller-supplied workspace is booted as-is and never deleted: CI seeds the
// demo workspace and then boots exactly that, which is the closest thing to
// "a person cloned this and ran it".
const given = argOf("--workspace", "");
const workspace = given ? join(root, given) : join(root, ".data", "boot-check");
const ownsWorkspace = !given;

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  console.error(`bad --port: ${port}`);
  process.exit(2);
}

if (ownsWorkspace) rmSync(workspace, { recursive: true, force: true });

const child = spawn(process.execPath, ["server/index.ts", "--port", String(port), "--workspace", workspace], {
  cwd: root,
  env: { ...process.env, DEVOTION_HOST: "127.0.0.1" },
  stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
child.stdout.on("data", (c) => (output += c.toString()));
child.stderr.on("data", (c) => (output += c.toString()));

const stop = () => {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  // Close the pipes before exiting. Calling process.exit() with a child's
  // stdio handles still open trips a libuv assertion on Windows
  // (`UV_HANDLE_CLOSING` in src/win/async.c) and the run dies with exit 1
  // after printing success — which is the worst kind of test failure.
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref();
};

/**
 * Windows keeps an open SQLite file locked a moment after the process dies, so
 * a delete can fail with EBUSY. The temp workspace is disposable; failing the
 * check over it would be worse than leaving it behind.
 */
const cleanup = () => {
  if (!ownsWorkspace) return;
  try {
    rmSync(workspace, { recursive: true, force: true });
  } catch {
    /* left behind, harmless */
  }
};

const deadline = Date.now() + 30_000;
let lastError = "";

while (Date.now() < deadline) {
  try {
    // The shell is the thing a browser loads first, and the session token is
    // injected into it: read the token from there, so this proves the injection
    // works rather than assuming it.
    const shell = await fetch(`http://127.0.0.1:${port}/`);
    const html = await shell.text();
    if (!html.includes('id="root"')) throw new Error("the shell did not render its root element");

    const match = html.match(/__STRATA_TOKEN__\s*=\s*"([^"]+)"/);
    if (!match) throw new Error("the session token was not injected into the shell");
    const token = match[1];

    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { "x-strata-token": token } });
    if (!res.ok) throw new Error(`authenticated /api/health → HTTP ${res.status}`);
    const health = await res.json();

    const anon = await fetch(`http://127.0.0.1:${port}/api/nodes/anything`);
    if (anon.status !== 401) throw new Error(`an unauthenticated request got ${anon.status}, expected 401`);

    const minNodes = Number(argOf("--min-nodes", "0"));
    if (health.nodes < minNodes) {
      throw new Error(`expected at least ${minNodes} nodes, the workspace has ${health.nodes}`);
    }

    console.log("boot check ok");
    console.log(`  node ${process.versions.node} · sqlite ${health.sqlite} · ${health.nodes} nodes · ${health.ops} ops`);
    console.log(`  shell ${(html.length / 1024).toFixed(1)} KB · token injected · auth enforced`);
    stop();
    cleanup();
    // Set the code and let the loop drain: no abrupt exit, no assertion.
    process.exitCode = 0;
    break;
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 400));
  }
}

if (process.exitCode === 0) {
  // success path already printed
} else {
  console.error(`boot check FAILED: ${lastError}`);
  console.error(output.slice(-2000));
  stop();
  cleanup();
  process.exitCode = 1;
}
