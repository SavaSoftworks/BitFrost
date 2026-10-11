-- Copyright (C) 2026 Nick Germaine; SPDX-License-Identifier: GPL-3.0-only
CREATE INDEX IF NOT EXISTS sessions_created ON sessions(created_at,id);
CREATE INDEX IF NOT EXISTS sessions_changed ON sessions(changed_at);
CREATE INDEX IF NOT EXISTS turns_open ON turns(session_id) WHERE ended_at IS NULL;
