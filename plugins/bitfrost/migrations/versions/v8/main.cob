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

      *> SQLite call state. QUERY-VALUE receives READ-NUMBER scalars.
       01  CALL-STATUS                           BINARY-LONG.
       01  QUERY-VALUE                           BINARY-DOUBLE SIGNED.
       01  SQL-TEXT                              PIC X(32768).

      *> Column positions in the usage-events SELECT of RECOUNT-USAGE.
      *> USAGE-TIME: event time and turn flag at columns 2..3.
      *> USAGE-AMOUNTS: raw input/output/cached, then four reported
      *> billing metrics, at columns 5..11. Turn binds: delta/old runs.
       78  USAGE-COL-SESSION-ID                  VALUE 0.
       78  USAGE-COL-TURN-ID                     VALUE 1.
       78  USAGE-COL-EVENT-TIME                  VALUE 2.
       78  USAGE-COL-REQUEST-ID                  VALUE 4.
       78  USAGE-COL-RAW-INPUT                   VALUE 5.
       78  USAGE-AMOUNT-COUNT                    VALUE 7.
       78  USAGE-TIME-COUNT                      VALUE 2.
       78  TURN-AMOUNT-COUNT                     VALUE 8.
       78  METRIC-COUNT                          VALUE 4.

      *> First position of each contiguous four-metric run.
      *>  REQUEST-COL-PREVIOUS-FIRST: columns of the usage_requests
      *>                                lookup
      *>  SAVE-REQUEST-BIND-FIRST:      cumulative values in
      *>                                usage_requests
      *>  SAVE-TURN-BIND-DELTA-FIRST:   per-request deltas in
      *>                                migration_turns
      *>  SAVE-DELTA-BIND-FIRST:        corrections in
      *>                                migration_deltas
       78  REQUEST-COL-PREVIOUS-FIRST            VALUE 0.
       78  SAVE-REQUEST-BIND-FIRST               VALUE 3.
       78  SAVE-TURN-BIND-DELTA-FIRST            VALUE 4.
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
       01  METRIC-INDEX                          BINARY-LONG.

      *> Row state for the usage event stream.
       01  SESSION-ID                            PIC X(4096).
       01  LAST-SESSION-ID                       PIC X(4096).
       01  TURN-ID                               PIC X(4096).
       01  REQUEST-ID                            PIC X(8192).
       01  NATIVE-REQUEST-ID                     PIC X(4096).
      *> The C transport reads adjacent SQLite int64 columns into
      *> these contiguous native signed 64-bit groups, with no padding.
       01  USAGE-TIME.
           05  EVENT-TIME                       BINARY-DOUBLE SIGNED.
           05  TURN-FLAG                        BINARY-DOUBLE SIGNED.
               88  EVENT-HAS-TURN                  VALUE 1.
       01  LAST-INPUT-TOTAL                      BINARY-DOUBLE SIGNED
                                                       VALUE 0.
       01  LAST-OUTPUT-TOTAL                     BINARY-DOUBLE SIGNED
                                                       VALUE 0.
       01  USAGE-AMOUNTS.
           05  RAW-INPUT-TOKENS                 BINARY-DOUBLE SIGNED.
           05  RAW-OUTPUT-TOKENS                BINARY-DOUBLE SIGNED.
           05  RAW-CACHED-TOKENS                BINARY-DOUBLE SIGNED.
           05  REPORTED-AMOUNTS.
               10  REPORTED-AMOUNT OCCURS 4 TIMES
                                               BINARY-DOUBLE SIGNED.

      *> Metrics: input, output, cached, requests. Group moves copy
      *> identical native int64 layouts. Billing arithmetic stays here.
       01  BILLING-AMOUNTS.
           05  PREVIOUS-AMOUNTS.
               10  PREVIOUS-AMOUNT OCCURS 4 TIMES
                                               BINARY-DOUBLE SIGNED.
           05  DELTA-AMOUNTS.
               10  DELTA-AMOUNT OCCURS 4 TIMES
                                               BINARY-DOUBLE SIGNED.
           05  OLD-AMOUNTS.
               10  OLD-AMOUNT OCCURS 4 TIMES    BINARY-DOUBLE SIGNED.
       01  CORRECTION-AMOUNTS.
           05  CORRECTION-AMOUNT OCCURS 4 TIMES
                                               BINARY-DOUBLE SIGNED.

      *> Keep adjacent reports in memory. Flush before changing keys
      *> and at end of stream; nonadjacent requests still use SQLite.
      *> Delta rows retain each event's timestamp for hourly correction.
       01  SESSION-KEY                          PIC X(4097)
                                                   VALUE LOW-VALUES.
       01  REQUEST-KEY                          PIC X(8193).
       01  TURN-KEY                             PIC X(4097).
       01  REQUEST-CACHE-FLAG                   PIC X VALUE 'N'.
           88  REQUEST-CACHE-ACTIVE                VALUE 'Y'.
       01  REQUEST-CACHE-ID                     PIC X(8192).
       01  REQUEST-CACHE-SESSION                PIC X(4096).
       01  REQUEST-CACHE-AMOUNTS.
           05  CACHED-REQUEST-AMOUNT OCCURS 4 TIMES
                                               BINARY-DOUBLE SIGNED.
       01  TURN-CACHE-FLAG                      PIC X VALUE 'N'.
           88  TURN-CACHE-ACTIVE                   VALUE 'Y'.
       01  TURN-CACHE-ID                        PIC X(4096).
       01  TURN-CACHE-SESSION                   PIC X(4096).

      *> Slice lengths delimit SQLite text; tails are never inspected.
       01  SESSION-ID-LENGTH                    BINARY-LONG VALUE 1.
       01  LAST-SESSION-ID-LENGTH               BINARY-LONG VALUE 1.
       01  TURN-ID-LENGTH                       BINARY-LONG VALUE 1.
       01  NATIVE-REQUEST-ID-LENGTH             BINARY-LONG VALUE 1.
       01  REQUEST-ID-LENGTH                    BINARY-LONG VALUE 1.
       01  REQUEST-CACHE-ID-LENGTH              BINARY-LONG VALUE 1.
       01  REQUEST-CACHE-SESSION-LENGTH         BINARY-LONG VALUE 1.
       01  TURN-CACHE-ID-LENGTH                 BINARY-LONG VALUE 1.
       01  TURN-CACHE-SESSION-LENGTH            BINARY-LONG VALUE 1.

       01  TURN-CACHE-AMOUNTS.
           05  CACHED-TURN-DELTAS.
               10  CACHED-TURN-DELTA OCCURS 4 TIMES
                                               BINARY-DOUBLE SIGNED.
           05  CACHED-TURN-OLDS.
               10  CACHED-TURN-OLD OCCURS 4 TIMES
                                               BINARY-DOUBLE SIGNED.

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
           IF REQUEST-CACHE-ACTIVE
               PERFORM PERSIST-CACHED-REQUEST
           END-IF
           IF TURN-CACHE-ACTIVE
               PERFORM PERSIST-CACHED-TURN
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
           CALL STATIC "bf_text_slice" USING BY VALUE ROW-STATEMENT
               USAGE-COL-SESSION-ID
               BY REFERENCE SESSION-ID
               BY VALUE LENGTH OF SESSION-ID
               BY REFERENCE SESSION-ID-LENGTH
               RETURNING CALL-STATUS
           PERFORM CHECK-STEP-RESULT
           IF SESSION-ID(1:SESSION-ID-LENGTH) NOT =
               LAST-SESSION-ID(1:LAST-SESSION-ID-LENGTH)
               IF LAST-SESSION-ID NOT = SPACES
                   PERFORM PERSIST-LAST-REPORT
               END-IF
               MOVE SESSION-ID(1:SESSION-ID-LENGTH)
                   TO LAST-SESSION-ID
               MOVE SESSION-ID-LENGTH TO LAST-SESSION-ID-LENGTH
               MOVE 0 TO LAST-INPUT-TOTAL LAST-OUTPUT-TOTAL
               STRING FUNCTION TRIM(
                   SESSION-ID(1:SESSION-ID-LENGTH)) x'00'
                   INTO SESSION-KEY
               END-STRING
           END-IF
           CALL STATIC "bf_ints" USING BY VALUE ROW-STATEMENT
               USAGE-COL-RAW-INPUT USAGE-AMOUNT-COUNT
               BY REFERENCE USAGE-AMOUNTS
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
               IF RAW-OUTPUT-TOKENS > LAST-OUTPUT-TOTAL
                   MOVE RAW-OUTPUT-TOKENS TO OLD-AMOUNT (2)
                   SUBTRACT LAST-OUTPUT-TOTAL FROM OLD-AMOUNT (2)
                   MOVE RAW-OUTPUT-TOKENS TO LAST-OUTPUT-TOTAL
               END-IF
           END-IF
           MOVE RAW-INPUT-TOKENS TO LAST-INPUT-TOTAL
           CALL STATIC "bf_ints" USING BY VALUE ROW-STATEMENT
               USAGE-COL-EVENT-TIME USAGE-TIME-COUNT
               BY REFERENCE USAGE-TIME
               RETURNING CALL-STATUS
           PERFORM CHECK-STEP-RESULT
           IF NOT EVENT-HAS-TURN
               EXIT PARAGRAPH
           END-IF
           CALL STATIC "bf_text_slice" USING BY VALUE ROW-STATEMENT
               USAGE-COL-TURN-ID
               BY REFERENCE TURN-ID
               BY VALUE LENGTH OF TURN-ID
               BY REFERENCE TURN-ID-LENGTH
               RETURNING CALL-STATUS
           PERFORM CHECK-STEP-RESULT
           CALL STATIC "bf_text_slice" USING BY VALUE ROW-STATEMENT
               USAGE-COL-REQUEST-ID
               BY REFERENCE NATIVE-REQUEST-ID
               BY VALUE LENGTH OF NATIVE-REQUEST-ID
               BY REFERENCE NATIVE-REQUEST-ID-LENGTH
               RETURNING CALL-STATUS
           PERFORM CHECK-STEP-RESULT
           IF NATIVE-REQUEST-ID(1:NATIVE-REQUEST-ID-LENGTH) = SPACES
               STRING 'legacy:' FUNCTION TRIM(
                   TURN-ID(1:TURN-ID-LENGTH))
                   INTO REQUEST-ID
               END-STRING
               MOVE FUNCTION LENGTH(FUNCTION TRIM(
                   TURN-ID(1:TURN-ID-LENGTH))) TO REQUEST-ID-LENGTH
               ADD 7 TO REQUEST-ID-LENGTH
           ELSE
               STRING 'request:' FUNCTION TRIM(
                   NATIVE-REQUEST-ID(1:NATIVE-REQUEST-ID-LENGTH))
                   INTO REQUEST-ID
               END-STRING
               MOVE FUNCTION LENGTH(FUNCTION TRIM(
                   NATIVE-REQUEST-ID(1:NATIVE-REQUEST-ID-LENGTH)))
                   TO REQUEST-ID-LENGTH
               ADD 8 TO REQUEST-ID-LENGTH
           END-IF
           IF NOT REQUEST-CACHE-ACTIVE OR
               REQUEST-ID(1:REQUEST-ID-LENGTH) NOT =
                   REQUEST-CACHE-ID(1:REQUEST-CACHE-ID-LENGTH) OR
               SESSION-ID(1:SESSION-ID-LENGTH) NOT =
                   REQUEST-CACHE-SESSION(
                       1:REQUEST-CACHE-SESSION-LENGTH)
               PERFORM CHANGE-REQUEST-CACHE
           END-IF
           MOVE REQUEST-CACHE-AMOUNTS TO PREVIOUS-AMOUNTS
           IF NATIVE-REQUEST-ID(1:NATIVE-REQUEST-ID-LENGTH) = SPACES AND
               PREVIOUS-AMOUNT (1) NOT = RAW-INPUT-TOKENS
               INITIALIZE PREVIOUS-AMOUNTS
           END-IF
           PERFORM VARYING METRIC-INDEX FROM 1 BY 1
               UNTIL METRIC-INDEX > METRIC-COUNT
               IF REPORTED-AMOUNT (METRIC-INDEX) >
                   PREVIOUS-AMOUNT (METRIC-INDEX)
                   MOVE REPORTED-AMOUNT (METRIC-INDEX)
                       TO DELTA-AMOUNT (METRIC-INDEX)
                   SUBTRACT PREVIOUS-AMOUNT (METRIC-INDEX)
                       FROM DELTA-AMOUNT (METRIC-INDEX)
                   MOVE REPORTED-AMOUNT (METRIC-INDEX)
                       TO PREVIOUS-AMOUNT (METRIC-INDEX)
               END-IF
               MOVE PREVIOUS-AMOUNT (METRIC-INDEX)
                   TO CACHED-REQUEST-AMOUNT (METRIC-INDEX)
           END-PERFORM
           PERFORM CACHE-TURN-USAGE
           IF ADJUST-HOURS-NEEDED
               PERFORM PERSIST-EVENT-DELTA
           END-IF.

       CHANGE-REQUEST-CACHE.
           IF REQUEST-CACHE-ACTIVE
               PERFORM PERSIST-CACHED-REQUEST
           END-IF
           SET REQUEST-CACHE-ACTIVE TO TRUE
           MOVE REQUEST-ID(1:REQUEST-ID-LENGTH) TO REQUEST-CACHE-ID
           MOVE REQUEST-ID-LENGTH TO REQUEST-CACHE-ID-LENGTH
           MOVE SESSION-ID(1:SESSION-ID-LENGTH)
               TO REQUEST-CACHE-SESSION
           MOVE SESSION-ID-LENGTH TO REQUEST-CACHE-SESSION-LENGTH
           INITIALIZE REQUEST-CACHE-AMOUNTS
           STRING FUNCTION TRIM(
               REQUEST-ID(1:REQUEST-ID-LENGTH)) x'00'
               INTO REQUEST-KEY
           END-STRING
           CALL STATIC "bf_bind_text" USING
               BY VALUE REQUEST-STATEMENT 1
               BY REFERENCE SESSION-KEY
               RETURNING CALL-STATUS
           PERFORM CHECK-STEP-RESULT
           CALL STATIC "bf_bind_text" USING
               BY VALUE REQUEST-STATEMENT 2
               BY REFERENCE REQUEST-KEY
               RETURNING CALL-STATUS
           PERFORM CHECK-STEP-RESULT
           CALL STATIC "bf_next" USING BY VALUE REQUEST-STATEMENT
               RETURNING ROW-STATUS
           EVALUATE TRUE
               WHEN USAGE-ROW-AVAILABLE
                   CALL STATIC "bf_ints" USING
                       BY VALUE REQUEST-STATEMENT
                           REQUEST-COL-PREVIOUS-FIRST METRIC-COUNT
                       BY REFERENCE REQUEST-CACHE-AMOUNTS
                       RETURNING CALL-STATUS
                   PERFORM CHECK-STEP-RESULT
               WHEN USAGE-STEP-COMPLETE
                   CONTINUE
               WHEN OTHER
                   PERFORM FAIL-MIGRATION-STEP
           END-EVALUATE
           CALL STATIC "bf_reset" USING BY VALUE REQUEST-STATEMENT
               RETURNING CALL-STATUS
           PERFORM CHECK-STEP-RESULT
           CALL STATIC "bf_bind_text" USING BY VALUE SAVE-REQUEST 1
               BY REFERENCE SESSION-KEY
               RETURNING CALL-STATUS
           PERFORM CHECK-STEP-RESULT
           CALL STATIC "bf_bind_text" USING BY VALUE SAVE-REQUEST 2
               BY REFERENCE REQUEST-KEY
               RETURNING CALL-STATUS
           PERFORM CHECK-STEP-RESULT.

       PERSIST-CACHED-REQUEST.
           CALL STATIC "bf_bind_ints" USING
               BY VALUE SAVE-REQUEST SAVE-REQUEST-BIND-FIRST
                   METRIC-COUNT
               BY REFERENCE REQUEST-CACHE-AMOUNTS
               RETURNING CALL-STATUS
           PERFORM CHECK-STEP-RESULT
           CALL STATIC "bf_run" USING BY VALUE SAVE-REQUEST
               RETURNING CALL-STATUS
           PERFORM CHECK-STEP-RESULT.

       CACHE-TURN-USAGE.
           IF NOT TURN-CACHE-ACTIVE OR
               TURN-ID(1:TURN-ID-LENGTH) NOT =
                   TURN-CACHE-ID(1:TURN-CACHE-ID-LENGTH) OR
               SESSION-ID(1:SESSION-ID-LENGTH) NOT =
                   TURN-CACHE-SESSION(1:TURN-CACHE-SESSION-LENGTH)
               IF TURN-CACHE-ACTIVE
                   PERFORM PERSIST-CACHED-TURN
               END-IF
               SET TURN-CACHE-ACTIVE TO TRUE
               MOVE TURN-ID(1:TURN-ID-LENGTH) TO TURN-CACHE-ID
               MOVE TURN-ID-LENGTH TO TURN-CACHE-ID-LENGTH
               MOVE SESSION-ID(1:SESSION-ID-LENGTH)
                   TO TURN-CACHE-SESSION
               MOVE SESSION-ID-LENGTH TO TURN-CACHE-SESSION-LENGTH
               INITIALIZE TURN-CACHE-AMOUNTS
               STRING FUNCTION TRIM(TURN-ID(1:TURN-ID-LENGTH))
                   x'00' INTO TURN-KEY
               END-STRING
               CALL STATIC "bf_bind_text" USING BY VALUE SAVE-TURN 1
                   BY REFERENCE TURN-KEY
                   RETURNING CALL-STATUS
               PERFORM CHECK-STEP-RESULT
               CALL STATIC "bf_bind_text" USING BY VALUE SAVE-TURN 2
                   BY REFERENCE SESSION-KEY
                   RETURNING CALL-STATUS
               PERFORM CHECK-STEP-RESULT
               CALL STATIC "bf_bind_int" USING BY VALUE SAVE-TURN 3
                   BY REFERENCE EVENT-TIME
                   RETURNING CALL-STATUS
               PERFORM CHECK-STEP-RESULT
           END-IF
           PERFORM VARYING METRIC-INDEX FROM 1 BY 1
               UNTIL METRIC-INDEX > METRIC-COUNT
               ADD DELTA-AMOUNT (METRIC-INDEX)
                   TO CACHED-TURN-DELTA (METRIC-INDEX)
               ADD OLD-AMOUNT (METRIC-INDEX)
                   TO CACHED-TURN-OLD (METRIC-INDEX)
           END-PERFORM.

       PERSIST-CACHED-TURN.
           CALL STATIC "bf_bind_ints" USING
               BY VALUE SAVE-TURN SAVE-TURN-BIND-DELTA-FIRST
                   TURN-AMOUNT-COUNT
               BY REFERENCE TURN-CACHE-AMOUNTS
               RETURNING CALL-STATUS
           PERFORM CHECK-STEP-RESULT
           CALL STATIC "bf_run" USING BY VALUE SAVE-TURN
               RETURNING CALL-STATUS
           PERFORM CHECK-STEP-RESULT.

       PERSIST-EVENT-DELTA.
           CALL STATIC "bf_bind_text" USING BY VALUE SAVE-DELTA 1
               BY REFERENCE SESSION-KEY
               RETURNING CALL-STATUS
           PERFORM CHECK-STEP-RESULT
           CALL STATIC "bf_bind_int" USING BY VALUE SAVE-DELTA 2
               BY REFERENCE EVENT-TIME
               RETURNING CALL-STATUS
           PERFORM CHECK-STEP-RESULT
           PERFORM VARYING METRIC-INDEX FROM 1 BY 1
               UNTIL METRIC-INDEX > METRIC-COUNT
               MOVE DELTA-AMOUNT (METRIC-INDEX)
                   TO CORRECTION-AMOUNT (METRIC-INDEX)
               SUBTRACT OLD-AMOUNT (METRIC-INDEX)
                   FROM CORRECTION-AMOUNT (METRIC-INDEX)
           END-PERFORM
           CALL STATIC "bf_bind_ints" USING
               BY VALUE SAVE-DELTA SAVE-DELTA-BIND-FIRST METRIC-COUNT
               BY REFERENCE CORRECTION-AMOUNTS
               RETURNING CALL-STATUS
           PERFORM CHECK-STEP-RESULT
           CALL STATIC "bf_run" USING BY VALUE SAVE-DELTA
               RETURNING CALL-STATUS
           PERFORM CHECK-STEP-RESULT.

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
