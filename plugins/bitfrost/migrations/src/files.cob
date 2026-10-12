      *> Copyright (C) 2026 Nick Germaine
      *> SPDX-License-Identifier: GPL-3.0-only
      *> Shared SQL-file and additive-column operations. The runner owns
      *> the transaction; each version owns its files and ordering.
       IDENTIFICATION DIVISION.
       PROGRAM-ID. MIGRATION-IO IS COMMON.

       ENVIRONMENT DIVISION.
       INPUT-OUTPUT SECTION.
       FILE-CONTROL.
           SELECT SCHEMA-COLUMN-FILE ASSIGN TO STEP-FILE-PATH
               ORGANIZATION IS LINE SEQUENTIAL
               FILE STATUS IS MIGRATION-FILE-STATUS.

       DATA DIVISION.
       FILE SECTION.
       FD  SCHEMA-COLUMN-FILE.
       01  COLUMN-LINE                           PIC X(4096).

       WORKING-STORAGE SECTION.
       COPY "sqlite.cpy".
       01  CALL-STATUS                           BINARY-LONG.
       01  SQL-TEXT                              PIC X(32768).
       01  STEP-FILE-PATH                        PIC X(4096).
       01  COLUMN-TABLE-NAME                     PIC X(256).
       01  COLUMN-COLUMN-NAME                    PIC X(256).
       01  COLUMN-DEFINITION                     PIC X(256).

       LINKAGE SECTION.
       01  LS-MIGRATION-DIR                      PIC X(4096).
       01  LS-OPERATION                          PIC X(16).
       01  STEP-NAME                             PIC X(256).
       01  LS-ERROR-MESSAGE                      PIC X(2048).

       PROCEDURE DIVISION USING LS-MIGRATION-DIR LS-OPERATION
           STEP-NAME LS-ERROR-MESSAGE.
       APPLY-FILE.
           EVALUATE LS-OPERATION
               WHEN 'sql'
                   PERFORM EXECUTE-STEP-FILE
               WHEN 'columns'
                   PERFORM ADD-SCHEMA-COLUMNS
               WHEN OTHER
                   MOVE 'Unknown migration file operation'
                       TO LS-ERROR-MESSAGE
                   PERFORM FAIL-MIGRATION-STEP
           END-EVALUATE
           MOVE MIGRATION-OK TO RETURN-CODE
           GOBACK.

       ADD-SCHEMA-COLUMNS.
           MOVE SPACES TO STEP-FILE-PATH
           STRING FUNCTION TRIM(LS-MIGRATION-DIR) '/'
               FUNCTION TRIM(STEP-NAME)
               INTO STEP-FILE-PATH
           END-STRING
           OPEN INPUT SCHEMA-COLUMN-FILE
           IF NOT MIGRATION-FILE-OK
               MOVE 'Cannot open schema column definitions'
                   TO LS-ERROR-MESSAGE
               PERFORM FAIL-MIGRATION-STEP
           END-IF
           PERFORM UNTIL MIGRATION-FILE-EOF
               READ SCHEMA-COLUMN-FILE
               EVALUATE TRUE
                   WHEN MIGRATION-FILE-EOF
                       CONTINUE
                   WHEN MIGRATION-FILE-OK
                       IF COLUMN-LINE NOT = SPACES AND
                           COLUMN-LINE(1:1) NOT = '#'
                           PERFORM ENSURE-SCHEMA-COLUMN
                       END-IF
                   WHEN OTHER
                       MOVE 'Cannot read schema column definitions'
                           TO LS-ERROR-MESSAGE
                       PERFORM FAIL-MIGRATION-STEP
               END-EVALUATE
           END-PERFORM
           CLOSE SCHEMA-COLUMN-FILE.

       ENSURE-SCHEMA-COLUMN.
           MOVE SPACES TO COLUMN-TABLE-NAME COLUMN-COLUMN-NAME
               COLUMN-DEFINITION
           UNSTRING COLUMN-LINE DELIMITED BY '|'
               INTO COLUMN-TABLE-NAME COLUMN-COLUMN-NAME
                   COLUMN-DEFINITION
           END-UNSTRING
           IF COLUMN-TABLE-NAME = SPACES OR
               COLUMN-COLUMN-NAME = SPACES OR
               COLUMN-DEFINITION = SPACES
               MOVE 'Invalid schema column definition entry'
                   TO LS-ERROR-MESSAGE
               PERFORM FAIL-MIGRATION-STEP
           END-IF
           MOVE FUNCTION TRIM(COLUMN-TABLE-NAME)
               TO IDENTIFIER-UNDER-TEST
           PERFORM CHECK-IDENTIFIER
           IF NOT IDENTIFIER-IS-SAFE
               MOVE 'Invalid schema column definition entry'
                   TO LS-ERROR-MESSAGE
               PERFORM FAIL-MIGRATION-STEP
           END-IF
           MOVE FUNCTION TRIM(COLUMN-COLUMN-NAME)
               TO IDENTIFIER-UNDER-TEST
           PERFORM CHECK-IDENTIFIER
           IF NOT IDENTIFIER-IS-SAFE
               MOVE 'Invalid schema column definition entry'
                   TO LS-ERROR-MESSAGE
               PERFORM FAIL-MIGRATION-STEP
           END-IF
           CALL STATIC "bf_column" USING BY REFERENCE
               FUNCTION CONCATENATE(
                   FUNCTION TRIM(COLUMN-TABLE-NAME), x'00')
               FUNCTION CONCATENATE(
                   FUNCTION TRIM(COLUMN-COLUMN-NAME), x'00')
               RETURNING CALL-STATUS
           IF CALL-STATUS < 0
               PERFORM FAIL-MIGRATION-STEP
           END-IF
           IF CALL-STATUS = 0
               MOVE SPACES TO SQL-TEXT
               STRING 'ALTER TABLE '
                   FUNCTION TRIM(COLUMN-TABLE-NAME)
                   ' ADD COLUMN '
                   FUNCTION TRIM(COLUMN-COLUMN-NAME) ' '
                   FUNCTION TRIM(COLUMN-DEFINITION)
                   INTO SQL-TEXT
               END-STRING
               PERFORM EXECUTE-SQL
           END-IF.

       EXECUTE-SQL.
           CALL STATIC "bf_sql" USING BY REFERENCE
               FUNCTION CONCATENATE(
                   FUNCTION TRIM(SQL-TEXT), x'00')
               RETURNING CALL-STATUS
           PERFORM CHECK-STEP-RESULT.

       EXECUTE-STEP-FILE.
           MOVE SPACES TO STEP-FILE-PATH
           STRING FUNCTION TRIM(LS-MIGRATION-DIR) '/'
               FUNCTION TRIM(STEP-NAME)
               INTO STEP-FILE-PATH
           END-STRING
           CALL STATIC "bf_file" USING BY REFERENCE
               FUNCTION CONCATENATE(
                   FUNCTION TRIM(STEP-FILE-PATH), x'00')
               RETURNING CALL-STATUS
           PERFORM CHECK-STEP-RESULT.

       CHECK-IDENTIFIER.
      *> Same contract as the runner's CHECK-IDENTIFIER: only
      *> characters in IDENTIFIER-ALLOWED-CHARS pass; empty names are
      *> the caller's concern.
           MOVE 'Y' TO IDENTIFIER-CHECK-FLAG
           MOVE FUNCTION TRIM(IDENTIFIER-UNDER-TEST)
               TO IDENTIFIER-TRIMMED
           COMPUTE IDENTIFIER-LENGTH = FUNCTION LENGTH(
               FUNCTION TRIM(IDENTIFIER-UNDER-TEST))
           PERFORM VARYING IDENTIFIER-CHAR-INDEX FROM 1 BY 1
               UNTIL IDENTIFIER-CHAR-INDEX > IDENTIFIER-LENGTH
                   OR NOT IDENTIFIER-IS-SAFE
               MOVE 'N' TO IDENTIFIER-CHECK-FLAG
               PERFORM VARYING IDENTIFIER-ALLOW-INDEX
                   FROM 1 BY 1
                   UNTIL IDENTIFIER-ALLOW-INDEX
                       > IDENTIFIER-ALLOWED-CHAR-COUNT
                       OR IDENTIFIER-CHECK-FLAG = 'Y'
                   IF IDENTIFIER-TRIMMED(
                           IDENTIFIER-CHAR-INDEX:1) =
                       IDENTIFIER-ALLOWED-CHARS(
                           IDENTIFIER-ALLOW-INDEX:1)
                       MOVE 'Y' TO IDENTIFIER-CHECK-FLAG
                   END-IF
               END-PERFORM
           END-PERFORM.

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
