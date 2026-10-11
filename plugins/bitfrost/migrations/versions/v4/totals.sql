-- Copyright (C) 2026 Nick Germaine; SPDX-License-Identifier: GPL-3.0-only
UPDATE sessions SET
  tokens=(SELECT COALESCE(SUM(input_tokens+output_tokens),0) FROM turns WHERE session_id=sessions.id),
  cached_tokens=(SELECT COALESCE(SUM(cached_tokens),0) FROM turns WHERE session_id=sessions.id),
  turns=(SELECT COUNT(*) FROM turns WHERE session_id=sessions.id AND ended_at IS NOT NULL),
  active_ms=(SELECT COALESCE(SUM(ended_at-started_at),0) FROM turns WHERE session_id=sessions.id AND ended_at IS NOT NULL),
  tool_calls=(SELECT COUNT(*) FROM messages WHERE session_id=sessions.id AND kind IN ('tool','command','file_change')),
  changed_at=COALESCE(updated_at,created_at,0);
