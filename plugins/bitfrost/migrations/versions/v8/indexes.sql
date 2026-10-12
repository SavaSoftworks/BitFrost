CREATE INDEX IF NOT EXISTS sessions_created ON sessions(created_at,id);
CREATE INDEX IF NOT EXISTS sessions_changed ON sessions(changed_at);
CREATE INDEX IF NOT EXISTS turns_open ON turns(session_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS messages_approval ON messages(session_id,approval_id);
CREATE UNIQUE INDEX IF NOT EXISTS inbox_client_input ON inbox(session_id,client_input_id) WHERE client_input_id IS NOT NULL;
