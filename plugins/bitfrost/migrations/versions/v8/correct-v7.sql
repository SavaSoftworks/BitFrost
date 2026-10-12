-- Copyright (C) 2026 Nick Germaine; SPDX-License-Identifier: GPL-3.0-only
-- Correct the hourly bucket without losing usage whose source events expired.
INSERT INTO migration_deltas
SELECT m.session_id,m.at,m.old_input-t.input_tokens,m.old_output-t.output_tokens,
  m.old_cached-t.cached_tokens,m.old_requests-t.requests
FROM migration_turns m JOIN turns t ON t.id=m.id
WHERE EXISTS (SELECT 1 FROM events e WHERE e.session_id=m.session_id AND e.seq=t.seq_start AND e.type='turn_started');
-- Partial turns keep the portion of their bill preceding the retained events.
UPDATE migration_turns SET
  input=input+(SELECT input_tokens FROM turns WHERE id=migration_turns.id)-old_input,
  output=output+(SELECT output_tokens FROM turns WHERE id=migration_turns.id)-old_output,
  cached=cached+(SELECT cached_tokens FROM turns WHERE id=migration_turns.id)-old_cached,
  requests=requests+(SELECT requests FROM turns WHERE id=migration_turns.id)-old_requests
WHERE NOT EXISTS (SELECT 1 FROM events e JOIN turns t ON t.id=migration_turns.id
  WHERE e.session_id=migration_turns.session_id AND e.seq=t.seq_start AND e.type='turn_started');
