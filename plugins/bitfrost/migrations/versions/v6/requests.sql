-- Copyright (C) 2026 Nick Germaine; SPDX-License-Identifier: GPL-3.0-only
-- Remember the last retained provider report, without trusting malformed JSON.
UPDATE sessions SET
  request_input=COALESCE((SELECT json_extract(body,'$.inputTokens') FROM events
    WHERE session_id=sessions.id AND type='usage'
    AND json_type(CASE WHEN json_valid(body) THEN body END)='object'
    ORDER BY seq DESC LIMIT 1),0),
  request_output=COALESCE((SELECT json_extract(body,'$.outputTokens') FROM events
    WHERE session_id=sessions.id AND type='usage'
    AND json_type(CASE WHEN json_valid(body) THEN body END)='object'
    ORDER BY seq DESC LIMIT 1),0);
