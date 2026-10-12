-- Copyright (C) 2026 Nick Germaine; SPDX-License-Identifier: GPL-3.0-only
INSERT INTO usage_hours (harness,model,hour,input_tokens,output_tokens,cached_tokens,requests,first_at,last_at,updated_at)
SELECT s.harness,s.model,local_hour(d.at),SUM(d.input),SUM(d.output),SUM(d.cached),SUM(d.requests),MIN(d.at),MAX(d.at),
  (SELECT COALESCE(MAX(updated_at),0)+1 FROM usage_hours)
FROM migration_deltas d JOIN sessions s ON s.id=d.session_id GROUP BY 1,2,3
ON CONFLICT(harness,model,hour) DO UPDATE SET
  input_tokens=input_tokens+excluded.input_tokens,output_tokens=output_tokens+excluded.output_tokens,
  cached_tokens=cached_tokens+excluded.cached_tokens,requests=requests+excluded.requests,
  first_at=MIN(first_at,excluded.first_at),last_at=MAX(last_at,excluded.last_at),updated_at=excluded.updated_at;
