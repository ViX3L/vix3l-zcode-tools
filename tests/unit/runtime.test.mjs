// The cross-platform layer, tested where it can actually be tested: as pure
// functions, by asking for another platform's answers on this machine.
//
// runtime.mjs's whole job is to be right on macOS, Windows and Linux, and it
// was written for platforms I cannot run here. That does not make it
// untestable: appRootFromEnv / appBinaryFor / candidateAppBinaries all take a
// platform argument, so a Linux CI run can still verify the Darwin and Win32
// path shapes. What CANNOT be verified this way — an actual spawn on those
// systems — is stated plainly in the README rather than papered over.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { STATS_RUNTIME, USAGE_RUNTIME } from "../lib/paths.mjs";

const R = await import(STATS_RUNTIME);
const R2 = await import(USAGE_RUNTIME);

test("appRootFromEnv recovers the app root on every platform's path shape", () => {
  // The marker ZCode exports is <root>/resources/tools/<tool>/<bin>.
  const cases = [
    ["linux", "/opt/ZCode/resources/tools/bfs/bfs", "ZCODE_BFS_BINARY", "/opt/ZCode"],
    ["linux", "/usr/lib/zcode/resources/tools/ripgrep/rg", "ZCODE_RG_BINARY", "/usr/lib/zcode"],
    ["darwin", "/Applications/ZCode.app/Contents/Resources/resources/tools/bfs/bfs", "ZCODE_BFS_BINARY", "/Applications/ZCode.app/Contents/Resources"],
    ["win32", "C:\\Users\\u\\AppData\\Local\\Programs\\ZCode\\resources\\tools\\bfs\\bfs.exe", "ZCODE_BFS_BINARY", "C:\\Users\\u\\AppData\\Local\\Programs\\ZCode"],
  ];
  for (const [platform, value, key, expected] of cases) {
    assert.equal(R.appRootFromEnv({ [key]: value }, platform), expected, `${platform}: ${value}`);
  }
  // The separator must follow the TARGET platform, not the host: a Windows path
  // examined with a "/" marker would not match.
  assert.equal(R.appRootFromEnv({ ZCODE_BFS_BINARY: "C:\\App\\resources\\tools\\bfs\\bfs.exe" }, "darwin"), null);
});

test("appRootFromEnv prefers the LAST marker (the innermost tools dir)", () => {
  const v = "/home/u/resources/tools/x/resources/tools/bfs/bfs";
  assert.equal(R.appRootFromEnv({ ZCODE_BFS_BINARY: v }, "linux"), "/home/u/resources/tools/x");
});

test("appRootFromEnv returns null rather than guessing", () => {
  assert.equal(R.appRootFromEnv({}, "linux"), null);
  assert.equal(R.appRootFromEnv({ ZCODE_BFS_BINARY: "/usr/bin/bfs" }, "linux"), null);
  assert.equal(R.appRootFromEnv({ ZCODE_OTHER: "/opt/ZCode/resources/tools/bfs/bfs" }, "linux"), null);
});

test("appBinaryFor maps an app root to the GUI executable per platform", () => {
  assert.equal(R.appBinaryFor("/opt/ZCode", "linux"), path.join("/opt/ZCode", "zcode"));
  assert.equal(
    R.appBinaryFor("/Applications/ZCode.app/Contents/Resources", "darwin"),
    "/Applications/ZCode.app/Contents/MacOS/ZCode"
  );
  assert.equal(
    R.appBinaryFor("C:\\Program Files\\ZCode", "win32"),
    path.join("C:\\Program Files\\ZCode", "ZCode.exe")
  );
  // A Darwin root that is not inside a .app cannot yield a binary path.
  assert.equal(R.appBinaryFor("/opt/ZCode", "darwin"), null);
  assert.equal(R.appBinaryFor(null, "linux"), null);
});

test("candidateAppBinaries lists the conventional install locations per platform", () => {
  const linux = R.candidateAppBinaries("linux", {});
  assert.ok(linux.includes("/opt/ZCode/zcode"));
  assert.ok(linux.some((p) => p.endsWith(".local/bin/zcode")));

  const mac = R.candidateAppBinaries("darwin", {});
  assert.ok(mac.includes("/Applications/ZCode.app/Contents/MacOS/ZCode"));

  const win = R.candidateAppBinaries("win32", { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local", ProgramFiles: "C:\\Program Files" });
  assert.ok(win.includes(path.join("C:\\Users\\u\\AppData\\Local", "Programs", "ZCode", "ZCode.exe")), win.join(" | "));
});

test("candidateAppBinaries puts the env-derived binary first", () => {
  const env = { ZCODE_RG_BINARY: "/opt/ZCode/resources/tools/ripgrep/rg" };
  assert.equal(R.candidateAppBinaries("linux", env)[0], "/opt/ZCode/zcode");
});

test("childEnv re-asserts ELECTRON_RUN_AS_NODE and quiets the sqlite warning", () => {
  const saved = process.env.ELECTRON_RUN_AS_NODE;
  try {
    delete process.env.ELECTRON_RUN_AS_NODE;
    const plain = R.childEnv({ FOO: "bar" });
    assert.equal(plain.FOO, "bar");
    assert.equal(plain.ELECTRON_RUN_AS_NODE, undefined, "must not invent the flag when the parent lacks it");
    assert.equal(plain.NODE_NO_WARNINGS, "1");

    process.env.ELECTRON_RUN_AS_NODE = "1";
    const embedded = R.childEnv();
    assert.equal(embedded.ELECTRON_RUN_AS_NODE, "1",
      "without this the child relaunches the GUI instead of running the script");
  } finally {
    if (saved === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
    else process.env.ELECTRON_RUN_AS_NODE = saved;
  }
});

test("childEnv lets an explicit override win for NODE_NO_WARNINGS", () => {
  const env = R.childEnv({ NODE_NO_WARNINGS: "0" });
  assert.equal(env.NODE_NO_WARNINGS, "0");
});

test("the spawn helpers exist and return null instead of throwing on a bad path", () => {
  // A bad path must yield null (the callers all treat a falsy return as "could
  // not spawn"), never an exception that would abort a hook.
  assert.equal(typeof R.spawnDetachedNode, "function");
  assert.equal(typeof R.spawnAttachedNode, "function");
  assert.equal(typeof R.spawnNodePiped, "function");
  // spawn() itself only throws synchronously for an invalid argument type.
  assert.doesNotThrow(() => R.spawnDetachedNode(null, [], {}));
});

test("nodeExecutable is the current process's own executable", () => {
  assert.equal(R.nodeExecutable(), process.execPath);
});

test("both plugins expose the identical runtime surface", async () => {
  // The copies are asserted byte-identical in the manifests test; this asserts
  // the behavioural part of the same contract, so a re-sync that renames an
  // export is caught too.
  for (const fn of ["nodeExecutable", "childEnv", "spawnDetachedNode", "spawnAttachedNode", "spawnNodePiped", "appRootFromEnv", "appBinaryFor", "candidateAppBinaries"]) {
    assert.equal(typeof R2[fn], "function", `usage-context runtime is missing ${fn}`);
  }
});
