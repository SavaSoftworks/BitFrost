-- Copyright (C) 2026 Nick Germaine; SPDX-License-Identifier: GPL-3.0-only
CREATE INDEX IF NOT EXISTS messages_approval ON messages(session_id,approval_id);
