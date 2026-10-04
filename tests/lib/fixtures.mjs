// A throwaway ZCode usage DB, built in a temp dir, with the exact table shapes
// the live DB has (see the schemas dumped from ~/.zcode/cli/db/db.sqlite).
//
// Every sidecar/metrics test points ZCODE_USAGE_DB at one of these and
// HOME/TPS_MONITOR_STATE_FILE at a temp dir, so nothing in the suite ever reads
// or writes the user's real database or session state. That isolation is the
// whole point: a test run must not disturb a running ZCode, and must not be
// able to see the developer's real numbers (so assertions are exact).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { DatabaseSync } = await import("node:sqlite");

const SCHEMA = `
CREATE TABLE session (
  id text primary key, project_id text not null, workspace_id text, parent_id text,
  slug text not null, directory text not null, path text, title text not null,
  version text not null, share_url text, summary_additions integer, summary_deletions integer,
  summary_files integer, summary_diffs text, revert text, permission text,
  time_created integer not null, time_updated integer not null, time_compacting integer,
  time_archived integer, task_type text not null default 'interactive',
  title_source text not null default 'first_input', title_message_id text,
  time_title_updated integer, trace_id text
);
CREATE INDEX session_project_idx on session(project_id);

CREATE TABLE model_usage (
  id text primary key, logical_request_id text not null, attempt_index integer not null default 0,
  session_id text not null references session(id) on delete cascade, turn_id text, trace_id text,
  span_id text, assistant_message_id text, parent_user_message_id text,
  query_source text not null, provider_id text not null, model_id text not null, variant text,
  agent text, mode text, task_type text,
  status text not null check(status in ('running','completed','error','cancelled')),
  started_at integer not null, first_token_at integer, completed_at integer, duration_ms integer,
  time_to_first_token_ms integer, finish_reason text, tool_call_count integer not null default 0,
  input_tokens integer not null default 0, output_tokens integer not null default 0,
  reasoning_tokens integer not null default 0, cache_creation_input_tokens integer not null default 0,
  cache_read_input_tokens integer not null default 0, provider_total_tokens integer,
  computed_total_tokens integer not null default 0, retry_count integer not null default 0,
  retryable integer not null default 0 check(retryable in (0,1)),
  cancelled_by_user integer not null default 0 check(cancelled_by_user in (0,1)),
  context_exceeded integer not null default 0 check(context_exceeded in (0,1)),
  error_type text, error_code text, error_message text, raw_usage_json text,
  provider_metadata_json text
);
CREATE INDEX model_usage_started_model_idx on model_usage(started_at, provider_id, model_id);
CREATE INDEX model_usage_session_turn_idx on model_usage(session_id, turn_id);
CREATE INDEX model_usage_trace_idx on model_usage(trace_id);
CREATE INDEX model_usage_query_source_idx on model_usage(query_source);

CREATE TABLE turn_usage (
  session_id text not null references session(id) on delete cascade, turn_id text not null,
  trace_id text, user_message_id text,
  status text not null check(status in ('running','completed','error','cancelled')),
  started_at integer not null, first_model_start_at integer, first_token_at integer,
  completed_at integer, duration_ms integer, time_to_first_token_ms integer,
  model_request_count integer not null default 0, model_retry_count integer not null default 0,
  tool_call_count integer not null default 0, tool_error_count integer not null default 0,
  input_tokens integer not null default 0, output_tokens integer not null default 0,
  reasoning_tokens integer not null default 0, cache_creation_input_tokens integer not null default 0,
  cache_read_input_tokens integer not null default 0, computed_total_tokens integer not null default 0,
  retryable integer not null default 0 check(retryable in (0,1)),
  cancelled_by_user integer not null default 0 check(cancelled_by_user in (0,1)),
  context_exceeded integer not null default 0 check(context_exceeded in (0,1)),
  error_type text, error_code text, primary key(session_id, turn_id)
);
CREATE INDEX turn_usage_started_idx on turn_usage(started_at);

CREATE TABLE tool_usage (
  id text primary key, session_id text not null references session(id) on delete cascade,
  turn_id text, trace_id text, tool_call_id text not null, tool_name text not null,
  side_effect_scope text, read_only integer check(read_only in (0,1)),
  destructive integer check(destructive in (0,1)), approval_status text,
  status text not null check(status in ('running','completed','error','cancelled')),
  started_at integer not null, first_output_at integer, completed_at integer, duration_ms integer,
  time_to_first_output_ms integer, exit_code integer, output_bytes integer not null default 0,
  stdout_bytes integer not null default 0, stderr_bytes integer not null default 0,
  truncated integer not null default 0 check(truncated in (0,1)),
  retry_count integer not null default 0, retryable integer not null default 0 check(retryable in (0,1)),
  cancelled_by_user integer not null default 0 check(cancelled_by_user in (0,1)),
  error_type text, error_code text, error_message text
);
CREATE UNIQUE INDEX tool_usage_session_tool_call_idx on tool_usage(session_id, tool_call_id);
CREATE INDEX tool_usage_started_tool_idx on tool_usage(started_at, tool_name);
CREATE INDEX tool_usage_session_turn_idx on tool_usage(session_id, turn_id);
`;

// One temp "machine": a HOME-like dir plus a DB inside it. Set as the
// environment for any child process under test.
export function makeMachine(label = "m") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `zstats-${label}-`));
  const dbPath = path.join(dir, "db.sqlite");
  return { dir, dbPath, db: null };
}

export function createDb(machine) {
  const db = new DatabaseSync(machine.dbPath);
  db.exec(SCHEMA);
  machine.db = db;
  return db;
}

