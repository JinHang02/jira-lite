// Runs browser_e2e.js headless with Playwright against a fresh mock Jira + jira-lite (never the
// real Jira): starts `mock_jira.py --app-port`, runs the checks, prints the report, exits 1 on
// any failure.
//
//   node tests/e2e/run_browser.mjs            (ports 9900 / 8900, which browser_e2e.js expects)
//   E2E_HEADED=1 / E2E_VERBOSE=1 (server logs) / E2E_LATENCY_MS=150 node tests/e2e/run_browser.mjs
//   E2E_ONLY=<regex> (only matching checks) / E2E_SHOTS=<dir> (screenshot every failure): see browser_e2e.js
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch (e) {
  console.error("Playwright isn't installed (npm i -g playwright, or run browser_e2e.js through the Playwright MCP).");
  process.exit(2);
}

const latency = process.env.E2E_LATENCY_MS ? ["--latency-ms", process.env.E2E_LATENCY_MS] : [];  // slow every mock response
const mock = spawn("python3", [join(here, "mock_jira.py"), "--port", "9900", "--app-port", "8900", ...latency], { cwd: join(here, "..", ".."), stdio: ["ignore", "pipe", process.env.E2E_VERBOSE ? "inherit" : "ignore"] });
const ready = new Promise((resolve, reject) => {
  let seen = "";
  mock.stdout.on("data", (b) => { seen += b; if (seen.includes("jira-lite on")) resolve(); });
  mock.on("exit", (code) => reject(new Error("mock_jira.py exited with " + code)));
});

let code = 1;
let browser;
try {
  await ready;
  browser = await chromium.launch({ headless: !process.env.E2E_HEADED });
  const page = await browser.newPage();
  const run = (0, eval)(readFileSync(join(here, "browser_e2e.js"), "utf8"));  // the file is one `async (page) => {...}`
  const report = await run(page);
  console.log(report);
  code = /^ALL PASSED/.test(report) ? 0 : 1;
} catch (e) {
  console.error(e);
} finally {
  if (browser) await browser.close();
  mock.kill();
}
process.exit(code);
