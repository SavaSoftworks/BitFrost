-- Copyright (C) 2026 Nick Germaine; SPDX-License-Identifier: GPL-3.0-only
CREATE UNIQUE INDEX IF NOT EXISTS inbox_client_input ON inbox(session_id,client_input_id) WHERE client_input_id IS NOT NULL;
