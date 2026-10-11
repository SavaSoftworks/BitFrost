-- Copyright (C) 2026 Nick Germaine; SPDX-License-Identifier: GPL-3.0-only
UPDATE turns SET (input_tokens,output_tokens,cached_tokens,requests) =
  (SELECT input,output,cached,requests FROM migration_turns WHERE id=turns.id)
WHERE id IN (SELECT id FROM migration_turns);
UPDATE sessions SET
  tokens=(SELECT COALESCE(SUM(input_tokens+output_tokens),0) FROM turns WHERE session_id=sessions.id),
  cached_tokens=(SELECT COALESCE(SUM(cached_tokens),0) FROM turns WHERE session_id=sessions.id);
