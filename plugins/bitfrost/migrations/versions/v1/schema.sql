-- Copyright (C) 2026 Nick Germaine; SPDX-License-Identifier: GPL-3.0-only
CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, harness TEXT, agent TEXT, model TEXT, effort TEXT, plan TEXT,
        native_ref TEXT, cwd TEXT, title TEXT, claude_session TEXT, claude_agent TEXT,
        lease_id TEXT, parent_mode TEXT, state TEXT, created_at INTEGER, updated_at INTEGER,
        closed_at INTEGER, close_reason TEXT, last_seq INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY, session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
        seq_start INTEGER, seq_end INTEGER, started_at INTEGER, ended_at INTEGER,
        status TEXT, end_reason TEXT, provider_error_code TEXT, error TEXT, plan TEXT,
        final_text TEXT, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
        cached_tokens INTEGER DEFAULT 0, requests INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS events (
        session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE, seq INTEGER, ts INTEGER,
        type TEXT, turn_id TEXT, body TEXT, PRIMARY KEY(session_id, seq)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
        turn_id TEXT REFERENCES turns(id) ON DELETE CASCADE, seq INTEGER, ts INTEGER,
        role TEXT, kind TEXT, item_id TEXT, name TEXT, text TEXT, status TEXT, detail TEXT
      );
      CREATE TABLE IF NOT EXISTS inbox (
        id TEXT PRIMARY KEY, session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
        ts INTEGER, sender TEXT, text TEXT, delivery TEXT, state TEXT,
        consumed_turn TEXT, consumed_at INTEGER
      );
CREATE INDEX IF NOT EXISTS turns_session ON turns(session_id, seq_start);
      CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id, seq);
      CREATE INDEX IF NOT EXISTS messages_turn ON messages(session_id, turn_id, seq);
      CREATE INDEX IF NOT EXISTS messages_active ON messages(session_id,turn_id,seq DESC) WHERE status='running' AND kind IN ('tool','command');
      CREATE INDEX IF NOT EXISTS messages_item ON messages(session_id, item_id);
      CREATE INDEX IF NOT EXISTS inbox_session ON inbox(session_id, state, ts);
