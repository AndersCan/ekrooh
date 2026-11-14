#!/usr/bin/env node
/**
 * Two devices vote: starts two copies of the vote starter, joins the second to
 * the first by invite code, votes once on each and passes only when both show
 * Tea (1), Coffee (1), Water (0). CI runs it in the Starter / web job; by hand:
 * `node .github/scripts/starter-vote-journey.mjs <fresh starter copy>` after
 * `npm ci` at the repo root and in the copy. It reads the starter's visible
 * text (button names, status line, Join box label): renaming those means
 * updating this file.
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

// Budgets in seconds. Every wait is on what the pages show, never a sleep.
const START = 60;
const READY = 60;
const ANNOUNCED = 30;
const JOIN = 15;
const CONNECTED = 120;
const VOTE = 15;
const SYNCED = 30;
const OVERALL = 345; // the budgets above add up to 330 s
const KILL_GRACE_MS = 5000;
const LOG_LINES = 60;

const ports = { a: 5173, b: 5174 };

function usage(message) {
  console.error(message);
  process.exit(2);
}

const dir = process.argv[2];
if (!dir || !fs.existsSync(path.join(dir, "package.json"))) {
  usage("usage: node .github/scripts/starter-vote-journey.mjs <starter-dir>");
}
if (fs.existsSync(path.join(dir, ".dev-storage"))) {
  usage(
    `${dir}/.dev-storage exists: the journey needs fresh devices; use a fresh copy of the starter`,
  );
}

process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(
  root,
  ".playwright-browsers",
);
let chromium;
try {
  ({ chromium } = await import("@playwright/test"));
} catch {
  usage("Playwright not found: run npm ci at the repo root");
}
let Hyperswarm;
try {
  ({ default: Hyperswarm } = await import("hyperswarm"));
} catch {
  usage("hyperswarm not found: run npm ci at the repo root");
}
// Before any server starts, so a missing browser is a usage error.
let browser;
try {
  browser = await chromium.launch();
} catch {
  usage("Chromium not installed: run npm run playwright:install");
}

const startedAt = Date.now();
const seconds = () => Math.round((Date.now() - startedAt) / 1000);
let stage;
let wanted;
let stageStartedAt;

function begin(name, what) {
  stage = name;
  wanted = what;
  stageStartedAt = Date.now();
}

function passed() {
  const took = Math.round((Date.now() - stageStartedAt) / 1000);
  console.log(`ok ${stage} (${took} s)`);
}

// Runs the dev script directly: npm does not pass SIGTERM on to it, which
// would leave the dev server and Bare running after the journey.
function startServer(args) {
  const lines = [];
  const child = spawn("node", ["scripts/dev.mjs", ...args], {
    cwd: dir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const state = { child, lines, exited: null, ready: false };
  for (const stream of [child.stdout, child.stderr]) {
    readline.createInterface({ input: stream }).on("line", (line) => {
      lines.push(line);
      if (line.includes("vote ready:")) state.ready = true;
    });
  }
  child.on("exit", (code, signal) => {
    state.exited = `exit code ${code ?? signal}`;
  });
  return state;
}

async function stopServer(server) {
  if (server.exited) return;
  const done = new Promise((resolve) => server.child.once("exit", resolve));
  server.child.kill("SIGTERM");
  // Kill timer: gives the dev server a moment to stop Bare, then forces it.
  const timer = setTimeout(() => server.child.kill("SIGKILL"), KILL_GRACE_MS);
  await done;
  clearTimeout(timer);
}

async function until(check, budget) {
  const deadline = Date.now() + budget * 1000;
  while (Date.now() < deadline) {
    if (await check()) return true;
    // Gap between two checks of what the pages show; not a wait for a result.
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function roomFound(room) {
  const swarm = new Hyperswarm();
  swarm.on("error", () => {});
  try {
    const topic = crypto
      .createHash("sha256")
      .update(`ekrooh/sync/v1\n${room}`)
      .digest();
    const deadline = Date.now() + ANNOUNCED * 1000;
    while (Date.now() < deadline) {
      for await (const result of swarm.dht.lookup(topic)) {
        if (result.peers.length > 0) return true;
      }
    }
    return false;
  } finally {
    await swarm.destroy();
  }
}

const servers = { a: startServer([]), b: startServer(["--second"]) };
let pages = null;
const pageErrors = [];

async function pageText(page) {
  try {
    const text = await page.locator("#app").innerText({ timeout: 2000 });
    return text.replace(/\s*\n\s*/g, " | ");
  } catch {
    return "(page not readable)";
  }
}

