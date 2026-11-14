import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { test } from "node:test";

const source = fs.readFileSync(
  new URL("./starter-two-phones.mjs", import.meta.url),
  "utf8",
);
const body = source.match(/function openSimulators[\s\S]*?\n}\n/)[0];
const load = (simctl, run, current, udids) =>
  new Function(
    "simctl",
    "run",
    "current",
    "udids",
    "pickIphone",
    `${body}\nreturn openSimulators;`,
  )(simctl, run, current, udids, () => ({ deviceType: "d", runtime: "r" }));

test("a failed simctl create stops before any boot and says which phone", () => {
  const current = {};
  const calls = [];
  const simctl = (...args) => {
    calls.push(args[0]);
    if (args[0] === "list") return { stdout: "{}" };
    return args[1] === "phone1"
      ? { status: 1, stderr: "no runtime" }
      : { status: 0, stdout: "UDID-A\n" };
  };
  const open = load(
    simctl,
    () => assert.fail("no boot after a failed create"),
    current,
    [],
  );
  assert.equal(open(), undefined);
  assert.equal(current.wanted, "simctl create phone1: no runtime");
  assert.deepEqual(calls, ["list", "create", "create"]);
});

test("each Simulator logs its own boot time when its bootstatus exits", () => {
  const udids = [];
  const children = [];
  const simctl = (...args) =>
    args[0] === "list"
      ? { stdout: "{}" }
      : { status: 0, stdout: `UDID-${args[1]}\n` };
  const run = () => {
    const child = new EventEmitter();
    children.push(child);
    return { child };
  };
  const lines = [];
  const log = console.log;
  console.log = (line) => lines.push(line);
  try {
    const booting = load(simctl, run, {}, udids)();
    assert.equal(booting.length, 2);
    assert.deepEqual(udids, ["UDID-phone0", "UDID-phone1"]);
    children[1].emit("exit", 0);
    children[0].emit("exit", 0);
  } finally {
    console.log = log;
  }
  assert.deepEqual(
    lines.map((l) => l.replace(/\d+ s$/, "N s")),
    ["  boot UDID-phone1: N s", "  boot UDID-phone0: N s"],
  );
});
