      *> Copyright (C) 2026 Nick Germaine
      *> SPDX-License-Identifier: GPL-3.0-only
      *> Schema v4: Add and populate session aggregates and history
      *> indexes.
       IDENTIFICATION DIVISION.
       PROGRAM-ID. MIGRATION-V4.

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
           MOVE 'columns' TO STEP-NAME
           PERFORM APPLY-COLUMNS
           MOVE 'totals.sql' TO STEP-NAME
           PERFORM APPLY-SQL-FILE
           MOVE 'indexes.sql' TO STEP-NAME
           PERFORM APPLY-SQL-FILE
           MOVE MIGRATION-OK TO RETURN-CODE
           GOBACK.

       COPY "handler-procedures.cpy".
