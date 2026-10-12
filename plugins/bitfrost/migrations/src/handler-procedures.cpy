      *> Copyright (C) 2026 Nick Germaine
      *> SPDX-License-Identifier: GPL-3.0-only
       APPLY-SQL-FILE.
           MOVE 'sql' TO FILE-OPERATION
           PERFORM APPLY-VERSION-FILE.

       APPLY-COLUMNS.
           MOVE 'columns' TO FILE-OPERATION
           PERFORM APPLY-VERSION-FILE.

       APPLY-VERSION-FILE.
           CALL "MIGRATION-IO" USING BY REFERENCE
               LS-MIGRATION-DIR FILE-OPERATION STEP-NAME
               LS-ERROR-MESSAGE
           IF RETURN-CODE NOT = MIGRATION-OK
               GOBACK
           END-IF.
