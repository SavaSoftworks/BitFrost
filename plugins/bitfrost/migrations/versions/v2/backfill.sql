-- Copyright (C) 2026 Nick Germaine; SPDX-License-Identifier: GPL-3.0-only
UPDATE messages SET approval_id=COALESCE(
  json_extract(CASE WHEN json_valid(detail) THEN detail END,'$.approvalId'),
  (SELECT json_extract(CASE WHEN json_valid(body) THEN body END,'$.approvalId')
   FROM events WHERE events.session_id=messages.session_id
   AND events.seq=messages.seq AND type='approval_requested'))
WHERE kind='approval' AND approval_id IS NULL;