async function fail() {
  const failedStage = stage;
  const a = pages ? await pageText(pages.a) : "(no page yet)";
  const b = pages ? await pageText(pages.b) : "(no page yet)";
  const tail = (server) => server.lines.slice(-LOG_LINES).join("\n");
  console.error(
    `starter journey: FAIL at ${failedStage} after ${seconds()} s: ${wanted}\n` +
      `page A (${ports.a}): ${a}\n` +
      `page B (${ports.b}): ${b}\n` +
      `page errors: ${pageErrors.length ? pageErrors.join(" ; ") : "none"}\n` +
      `--- node scripts/dev.mjs (last ${LOG_LINES} lines) ---\n${tail(servers.a)}\n` +
      `--- node scripts/dev.mjs --second (last ${LOG_LINES} lines) ---\n${tail(servers.b)}`,
  );
}

async function buttonShown(page, name) {
  return page
    .getByRole("button", { name, exact: true })
    .isVisible()
    .catch(() => false);
}

async function textOf(locator) {
  return (
    (await locator
      .first()
      .textContent({ timeout: 1000 })
      .catch(() => "")) ?? ""
  );
}

async function run() {
  const exitedFirst = () => servers.a.exited ?? servers.b.exited;
  begin("start", 'both dev servers to print "vote ready:"');
  const started = await until(
    () => (servers.a.ready && servers.b.ready) || exitedFirst(),
    START,
  );
  if (exitedFirst()) {
    wanted = `dev servers to keep running (${exitedFirst()})`;
    return false;
  }
  if (!started) return false;
  passed();

  begin("ready", "both pages to show Tea (0) and an invite code");
  pages = {
    a: await (await browser.newContext()).newPage(),
    b: await (await browser.newContext()).newPage(),
  };
  for (const page of Object.values(pages)) {
    page.on("pageerror", (error) => pageErrors.push(error.message));
  }
  await Promise.all([
    pages.a.goto(`http://localhost:${ports.a}`),
    pages.b.goto(`http://localhost:${ports.b}`),
  ]);
  const invite = (page) => textOf(page.locator("code.invite"));
  const ready = await until(
    async () =>
      (await buttonShown(pages.a, "Tea (0)")) &&
      (await buttonShown(pages.b, "Tea (0)")) &&
      (await invite(pages.a)).trim() !== "" &&
      (await invite(pages.b)).trim() !== "",
    READY,
  );
  if (!ready) return false;
  passed();

  // A device that joins a room before the other device's announce reaches the
  // DHT never finds it (the next lookup is 10+ minutes away): this was the
  // cause of the stalls at "connected". A user pastes seconds later, so wait
  // until the room can be looked up.
  begin("announced", "page A's room to be found on the DHT");
  if (!(await roomFound((await invite(pages.a)).trim()))) return false;
  passed();

  begin("join", "page B to accept the invite code from page A");
  const code = (await invite(pages.a)).trim();
  const input = pages.b.getByLabel("Invite code from another device");
  await input.fill(code);
  await pages.b.getByRole("button", { name: "Join", exact: true }).click();
  const alert = pages.b.getByRole("alert");
  let joined = false;
  const answered = await until(async () => {
    if ((await textOf(alert)).trim() !== "") return true;
    joined = (await input.inputValue().catch(() => "x")) === "";
    return joined;
  }, JOIN);
  if (!answered) return false;
  if (!joined) {
    wanted = `page B to accept the invite code, it said: ${(await textOf(alert)).trim()}`;
    return false;
  }
  passed();

  begin("connected", 'both pages to show "1 other device connected"');
  const status = (page) => textOf(page.getByRole("status"));
  const connected = await until(
    async () =>
      (await status(pages.a)).includes("1 other device connected") &&
      (await status(pages.b)).includes("1 other device connected"),
    CONNECTED,
  );
  if (!connected) return false;
  passed();

  begin(
    "vote",
    "Tea (1) on page A and Coffee (1) on page B after one click each",
  );
  await pages.a.getByRole("button", { name: "Tea (0)", exact: true }).click();
  await pages.b
    .getByRole("button", { name: "Coffee (0)", exact: true })
    .click();
  const voted = await until(
    async () =>
      (await buttonShown(pages.a, "Tea (1)")) &&
      (await buttonShown(pages.b, "Coffee (1)")),
    VOTE,
  );
  if (!voted) return false;
  passed();

  begin("synced", "both pages to show Tea (1), Coffee (1), Water (0)");
  const synced = await until(async () => {
    for (const page of Object.values(pages)) {
      for (const name of ["Tea (1)", "Coffee (1)", "Water (0)"]) {
        if (!(await buttonShown(page, name))) return false;
      }
    }
    return true;
  }, SYNCED);
  if (!synced) return false;
  passed();
  return true;
}

// Overall cap: fail at whatever stage is current.
const result = await Promise.race([
  run().catch((error) => {
    wanted = `${wanted} (${error.message.split("\n")[0]})`;
    return false;
  }),
  new Promise((resolve) => setTimeout(() => resolve(false), OVERALL * 1000)),
]);

if (result) console.log("starter journey: PASS");
else await fail();

await browser?.close().catch(() => {});
await Promise.all([stopServer(servers.a), stopServer(servers.b)]);
process.exit(result ? 0 : 1);
