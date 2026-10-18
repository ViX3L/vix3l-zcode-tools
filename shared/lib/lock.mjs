// Singleflight lock shared by both injectors.
//
// The earlier implementations read the lock, then wrote it, then unconditionally
// unlinked it on exit. Two simultaneous starts could both "win", and a loser
// could delete the winner's lock. The claim here is atomic (O_EXCL create), and
// release only removes a lock this process still owns.
//
// Freshness is based on the file mtime, touched by fs.utimes, so readers never
// observe a half-written JSON body.
import fs from "node:fs";
import path from "node:path";
import { LOCK_STALE_MS } from "./constants.mjs";

function pidAlive(pid, selfPid = process.pid) {
  if (!pid) return false;
  if (pid === selfPid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

export function readLock(file, { staleMs = LOCK_STALE_MS, now = Date.now() } = {}) {
  try {
    const stat = fs.statSync(file);
    let pid = null;
    try {
      pid = Number(JSON.parse(fs.readFileSync(file, "utf8")).pid);
    } catch {
      // A lock written by an older build is a bare pid.
      pid = Number(fs.readFileSync(file, "utf8").trim());
    }
    const age = now - stat.mtimeMs;
    return {
      pid: Number.isFinite(pid) ? pid : null,
      age,
      fresh: age < staleMs,
    };
  } catch {
    return null;
  }
}

function create(file, pid) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fd = fs.openSync(file, "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify({ pid, ts: Date.now() }));
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  }
}

export function claimLock(file, { staleMs = LOCK_STALE_MS, pid = process.pid } = {}) {
  const handle = {
    acquired: false,
    pid,
    owned() {
      const lock = readLock(file, { staleMs });
      return !!lock && lock.pid === pid;
    },
    touch() {
      if (!handle.owned()) return false;
      try {
        const now = new Date();
        fs.utimesSync(file, now, now);
        return true;
      } catch {
        return false;
      }
    },
    release() {
      if (!handle.owned()) return false;
      try {
        fs.unlinkSync(file);
        return true;
      } catch {
        return false;
      }
    },
  };

  if (create(file, pid)) {
    handle.acquired = true;
    return handle;
  }

  const current = readLock(file, { staleMs });
  if (current && current.fresh && current.pid !== pid && pidAlive(current.pid)) {
    return handle; // a live peer owns it
  }

  // Stale or dead owner: remove only that record, then race once for the lock.
  if (current && current.pid !== pid) {
    try {
      fs.unlinkSync(file);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  handle.acquired = create(file, pid);
  return handle;
}
