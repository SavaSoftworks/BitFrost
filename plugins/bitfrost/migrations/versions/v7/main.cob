      *> Copyright (C) 2026 Nick Germaine
      *> SPDX-License-Identifier: GPL-3.0-only
      *> Schema v7: Restore full input billing for expired v6 turns.
       IDENTIFICATION DIVISION.
       PROGRAM-ID. MIGRATION-V7.

       DATA DIVISION.
       WORKING-STORAGE SECTION.
       COPY "handler-ws.cpy".

       LINKAGE SECTION.
       01  LS-MIGRATION-DIR                      PIC X(4096).
       01  LS-SOURCE-VERSION                     BINARY-DOUBLE SIGNED.
       01  LS-ERROR-MESSAGE                      PIC X(2048).

       PROCEDURE DIVISION USING LS-MIGRATION-DIR LS-SOURCE-VERSION
           LS-ERROR-MESSAGE.
       APPLY-VERSION.
      *> SOURCE is the version at transaction entry, not the last step.
           IF LS-SOURCE-VERSION = 6
               MOVE 'restore-input.sql' TO STEP-NAME
               PERFORM APPLY-SQL-FILE
           END-IF
           MOVE 'schema.sql' TO STEP-NAME
           PERFORM APPLY-SQL-FILE
           MOVE 'totals.sql' TO STEP-NAME
           PERFORM APPLY-SQL-FILE
           MOVE 'rollups.sql' TO STEP-NAME
           PERFORM APPLY-SQL-FILE
           MOVE MIGRATION-OK TO RETURN-CODE
           GOBACK.

       COPY "handler-procedures.cpy".