export function addSession(db, id, title = "Test session") {
  db.prepare(
    "INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)" +
    " VALUES (?,?,?,?,?,?,?,?)"
  ).run(id, "proj_test", "slug-" + id, "/tmp", title, "1.0.0", Date.now(), Date.now());
}

// A completed main_turn request. Every field that the row projection reads can
// be overridden, so a test can express exactly the shape it wants to prove.
let seq = 0;
export function addRequest(db, r) {
  const id = r.id || `req_${++seq}`;
  const startedAt = r.startedAt ?? 1_000_000_000_000 + seq * 10_000;
  const genMs = r.genMs ?? 3_000;
  const firstTokenAt = r.firstTokenAt ?? startedAt + (r.ttftMs ?? 200);
  const completedAt = r.completedAt ?? firstTokenAt + genMs;
  db.prepare(
    "INSERT INTO model_usage (" +
      "id, logical_request_id, session_id, turn_id, query_source, provider_id, model_id, status," +
      " started_at, first_token_at, completed_at, duration_ms, time_to_first_token_ms," +
      " input_tokens, output_tokens, reasoning_tokens, cache_read_input_tokens, cache_creation_input_tokens" +
    ") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
  ).run(
    id, id, r.sessionId, r.turnId ?? "turn_1", r.querySource ?? "main_turn",
    r.providerId ?? "prov_1", r.modelId ?? "deepseek-v4.1-flash:cloud", r.status ?? "completed",
    startedAt, firstTokenAt, completedAt, r.durationMs ?? (completedAt - startedAt),
    r.ttftMs ?? 200, r.inputTokens ?? 10_000, r.outputTokens ?? 600, r.reasoningTokens ?? 0,
    r.cacheRead ?? 4_000, r.cacheWrite ?? 0
  );
  return id;
}

// A request that is still streaming (status='running'): no completion, so the
// pill's live indicator and the "waiting" figure have something to read.
export function addRunningRequest(db, r) {
  const id = r.id || `run_${++seq}`;
  const startedAt = r.startedAt ?? Date.now() - 1500;
  db.prepare(
    "INSERT INTO model_usage (" +
      "id, logical_request_id, session_id, turn_id, query_source, provider_id, model_id, status," +
      " started_at, input_tokens, output_tokens, reasoning_tokens" +
    ") VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"
  ).run(id, id, r.sessionId, r.turnId ?? "turn_live", r.querySource ?? "main_turn",
    r.providerId ?? "prov_1", r.modelId ?? "deepseek-v4.1-flash:cloud", "running",
    startedAt, 0, 0, 0);
  return id;
}

// One turn_usage row. The figures are the app's own accounting; `userMessageId`
// is the join key the renderer's data-turn-id carries.
export function addTurn(db, t) {
  const startedAt = t.startedAt ?? 1_000_000_000_000 + (++seq) * 10_000;
  const durationMs = t.durationMs ?? 43_000;
  db.prepare(
    "INSERT INTO turn_usage (" +
      "session_id, turn_id, user_message_id, status, started_at, completed_at, duration_ms," +
      " time_to_first_token_ms, model_request_count, tool_call_count, tool_error_count," +
      " input_tokens, output_tokens, reasoning_tokens, cache_read_input_tokens," +
      " cache_creation_input_tokens, computed_total_tokens" +
    ") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
  ).run(
    t.sessionId, t.turnId, t.userMessageId ?? t.turnId, t.status ?? "completed",
    startedAt, startedAt + durationMs, durationMs, t.ttftMs ?? 500,
    t.steps ?? 3, t.toolCalls ?? 5, t.toolErrors ?? 0,
    t.inputTokens ?? 700_000, t.outputTokens ?? 20_000, t.reasoningTokens ?? 2_000,
    t.cacheRead ?? 600_000, t.cacheWrite ?? 0,
    t.totalTokens ?? ((t.cacheRead ?? 600_000) + ((t.inputTokens ?? 700_000) - (t.cacheRead ?? 600_000)) + (t.outputTokens ?? 20_000) + (t.reasoningTokens ?? 2_000))
  );
}

export function addTool(db, t) {
  const id = t.id || `tool_${++seq}`;
  const startedAt = t.startedAt ?? 1_000_000_000_000 + seq * 1_000;
  const durationMs = t.durationMs ?? 1_200;
  db.prepare(
    "INSERT INTO tool_usage (id, session_id, turn_id, tool_call_id, tool_name, status, started_at, completed_at, duration_ms)" +
    " VALUES (?,?,?,?,?,?,?,?,?)"
  ).run(id, t.sessionId, t.turnId ?? "turn_1", id, t.toolName ?? "read", t.status ?? "completed",
    startedAt, startedAt + durationMs, durationMs);
  return id;
}

export function cleanup(machine) {
  try { machine.db && machine.db.close(); } catch {}
  try { fs.rmSync(machine.dir, { recursive: true, force: true }); } catch {}
}

// The HOME a child process under test should see: temp dirs for every state
// file the plugins touch, so the developer's ~/.zcode is never consulted.
export function testEnv(machine, extra = {}) {
  return {
    ...process.env,
    HOME: machine.dir,
    USERPROFILE: machine.dir,
    ZCODE_USAGE_DB: machine.dbPath,
    TPS_MONITOR_STATE_FILE: path.join(machine.dir, "tps-monitor.last-session.json"),
    STATS_SIDECAR_PLUGIN_ROOT: undefined,
    ...extra,
  };
}
