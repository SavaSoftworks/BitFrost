-- Copyright (C) 2026 Nick Germaine; SPDX-License-Identifier: GPL-3.0-only
DROP TABLE IF EXISTS usage_hours;
CREATE TABLE IF NOT EXISTS usage_hours (
  harness TEXT, model TEXT, hour INTEGER, sessions INTEGER DEFAULT 0, closed_sessions INTEGER DEFAULT 0, session_ms INTEGER DEFAULT 0,
  turns INTEGER DEFAULT 0, failed_turns INTEGER DEFAULT 0, turn_ms INTEGER DEFAULT 0, requests INTEGER DEFAULT 0,
  input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, cached_tokens INTEGER DEFAULT 0,
  first_at INTEGER, last_at INTEGER, updated_at INTEGER DEFAULT 0, PRIMARY KEY(harness, model, hour)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS usage_hours_changed ON usage_hours(harness, model, updated_at);
