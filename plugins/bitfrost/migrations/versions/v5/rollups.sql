-- Copyright (C) 2026 Nick Germaine; SPDX-License-Identifier: GPL-3.0-only
DROP TABLE IF EXISTS model_usage;
DELETE FROM usage_hours;
INSERT INTO usage_hours (harness,model,hour,sessions,first_at,last_at)
  SELECT harness,model,local_hour(created_at),COUNT(*),MIN(created_at),MAX(created_at)
  FROM sessions WHERE created_at IS NOT NULL GROUP BY 1,2,3;
INSERT INTO usage_hours (harness,model,hour,closed_sessions,session_ms,first_at,last_at)
  SELECT harness,model,local_hour(closed_at),COUNT(*),SUM(MAX(0,closed_at-created_at)),MIN(closed_at),MAX(closed_at)
  FROM sessions WHERE closed_at IS NOT NULL AND created_at IS NOT NULL GROUP BY 1,2,3
ON CONFLICT(harness,model,hour) DO UPDATE SET
  closed_sessions=closed_sessions+excluded.closed_sessions,session_ms=session_ms+excluded.session_ms,
  first_at=MIN(first_at,excluded.first_at),last_at=MAX(last_at,excluded.last_at);
INSERT INTO usage_hours (harness,model,hour,turns,failed_turns,turn_ms,requests,input_tokens,output_tokens,cached_tokens,first_at,last_at)
  SELECT s.harness,s.model,local_hour(t.started_at),SUM(t.ended_at IS NOT NULL),SUM(t.status='failed'),
  COALESCE(SUM(t.ended_at-t.started_at),0),SUM(t.requests),SUM(t.input_tokens),SUM(t.output_tokens),SUM(t.cached_tokens),MIN(t.started_at),MAX(COALESCE(t.ended_at,t.started_at))
  FROM turns t JOIN sessions s ON s.id=t.session_id WHERE t.started_at IS NOT NULL GROUP BY 1,2,3
ON CONFLICT(harness,model,hour) DO UPDATE SET
  turns=turns+excluded.turns,failed_turns=failed_turns+excluded.failed_turns,turn_ms=turn_ms+excluded.turn_ms,
  requests=requests+excluded.requests,input_tokens=input_tokens+excluded.input_tokens,
  output_tokens=output_tokens+excluded.output_tokens,cached_tokens=cached_tokens+excluded.cached_tokens,
  first_at=MIN(first_at,excluded.first_at),last_at=MAX(last_at,excluded.last_at);
UPDATE usage_hours SET updated_at=1;
