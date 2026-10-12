      *> Copyright (C) 2026 Nick Germaine
      *> SPDX-License-Identifier: GPL-3.0-only
      *>
      *> Schema v8: request-aware billing and retained-history rollups.
      *> LS-MIGRATION-DIR is this version's own folder. SOURCE is the
      *> database version before any pending migration ran. The runner
      *> owns backup, transaction, version bookkeeping and process exit.
       IDENTIFICATION DIVISION.
       PROGRAM-ID. MIGRATION-V8.

       DATA DIVISION.
       WORKING-STORAGE SECTION.
       COPY "handler-ws.cpy".

      *> Rollup strategy, decided from the source schema shape below:
      *>  REBUILD-HOURS  - drop usage_hours and recompute it from the
      *>                   sessions and turns that still exist
      *>  ADJUST-HOURS   - version 7 totals were correct; fold in only
      *>                   the corrections for turns whose events
      *>                   expired
      *>  SESSION-TOTALS - sessions.* aggregate columns are missing
       01  REBUILD-HOURS                         PIC X VALUE 'N'.
           88  REBUILD-HOURS-NEEDED                 VALUE 'Y'.
       01  ADJUST-HOURS                          PIC X VALUE 'N'.
           88  ADJUST-HOURS-NEEDED                  VALUE 'Y'.
       01  SESSION-TOTALS                        PIC X VALUE 'N'.
           88  SESSION-TOTALS-NEEDED                 VALUE 'Y'.

      *> SQLite call state. QUERY-VALUE receives scalars from
      *> READ-NUMBER and doubles as the bind scratch in PERSIST-USAGE.
       01  CALL-STATUS                           BINARY-LONG.
       01  QUERY-VALUE                           BINARY-DOUBLE SIGNED.
       01  SQL-TEXT                              PIC X(32768).

      *> Column positions in the usage-events SELECT of RECOUNT-USAGE.
      *> The four reported billing amounts start at column 8 and run
      *> for METRIC-COUNT columns.
       78  USAGE-COL-SESSION-ID                  VALUE 0.
       78  USAGE-COL-TURN-ID                     VALUE 1.
       78  USAGE-COL-EVENT-TIME                  VALUE 2.
       78  USAGE-COL-HAS-TURN                    VALUE 3.
       78  USAGE-COL-REQUEST-ID                  VALUE 4.
       78  USAGE-COL-RAW-INPUT                   VALUE 5.
       78  USAGE-COL-RAW-OUTPUT                  VALUE 6.
       78  USAGE-COL-RAW-CACHED                  VALUE 7.
       78  USAGE-COL-REPORTED-FIRST              VALUE 8.
       78  METRIC-COUNT                          VALUE 4.

      *> First position of each four-metric run; add METRIC-INDEX - 1.
      *>  REQUEST-COL-PREVIOUS-FIRST: columns of the usage_requests
      *>                                lookup
      *>  SAVE-REQUEST-BIND-FIRST:      cumulative values in
      *>                                usage_requests
      *>  SAVE-TURN-BIND-DELTA-FIRST:   per-request deltas in
      *>                                migration_turns
      *>  SAVE-TURN-BIND-OLD-FIRST:     retained pre-migration totals
      *>  SAVE-DELTA-BIND-FIRST:        corrections in
      *>                                migration_deltas
       78  REQUEST-COL-PREVIOUS-FIRST            VALUE 0.
       78  SAVE-REQUEST-BIND-FIRST               VALUE 3.
       78  SAVE-TURN-BIND-DELTA-FIRST            VALUE 4.
       78  SAVE-TURN-BIND-OLD-FIRST              VALUE 8.
       78  SAVE-DELTA-BIND-FIRST                 VALUE 3.

      *> Prepared statements; RECOUNT-USAGE owns their lifecycle.
       01  ROW-STATEMENT                         USAGE POINTER.
       01  REQUEST-STATEMENT                     USAGE POINTER.
       01  SAVE-REQUEST                          USAGE POINTER.
       01  SAVE-TURN                             USAGE POINTER.
       01  SAVE-DELTA                            USAGE POINTER.
       01  SAVE-SESSION                          USAGE POINTER.
       01  ROW-STATUS                            BINARY-LONG.
           88  USAGE-ROW-AVAILABLE                  VALUE 100.
           88  USAGE-STEP-COMPLETE                  VALUE 101.
       01  BIND-INDEX                            BINARY-LONG.
       01  METRIC-INDEX                          BINARY-LONG.

      *> Row state for the usage event stream.
       01  SESSION-ID                            PIC X(4096).
       01  LAST-SESSION-ID                       PIC X(4096).
       01  TURN-ID                               PIC X(4096).
       01  REQUEST-ID                            PIC X(8192).
       01  NATIVE-REQUEST-ID                     PIC X(4096).
       01  EVENT-TIME                            BINARY-DOUBLE SIGNED.
       01  TURN-FLAG                             BINARY-DOUBLE SIGNED.
           88  EVENT-HAS-TURN                       VALUE 1.
       01  LAST-INPUT-TOTAL                      BINARY-DOUBLE SIGNED
                                                       VALUE 0.
       01  LAST-OUTPUT-TOTAL                     BINARY-DOUBLE SIGNED
                                                       VALUE 0.
       01  RAW-INPUT-TOKENS                      BINARY-DOUBLE SIGNED.
       01  RAW-OUTPUT-TOKENS                     BINARY-DOUBLE SIGNED.
       01  RAW-CACHED-TOKENS                     BINARY-DOUBLE SIGNED.

      *> Billing amounts by metric: 1 input, 2 output, 3 cached,
      *> 4 requests. REPORTED is what the event carried, PREVIOUS what
      *> earlier events for the same request already stored, DELTA the
      *> increment to apply, and OLD the pre-migration total retained
      *> for version 7 corrections.
       01  BILLING-AMOUNTS.
           05  AMOUNT OCCURS 4 TIMES.
               10  REPORTED-AMOUNT               BINARY-DOUBLE SIGNED.
               10  PREVIOUS-AMOUNT               BINARY-DOUBLE SIGNED.
               10  DELTA-AMOUNT                  BINARY-DOUBLE SIGNED.
               10  OLD-AMOUNT                    BINARY-DOUBLE SIGNED.

       LINKAGE SECTION.
       01  LS-MIGRATION-DIR                      PIC X(4096).
       01  LS-SOURCE-VERSION                     BINARY-DOUBLE SIGNED.
       01  LS-ERROR-MESSAGE                      PIC X(2048).

       PROCEDURE DIVISION USING LS-MIGRATION-DIR LS-SOURCE-VERSION
           LS-ERROR-MESSAGE.

      *> --------------------------------------------------------------
      *> Migration entry point
      *> --------------------------------------------------------------
       APPLY-USAGE-V8.
           PERFORM CHECK-USAGE-HOURS-SHAPE
           IF LS-SOURCE-VERSION < 7
               SET REBUILD-HOURS-NEEDED TO TRUE
           END-IF
           IF LS-SOURCE-VERSION = 7 AND NOT REBUILD-HOURS-NEEDED
               SET ADJUST-HOURS-NEEDED TO TRUE
           END-IF
           PERFORM CHECK-SESSION-TOTALS-SHAPE
           MOVE 'schema.sql' TO STEP-NAME
           PERFORM APPLY-SQL-FILE
           MOVE 'columns' TO STEP-NAME
           PERFORM APPLY-COLUMNS
           IF SESSION-TOTALS-NEEDED
               MOVE 'totals.sql' TO STEP-NAME
               PERFORM APPLY-SQL-FILE
           END-IF
           MOVE 'indexes.sql' TO STEP-NAME
           PERFORM APPLY-SQL-FILE
           PERFORM DROP-SESSION-CONTEXT-COLUMN
           MOVE 'recount-start.sql' TO STEP-NAME
           PERFORM APPLY-SQL-FILE
           PERFORM RECOUNT-USAGE
           IF LS-SOURCE-VERSION = 7
               MOVE 'correct-v7.sql' TO STEP-NAME
               PERFORM APPLY-SQL-FILE
           END-IF
           MOVE 'recount-finish.sql' TO STEP-NAME
           PERFORM APPLY-SQL-FILE
           MOVE 'SELECT COUNT(*) FROM usage_hours' TO SQL-TEXT
           PERFORM READ-NUMBER
           IF QUERY-VALUE = 0
               SET REBUILD-HOURS-NEEDED TO TRUE
           END-IF
           IF REBUILD-HOURS-NEEDED
               MOVE 'rollups.sql' TO STEP-NAME
               PERFORM APPLY-SQL-FILE
           ELSE
               IF ADJUST-HOURS-NEEDED
                   MOVE 'apply-deltas.sql' TO STEP-NAME
                   PERFORM APPLY-SQL-FILE
               END-IF
           END-IF
           MOVE 'DROP TABLE migration_turns; ' &
               'DROP TABLE migration_deltas' TO SQL-TEXT
           PERFORM EXECUTE-SQL
           MOVE MIGRATION-OK TO RETURN-CODE
           GOBACK.

      *> --------------------------------------------------------------
      *> Schema shape checks and version-specific fixes
      *> --------------------------------------------------------------
       CHECK-USAGE-HOURS-SHAPE.
           MOVE "SELECT COUNT(*) FROM " &
               "pragma_table_info('usage_hours') " &
               "WHERE name IN ('harness','model','hour'," &
               "'sessions','closed_sessions','session_ms'," &
               "'turns','failed_turns','turn_ms'," &
               "'requests','input_tokens','output_tokens'," &
               "'cached_tokens','first_at','last_at'," &
               "'updated_at')" TO SQL-TEXT
           PERFORM READ-NUMBER
           IF QUERY-VALUE NOT = 16
               SET REBUILD-HOURS-NEEDED TO TRUE
               MOVE 'DROP TABLE IF EXISTS usage_hours'
                   TO SQL-TEXT
               PERFORM EXECUTE-SQL
           END-IF.

       CHECK-SESSION-TOTALS-SHAPE.
           MOVE "SELECT COUNT(*) FROM " &
               "pragma_table_info('sessions') " &
               "WHERE name IN ('tokens','cached_tokens'," &
               "'turns','tool_calls','active_ms','changed_at'," &
               "'request_input','request_output')" TO SQL-TEXT
           PERFORM READ-NUMBER
           IF QUERY-VALUE NOT = 8
               SET SESSION-TOTALS-NEEDED TO TRUE
           END-IF.

       DROP-SESSION-CONTEXT-COLUMN.
           CALL STATIC "bf_column" USING BY REFERENCE
               z'sessions' z'context'
               RETURNING CALL-STATUS
           IF CALL-STATUS < 0
               PERFORM FAIL-MIGRATION-STEP
           END-IF
           IF CALL-STATUS = 1
               MOVE 'ALTER TABLE sessions DROP COLUMN context'
                   TO SQL-TEXT
               PERFORM EXECUTE-SQL
           END-IF.

      *> --------------------------------------------------------------
      *> Usage recount
      *>
      *> Streams usage events in (session_id, seq) order and rebuilds
      *> usage_requests, the turn totals, and the session request
      *> totals. Older schemas report cumulative token counts per
      *> request; the stream converts them to increments keyed on raw
      *> input changes, bridging legacy `turn:` ids to native
      *> `request:` ids. Version 7 corrections keep totals whose source
      *> events expired (see correct-v7.sql and the OLD-AMOUNT fields).
      *> --------------------------------------------------------------
       RECOUNT-USAGE.
           MOVE 'SELECT input_tokens, output_tokens, ' &
               'cached_tokens, requests FROM usage_requests ' &
               'WHERE session_id=? AND request_id=?' TO SQL-TEXT
           CALL STATIC "bf_query" USING BY REFERENCE
               FUNCTION CONCATENATE(
                   FUNCTION TRIM(SQL-TEXT), x'00')
               BY REFERENCE REQUEST-STATEMENT
               RETURNING CALL-STATUS
           PERFORM CHECK-STEP-RESULT
           MOVE 'INSERT INTO usage_requests ' &
               'VALUES (?,?,?,?,?,?) ' &
               'ON CONFLICT(session_id,request_id) ' &
               'DO UPDATE SET ' &
               'input_tokens=excluded.input_tokens, ' &
               'output_tokens=excluded.output_tokens, ' &
               'cached_tokens=excluded.cached_tokens, ' &
               'requests=excluded.requests' TO SQL-TEXT
           CALL STATIC "bf_query" USING BY REFERENCE
               FUNCTION CONCATENATE(
                   FUNCTION TRIM(SQL-TEXT), x'00')
               BY REFERENCE SAVE-REQUEST
               RETURNING CALL-STATUS
           PERFORM CHECK-STEP-RESULT
           MOVE 'INSERT INTO migration_turns ' &
               'VALUES (?,?,?,?,?,?,?,?,?,?,?) ' &
               'ON CONFLICT(id) DO UPDATE SET ' &
               'input=input+excluded.input, ' &
               'output=output+excluded.output, ' &
               'cached=cached+excluded.cached, ' &
               'requests=requests+excluded.requests, ' &
               'old_input=old_input+excluded.old_input, ' &
               'old_output=old_output+excluded.old_output, ' &
               'old_cached=old_cached+excluded.old_cached, ' &
               'old_requests=old_requests+excluded.old_requests'
               TO SQL-TEXT
           CALL STATIC "bf_query" USING BY REFERENCE
               FUNCTION CONCATENATE(
                   FUNCTION TRIM(SQL-TEXT), x'00')
               BY REFERENCE SAVE-TURN
               RETURNING CALL-STATUS
           PERFORM CHECK-STEP-RESULT
           MOVE 'INSERT INTO migration_deltas ' &
               'VALUES (?,?,?,?,?,?)' TO SQL-TEXT
           CALL STATIC "bf_query" USING BY REFERENCE
               FUNCTION CONCATENATE(
                   FUNCTION TRIM(SQL-TEXT), x'00')
               BY REFERENCE SAVE-DELTA
               RETURNING CALL-STATUS
           PERFORM CHECK-STEP-RESULT
           MOVE 'UPDATE sessions SET request_input=?, ' &
               'request_output=? WHERE id=?' TO SQL-TEXT
           CALL STATIC "bf_query" USING BY REFERENCE
               FUNCTION CONCATENATE(
                   FUNCTION TRIM(SQL-TEXT), x'00')
               BY REFERENCE SAVE-SESSION
               RETURNING CALL-STATUS
           PERFORM CHECK-STEP-RESULT
           MOVE "SELECT session_id, " &
               "COALESCE(turn_id,'') AS turn_id, ts, " &
               "turn_id IS NOT NULL, " &
               "COALESCE(json_extract(body,'$.requestId'),''), " &
               "COALESCE(json_extract(body,'$.inputTokens'),0), " &
               "COALESCE(json_extract(body,'$.outputTokens'),0), " &
               "COALESCE(json_extract(" &
               "body,'$.cachedInputTokens'),0), " &
               "CASE WHEN json_type(body,'$.billing')='object' " &
               "THEN COALESCE(json_extract(" &
               "body,'$.billing.inputTokens'),0) " &
               "ELSE COALESCE(json_extract(" &
               "body,'$.inputTokens'),0) END, " &
               "CASE WHEN json_type(body,'$.billing')='object' " &
               "THEN COALESCE(json_extract(" &
               "body,'$.billing.outputTokens'),0) " &
               "ELSE COALESCE(json_extract(" &
               "body,'$.outputTokens'),0) END, " &
               "CASE WHEN json_type(body,'$.billing')='object' " &
               "THEN COALESCE(json_extract(" &
               "body,'$.billing.cachedInputTokens'),0) " &
               "ELSE COALESCE(json_extract(" &
               "body,'$.cachedInputTokens'),0) END, " &
               "COALESCE(json_extract(" &
               "body,'$.billing.requests'),1) " &
               "FROM events WHERE type='usage' " &
               "AND CASE WHEN json_valid(body) " &
               "THEN json_type(body)='object' ELSE 0 END " &
               "ORDER BY session_id, seq" TO SQL-TEXT
           CALL STATIC "bf_query" USING BY REFERENCE
               FUNCTION CONCATENATE(
                   FUNCTION TRIM(SQL-TEXT), x'00')
               BY REFERENCE ROW-STATEMENT
               RETURNING CALL-STATUS
           PERFORM CHECK-STEP-RESULT
           CALL STATIC "bf_next" USING BY VALUE ROW-STATEMENT
               RETURNING ROW-STATUS
           PERFORM UNTIL NOT USAGE-ROW-AVAILABLE
               PERFORM READ-USAGE-ROW
               CALL STATIC "bf_next" USING BY VALUE ROW-STATEMENT
                   RETURNING ROW-STATUS
           END-PERFORM
           IF NOT USAGE-STEP-COMPLETE
               PERFORM FAIL-MIGRATION-STEP
           END-IF
           IF LAST-SESSION-ID NOT = SPACES
               PERFORM PERSIST-LAST-REPORT
           END-IF
           CALL STATIC "bf_done" USING BY VALUE ROW-STATEMENT
               RETURNING CALL-STATUS
           PERFORM CHECK-STEP-RESULT
           CALL STATIC "bf_done" USING BY VALUE REQUEST-STATEMENT
               RETURNING CALL-STATUS
           PERFORM CHECK-STEP-RESULT
           CALL STATIC "bf_done" USING BY VALUE SAVE-REQUEST
               RETURNING CALL-STATUS
           PERFORM CHECK-STEP-RESULT
           CALL STATIC "bf_done" USING BY VALUE SAVE-TURN
               RETURNING CALL-STATUS
           PERFORM CHECK-STEP-RESULT
           CALL STATIC "bf_done" USING BY VALUE SAVE-DELTA
               RETURNING CALL-STATUS
           PERFORM CHECK-STEP-RESULT
           CALL STATIC "bf_done" USING BY VALUE SAVE-SESSION
               RETURNING CALL-STATUS
           PERFORM CHECK-STEP-RESULT.

       READ-USAGE-ROW.
           CALL STATIC "bf_text" USING BY VALUE ROW-STATEMENT
               USAGE-COL-SESSION-ID
               BY REFERENCE SESSION-ID
               BY VALUE LENGTH OF SESSION-ID
               RETURNING CALL-STATUS
           PERFORM CHECK-STEP-RESULT
           IF SESSION-ID NOT = LAST-SESSION-ID
               IF LAST-SESSION-ID NOT = SPACES
                   PERFORM PERSIST-LAST-REPORT
               END-IF
               MOVE SESSION-ID TO LAST-SESSION-ID
               MOVE 0 TO LAST-INPUT-TOTAL LAST-OUTPUT-TOTAL
           END-IF
           CALL STATIC "bf_int" USING BY VALUE ROW-STATEMENT
               USAGE-COL-RAW-INPUT
               BY REFERENCE RAW-INPUT-TOKENS
               RETURNING CALL-STATUS
           PERFORM CHECK-STEP-RESULT
           CALL STATIC "bf_int" USING BY VALUE ROW-STATEMENT
               USAGE-COL-RAW-OUTPUT
               BY REFERENCE RAW-OUTPUT-TOKENS
               RETURNING CALL-STATUS
           PERFORM CHECK-STEP-RESULT
           CALL STATIC "bf_int" USING BY VALUE ROW-STATEMENT
               USAGE-COL-RAW-CACHED
               BY REFERENCE RAW-CACHED-TOKENS
               RETURNING CALL-STATUS
           PERFORM CHECK-STEP-RESULT
           INITIALIZE BILLING-AMOUNTS
           IF RAW-INPUT-TOKENS NOT = LAST-INPUT-TOTAL
               MOVE RAW-INPUT-TOKENS TO OLD-AMOUNT (1)
               MOVE RAW-OUTPUT-TOKENS
                   TO OLD-AMOUNT (2) LAST-OUTPUT-TOTAL
               MOVE RAW-CACHED-TOKENS TO OLD-AMOUNT (3)
               MOVE 1 TO OLD-AMOUNT (4)
           ELSE
               COMPUTE OLD-AMOUNT (2) = FUNCTION MAX(0,
                   RAW-OUTPUT-TOKENS - LAST-OUTPUT-TOTAL)
               COMPUTE LAST-OUTPUT-TOTAL = FUNCTION MAX(
                   LAST-OUTPUT-TOTAL, RAW-OUTPUT-TOKENS)
           END-IF
           MOVE RAW-INPUT-TOKENS TO LAST-INPUT-TOTAL
           CALL STATIC "bf_int" USING BY VALUE ROW-STATEMENT
               USAGE-COL-HAS-TURN
               BY REFERENCE TURN-FLAG
               RETURNING CALL-STATUS
           PERFORM CHECK-STEP-RESULT
           IF NOT EVENT-HAS-TURN
               EXIT PARAGRAPH
           END-IF
           CALL STATIC "bf_text" USING BY VALUE ROW-STATEMENT
               USAGE-COL-TURN-ID
               BY REFERENCE TURN-ID
               BY VALUE LENGTH OF TURN-ID
               RETURNING CALL-STATUS
           PERFORM CHECK-STEP-RESULT
           CALL STATIC "bf_int" USING BY VALUE ROW-STATEMENT
               USAGE-COL-EVENT-TIME
               BY REFERENCE EVENT-TIME
               RETURNING CALL-STATUS
           PERFORM CHECK-STEP-RESULT
           CALL STATIC "bf_text" USING BY VALUE ROW-STATEMENT
               USAGE-COL-REQUEST-ID
               BY REFERENCE NATIVE-REQUEST-ID
               BY VALUE LENGTH OF NATIVE-REQUEST-ID
               RETURNING CALL-STATUS
           PERFORM CHECK-STEP-RESULT
           MOVE SPACES TO REQUEST-ID
           IF NATIVE-REQUEST-ID = SPACES
               STRING 'legacy:' FUNCTION TRIM(TURN-ID)
                   INTO REQUEST-ID
               END-STRING
           ELSE
               STRING 'request:' FUNCTION TRIM(NATIVE-REQUEST-ID)
                   INTO REQUEST-ID
               END-STRING
           END-IF
           CALL STATIC "bf_bind_text" USING
               BY VALUE REQUEST-STATEMENT 1
               BY REFERENCE FUNCTION CONCATENATE(
                   FUNCTION TRIM(SESSION-ID), x'00')
               RETURNING CALL-STATUS
           PERFORM CHECK-STEP-RESULT
           CALL STATIC "bf_bind_text" USING
               BY VALUE REQUEST-STATEMENT 2
               BY REFERENCE FUNCTION CONCATENATE(
                   FUNCTION TRIM(REQUEST-ID), x'00')
               RETURNING CALL-STATUS
           PERFORM CHECK-STEP-RESULT
           CALL STATIC "bf_next" USING BY VALUE REQUEST-STATEMENT
               RETURNING ROW-STATUS
           EVALUATE TRUE
               WHEN USAGE-ROW-AVAILABLE
                   PERFORM VARYING METRIC-INDEX FROM 1 BY 1
                       UNTIL METRIC-INDEX > METRIC-COUNT
                       COMPUTE BIND-INDEX =
                           REQUEST-COL-PREVIOUS-FIRST
                           + METRIC-INDEX - 1
                       CALL STATIC "bf_int" USING
                           BY VALUE REQUEST-STATEMENT BIND-INDEX
                           BY REFERENCE
                               PREVIOUS-AMOUNT (METRIC-INDEX)
                           RETURNING CALL-STATUS
                       PERFORM CHECK-STEP-RESULT
                   END-PERFORM
               WHEN USAGE-STEP-COMPLETE
                   CONTINUE
               WHEN OTHER
                   PERFORM FAIL-MIGRATION-STEP
           END-EVALUATE
           CALL STATIC "bf_reset" USING BY VALUE
               REQUEST-STATEMENT
               RETURNING CALL-STATUS
           PERFORM CHECK-STEP-RESULT
           IF NATIVE-REQUEST-ID = SPACES AND
               PREVIOUS-AMOUNT (1) NOT = RAW-INPUT-TOKENS
               PERFORM VARYING METRIC-INDEX FROM 1 BY 1
                   UNTIL METRIC-INDEX > METRIC-COUNT
                   MOVE 0 TO PREVIOUS-AMOUNT (METRIC-INDEX)
               END-PERFORM
           END-IF
           PERFORM VARYING METRIC-INDEX FROM 1 BY 1
               UNTIL METRIC-INDEX > METRIC-COUNT
               COMPUTE BIND-INDEX = USAGE-COL-REPORTED-FIRST
                   + METRIC-INDEX - 1
               CALL STATIC "bf_int" USING BY VALUE ROW-STATEMENT
                   BIND-INDEX
                   BY REFERENCE REPORTED-AMOUNT (METRIC-INDEX)
                   RETURNING CALL-STATUS
               PERFORM CHECK-STEP-RESULT
               COMPUTE DELTA-AMOUNT (METRIC-INDEX) =
                   FUNCTION MAX(0,
                   REPORTED-AMOUNT (METRIC-INDEX)
                   - PREVIOUS-AMOUNT (METRIC-INDEX))
               COMPUTE PREVIOUS-AMOUNT (METRIC-INDEX) =
                   FUNCTION MAX(
                   REPORTED-AMOUNT (METRIC-INDEX),
                   PREVIOUS-AMOUNT (METRIC-INDEX))
           END-PERFORM
           PERFORM PERSIST-USAGE.

       PERSIST-USAGE.
           CALL STATIC "bf_bind_text" USING
               BY VALUE SAVE-REQUEST 1
               BY REFERENCE FUNCTION CONCATENATE(
                   FUNCTION TRIM(SESSION-ID), x'00')
               RETURNING CALL-STATUS
           PERFORM CHECK-STEP-RESULT
           CALL STATIC "bf_bind_text" USING
               BY VALUE SAVE-REQUEST 2
               BY REFERENCE FUNCTION CONCATENATE(
                   FUNCTION TRIM(REQUEST-ID), x'00')
               RETURNING CALL-STATUS
           PERFORM CHECK-STEP-RESULT
           CALL STATIC "bf_bind_text" USING
               BY VALUE SAVE-TURN 1
               BY REFERENCE FUNCTION CONCATENATE(
                   FUNCTION TRIM(TURN-ID), x'00')
               RETURNING CALL-STATUS
           PERFORM CHECK-STEP-RESULT
           CALL STATIC "bf_bind_text" USING
               BY VALUE SAVE-TURN 2
               BY REFERENCE FUNCTION CONCATENATE(
                   FUNCTION TRIM(SESSION-ID), x'00')
               RETURNING CALL-STATUS
           PERFORM CHECK-STEP-RESULT
           CALL STATIC "bf_bind_int" USING BY VALUE SAVE-TURN 3
               BY REFERENCE EVENT-TIME
               RETURNING CALL-STATUS
           PERFORM CHECK-STEP-RESULT
           CALL STATIC "bf_bind_text" USING
               BY VALUE SAVE-DELTA 1
               BY REFERENCE FUNCTION CONCATENATE(
                   FUNCTION TRIM(SESSION-ID), x'00')
               RETURNING CALL-STATUS
           PERFORM CHECK-STEP-RESULT
           CALL STATIC "bf_bind_int" USING BY VALUE SAVE-DELTA 2
               BY REFERENCE EVENT-TIME
               RETURNING CALL-STATUS
           PERFORM CHECK-STEP-RESULT
           PERFORM VARYING METRIC-INDEX FROM 1 BY 1
               UNTIL METRIC-INDEX > METRIC-COUNT
               COMPUTE BIND-INDEX = SAVE-REQUEST-BIND-FIRST
                   + METRIC-INDEX - 1
               CALL STATIC "bf_bind_int" USING
                   BY VALUE SAVE-REQUEST BIND-INDEX
                   BY REFERENCE PREVIOUS-AMOUNT (METRIC-INDEX)
                   RETURNING CALL-STATUS
               PERFORM CHECK-STEP-RESULT
               COMPUTE BIND-INDEX = SAVE-TURN-BIND-DELTA-FIRST
                   + METRIC-INDEX - 1
               CALL STATIC "bf_bind_int" USING
                   BY VALUE SAVE-TURN BIND-INDEX
                   BY REFERENCE DELTA-AMOUNT (METRIC-INDEX)
                   RETURNING CALL-STATUS
               PERFORM CHECK-STEP-RESULT
               COMPUTE BIND-INDEX = SAVE-TURN-BIND-OLD-FIRST
                   + METRIC-INDEX - 1
               CALL STATIC "bf_bind_int" USING
                   BY VALUE SAVE-TURN BIND-INDEX
                   BY REFERENCE OLD-AMOUNT (METRIC-INDEX)
                   RETURNING CALL-STATUS
               PERFORM CHECK-STEP-RESULT
               COMPUTE BIND-INDEX = SAVE-DELTA-BIND-FIRST
                   + METRIC-INDEX - 1
               COMPUTE QUERY-VALUE = DELTA-AMOUNT (METRIC-INDEX)
                   - OLD-AMOUNT (METRIC-INDEX)
               CALL STATIC "bf_bind_int" USING
                   BY VALUE SAVE-DELTA BIND-INDEX
                   BY REFERENCE QUERY-VALUE
                   RETURNING CALL-STATUS
               PERFORM CHECK-STEP-RESULT
           END-PERFORM
           CALL STATIC "bf_run" USING BY VALUE SAVE-REQUEST
               RETURNING CALL-STATUS
           PERFORM CHECK-STEP-RESULT
           CALL STATIC "bf_run" USING BY VALUE SAVE-TURN
               RETURNING CALL-STATUS
           PERFORM CHECK-STEP-RESULT
           IF ADJUST-HOURS-NEEDED
               CALL STATIC "bf_run" USING BY VALUE SAVE-DELTA
                   RETURNING CALL-STATUS
               PERFORM CHECK-STEP-RESULT
           END-IF.

       PERSIST-LAST-REPORT.
           CALL STATIC "bf_bind_int" USING
               BY VALUE SAVE-SESSION 1
               BY REFERENCE LAST-INPUT-TOTAL
               RETURNING CALL-STATUS
           PERFORM CHECK-STEP-RESULT
           CALL STATIC "bf_bind_int" USING
               BY VALUE SAVE-SESSION 2
               BY REFERENCE LAST-OUTPUT-TOTAL
               RETURNING CALL-STATUS
           PERFORM CHECK-STEP-RESULT
           CALL STATIC "bf_bind_text" USING
               BY VALUE SAVE-SESSION 3
               BY REFERENCE FUNCTION CONCATENATE(
                   FUNCTION TRIM(LAST-SESSION-ID), x'00')
               RETURNING CALL-STATUS
           PERFORM CHECK-STEP-RESULT
           CALL STATIC "bf_run" USING BY VALUE SAVE-SESSION
               RETURNING CALL-STATUS
           PERFORM CHECK-STEP-RESULT.

      *> --------------------------------------------------------------
      *> SQLite plumbing (same conventions as the runner's)
      *> --------------------------------------------------------------
       EXECUTE-SQL.
           CALL STATIC "bf_sql" USING BY REFERENCE
               FUNCTION CONCATENATE(
                   FUNCTION TRIM(SQL-TEXT), x'00')
               RETURNING CALL-STATUS
           PERFORM CHECK-STEP-RESULT.

       READ-NUMBER.
           CALL STATIC "bf_number" USING BY REFERENCE
               FUNCTION CONCATENATE(
                   FUNCTION TRIM(SQL-TEXT), x'00')
               BY REFERENCE QUERY-VALUE
               RETURNING CALL-STATUS
           PERFORM CHECK-STEP-RESULT.

       COPY "handler-procedures.cpy".

       CHECK-STEP-RESULT.
           IF CALL-STATUS NOT = MIGRATION-OK
               PERFORM FAIL-MIGRATION-STEP
           END-IF.

       FAIL-MIGRATION-STEP.
      *> Never returns: the runner reports the message (from the C
      *> layer when LS-ERROR-MESSAGE is spaces) and rolls everything
      *> back.
           MOVE MIGRATION-FAILED TO RETURN-CODE
           GOBACK.

