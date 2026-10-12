-- Copyright (C) 2026 Nick Germaine; SPDX-License-Identifier: GPL-3.0-only
-- Only databases originally written by v6 stored uncached input here.
UPDATE turns SET input_tokens=input_tokens+cached_tokens
WHERE id NOT IN (SELECT turn_id FROM events
  WHERE type='usage' AND turn_id IS NOT NULL);
