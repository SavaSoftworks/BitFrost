-- Copyright (C) 2026 Nick Germaine; SPDX-License-Identifier: GPL-3.0-only
DELETE FROM usage_requests;
CREATE TEMP TABLE migration_turns (
  id TEXT PRIMARY KEY, session_id TEXT, at INTEGER,
  input INTEGER, output INTEGER, cached INTEGER, requests INTEGER,
  old_input INTEGER, old_output INTEGER, old_cached INTEGER, old_requests INTEGER
) WITHOUT ROWID;
CREATE TEMP TABLE migration_deltas (
  session_id TEXT, at INTEGER, input INTEGER, output INTEGER, cached INTEGER, requests INTEGER
);
