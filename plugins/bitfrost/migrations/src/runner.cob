      *> Copyright (C) 2026 Nick Germaine
      *> SPDX-License-Identifier: GPL-3.0-only
      *>
      *> The engine checks the complete versions/vN chain against the
      *> compiled registry, then applies each pending main.cob inside
      *> one backed-up transaction. Version files own their processing.
       IDENTIFICATION DIVISION.
       PROGRAM-ID. BITFROST-MIGRATE.

       ENVIRONMENT DIVISION.
       INPUT-OUTPUT SECTION.
       FILE-CONTROL.
           SELECT MIGRATION-PLAN-FILE ASSIGN TO STEP-FILE-PATH
               ORGANIZATION IS LINE SEQUENTIAL
               FILE STATUS IS MIGRATION-FILE-STATUS.

       DATA DIVISION.
       FILE SECTION.
       FD  MIGRATION-PLAN-FILE.
       01  PLAN-FILE-LINE                        PIC X(4096).

       WORKING-STORAGE SECTION.
       COPY "sqlite.cpy".
       COPY "registry.cpy".

      *> Command line and installation paths.
       01  ARG-COUNT                             BINARY-LONG.
       01  ARG-INDEX                             BINARY-LONG.
       01  ARG-TEXT                              PIC X(4096).
       01  OPTION-NAME                           PIC X(32).
       01  DATABASE-PATH                         PIC X(4096).
       01  MIGRATION-DIR                         PIC X(4096).
       01  VERSION-DIR                           PIC X(4096).
       01  BACKUP-DIR                            PIC X(4096).
       01  BACKUP-PATH                           PIC X(4096).
       01  STEP-FILE-PATH                        PIC X(4096).
       01  STEP-NAME                             PIC X(256).

      *> SQLite state and the original/current database versions.
       01  LOCK-OWNER                            BINARY-LONG
                                                       VALUE 0.
       01  CALL-STATUS                           BINARY-LONG.
       01  CLOSE-STATUS                          BINARY-LONG.
       01  QUERY-VALUE                           BINARY-DOUBLE SIGNED.
       01  SQL-TEXT                              PIC X(32768).
       01  ERROR-MESSAGE                         PIC X(2048).
       01  SOURCE-VERSION                        BINARY-DOUBLE SIGNED.
       01  CURRENT-VERSION                       BINARY-DOUBLE SIGNED.
       01  TARGET-VERSION                        BINARY-DOUBLE SIGNED.
       01  STEP-INDEX                            BINARY-LONG.
       01  DISPLAY-VERSION                       PIC Z(9)9.

      *> Directory order is unspecified. Mark each canonical vN once,
      *> then walk the numeric sequence, requiring every folder/file.
       78  VERSION-LIMIT                         VALUE 256.
       01  DIRECTORY-ENTRY                       PIC X(256).
       01  DIRECTORY-NUMBER                      BINARY-LONG.
       01  CANONICAL-NAME                        PIC X(256).
       01  DIRECTORY-STATUS                      BINARY-LONG.
           88  DIRECTORY-END                       VALUE 2.
       01  VERSION-TABLE.
           05  VERSION-SEEN                      PIC X
               OCCURS 256 TIMES VALUE 'N'.
       01  RESOURCE-COUNT                        BINARY-LONG.

       PROCEDURE DIVISION.
       MAIN.
           PERFORM PARSE-COMMAND-LINE
           PERFORM LOAD-VERSIONS
           PERFORM PREPARE-DATABASE
           PERFORM APPLY-MIGRATION-STEPS
           PERFORM FINALIZE-MIGRATION
           PERFORM FINISH.

       PARSE-COMMAND-LINE.
           ACCEPT ARG-COUNT FROM ARGUMENT-NUMBER
           PERFORM VARYING ARG-INDEX FROM 1 BY 1
               UNTIL ARG-INDEX > ARG-COUNT
               ACCEPT ARG-TEXT FROM ARGUMENT-VALUE
               IF ARG-TEXT = '--version'
                   DISPLAY 'bitfrost-migrate 1 (GnuCOBOL)'
                   MOVE MIGRATION-OK TO RETURN-CODE
                   STOP RUN
               END-IF
               IF ARG-TEXT = '--help'
                   DISPLAY 'bitfrost-migrate --db FILE '
                       '--migrations DIR --backup-dir DIR'
                   MOVE MIGRATION-OK TO RETURN-CODE
                   STOP RUN
               END-IF
               MOVE ARG-TEXT TO OPTION-NAME
               IF ARG-INDEX = ARG-COUNT
                   MOVE 'Missing command-line option value'
                       TO ERROR-MESSAGE
                   PERFORM FATAL
               END-IF
               ACCEPT ARG-TEXT FROM ARGUMENT-VALUE
               ADD 1 TO ARG-INDEX
               EVALUATE OPTION-NAME
                   WHEN '--db'
                       MOVE ARG-TEXT TO DATABASE-PATH
                   WHEN '--migrations'
                       MOVE ARG-TEXT TO MIGRATION-DIR
                   WHEN '--backup-dir'
                       MOVE ARG-TEXT TO BACKUP-DIR
                   WHEN '--lock-owner'
                       IF FUNCTION TEST-NUMVAL(ARG-TEXT)
                               NOT = ZERO OR
                           FUNCTION NUMVAL(ARG-TEXT) < 1 OR
                           FUNCTION NUMVAL(ARG-TEXT) > 2147483647
                           MOVE 'Invalid lock owner'
                               TO ERROR-MESSAGE
                           PERFORM FATAL
                       END-IF
                       MOVE FUNCTION NUMVAL(ARG-TEXT)
                           TO LOCK-OWNER
                   WHEN OTHER
                       MOVE 'Unknown command-line option'
                           TO ERROR-MESSAGE
                       PERFORM FATAL
               END-EVALUATE
           END-PERFORM
           IF DATABASE-PATH = SPACES OR
               MIGRATION-DIR = SPACES OR BACKUP-DIR = SPACES
               MOVE 'Specify --db, --migrations and --backup-dir'
                   TO ERROR-MESSAGE
               PERFORM FATAL
           END-IF.

       PREPARE-DATABASE.
           CALL STATIC "bf_owner" USING BY VALUE LOCK-OWNER
               RETURNING CALL-STATUS
           PERFORM CHECK-RESULT
           CALL STATIC "bf_open" USING BY REFERENCE
               FUNCTION CONCATENATE(
                   FUNCTION TRIM(DATABASE-PATH), x'00')
               RETURNING CALL-STATUS
           PERFORM CHECK-RESULT
           MOVE 'BEGIN IMMEDIATE' TO SQL-TEXT
           PERFORM EXECUTE-SQL
           MOVE 'PRAGMA user_version' TO SQL-TEXT
           PERFORM READ-NUMBER
           MOVE QUERY-VALUE TO SOURCE-VERSION CURRENT-VERSION
           IF CURRENT-VERSION < 0
               MOVE 'Invalid negative database schema version'
                   TO ERROR-MESSAGE
               PERFORM FATAL
           END-IF
           IF CURRENT-VERSION > TARGET-VERSION
               MOVE 'Database is newer than this release; ' &
                   'downgrade refused' TO ERROR-MESSAGE
               PERFORM FATAL
           END-IF
           IF CURRENT-VERSION = TARGET-VERSION
               MOVE 'ROLLBACK' TO SQL-TEXT
               PERFORM EXECUTE-SQL
               DISPLAY 'Database is already current; no migration '
                   'needed'
               PERFORM FINISH
           END-IF
           IF CURRENT-VERSION = 0
               MOVE "SELECT COUNT(*) FROM sqlite_master WHERE " &
                   "name NOT LIKE 'sqlite_%'" TO SQL-TEXT
               PERFORM READ-NUMBER
               IF QUERY-VALUE NOT = 0
                   MOVE 'Unversioned database is not empty; ' &
                       'migration refused' TO ERROR-MESSAGE
                   PERFORM FATAL
               END-IF
           ELSE
               CALL STATIC "bf_validate" RETURNING CALL-STATUS
               PERFORM CHECK-RESULT
               CALL STATIC "bf_backup" USING BY REFERENCE
                   FUNCTION CONCATENATE(
                       FUNCTION TRIM(DATABASE-PATH), x'00')
                   FUNCTION CONCATENATE(
                       FUNCTION TRIM(BACKUP-DIR), x'00')
                   BACKUP-PATH
                   BY VALUE LENGTH OF BACKUP-PATH
                   RETURNING CALL-STATUS
               PERFORM CHECK-RESULT
               DISPLAY 'Database backup: '
                   FUNCTION TRIM(BACKUP-PATH)
           END-IF.

       APPLY-MIGRATION-STEPS.
           MOVE 'CREATE TABLE IF NOT EXISTS schema_migrations (' &
               'version INTEGER PRIMARY KEY, ' &
               'migration TEXT NOT NULL, ' &
               'applied_at INTEGER NOT NULL)' TO SQL-TEXT
           PERFORM EXECUTE-SQL
           COMPUTE STEP-INDEX = CURRENT-VERSION + 1
           PERFORM UNTIL STEP-INDEX > TARGET-VERSION
               PERFORM SET-VERSION-DIRECTORY
               DISPLAY 'Migrating database to schema '
                   FUNCTION TRIM(DISPLAY-VERSION) ': v'
                   FUNCTION TRIM(DISPLAY-VERSION)
               MOVE SPACES TO ERROR-MESSAGE
               COPY "dispatch.cpy".
               MOVE RETURN-CODE TO CALL-STATUS
               PERFORM CHECK-RESULT
               MOVE STEP-INDEX TO CURRENT-VERSION
               MOVE SPACES TO SQL-TEXT
               STRING 'PRAGMA user_version='
                   FUNCTION TRIM(DISPLAY-VERSION)
                   INTO SQL-TEXT
               END-STRING
               PERFORM EXECUTE-SQL
               MOVE SPACES TO SQL-TEXT
               STRING 'INSERT INTO schema_migrations VALUES ('
                   FUNCTION TRIM(DISPLAY-VERSION) ", 'v"
                   FUNCTION TRIM(DISPLAY-VERSION) "', "
                   "CAST(strftime('%s','now') AS INTEGER)*1000)"
                   INTO SQL-TEXT
               END-STRING
               PERFORM EXECUTE-SQL
               ADD 1 TO STEP-INDEX
           END-PERFORM.

       FINALIZE-MIGRATION.
           CALL STATIC "bf_validate" RETURNING CALL-STATUS
           PERFORM CHECK-RESULT
           MOVE 'COMMIT' TO SQL-TEXT
           PERFORM EXECUTE-SQL
           DISPLAY 'Database migration complete'.

      *> Validate the package before opening or changing the database.
       LOAD-VERSIONS.
           MOVE COMPILED-VERSION-COUNT TO TARGET-VERSION
           CALL STATIC "bf_directory_open" USING BY REFERENCE
               FUNCTION CONCATENATE(
                   FUNCTION TRIM(MIGRATION-DIR), x'00')
               RETURNING CALL-STATUS
           PERFORM CHECK-RESULT
           PERFORM UNTIL DIRECTORY-END
               CALL STATIC "bf_directory_next" USING BY REFERENCE
                   DIRECTORY-ENTRY
                   BY VALUE LENGTH OF DIRECTORY-ENTRY
                   RETURNING DIRECTORY-STATUS
               EVALUATE DIRECTORY-STATUS
                   WHEN 0
                       IF DIRECTORY-ENTRY NOT = '.' AND '..'
                           PERFORM CHECK-VERSION-NAME
                       END-IF
                   WHEN 2
                       CONTINUE
                   WHEN OTHER
                       PERFORM FATAL
               END-EVALUATE
           END-PERFORM
           CALL STATIC "bf_directory_close" RETURNING CALL-STATUS
           PERFORM CHECK-RESULT
           PERFORM VARYING STEP-INDEX FROM 1 BY 1
               UNTIL STEP-INDEX > TARGET-VERSION
               IF VERSION-SEEN(STEP-INDEX) NOT = 'Y'
                   MOVE 'Missing migration version; ' &
                       'versions must be consecutive from v1'
                       TO ERROR-MESSAGE
                   PERFORM FATAL
               END-IF
               PERFORM SET-VERSION-DIRECTORY
               MOVE 'main.cob' TO STEP-NAME
               PERFORM CHECK-RESOURCE
               PERFORM CHECK-PLAN
           END-PERFORM.

       CHECK-VERSION-NAME.
           IF DIRECTORY-ENTRY(1:1) NOT = 'v' OR
               FUNCTION TEST-NUMVAL(DIRECTORY-ENTRY(2:255))
                   NOT = ZERO
               MOVE 'Invalid migration directory; expected vN'
                   TO ERROR-MESSAGE
               PERFORM FATAL
           END-IF
           IF FUNCTION NUMVAL(DIRECTORY-ENTRY(2:255)) < 1 OR
               FUNCTION NUMVAL(DIRECTORY-ENTRY(2:255))
                   > COMPILED-VERSION-COUNT
               MOVE 'Migration folders do not match the compiled ' &
                   'engine; rebuild or reinstall this release'
                   TO ERROR-MESSAGE
               PERFORM FATAL
           END-IF
           MOVE FUNCTION NUMVAL(DIRECTORY-ENTRY(2:255))
               TO DIRECTORY-NUMBER DISPLAY-VERSION
           MOVE SPACES TO CANONICAL-NAME
           STRING 'v' FUNCTION TRIM(DISPLAY-VERSION)
               INTO CANONICAL-NAME
           END-STRING
           IF DIRECTORY-ENTRY NOT = CANONICAL-NAME OR
               VERSION-SEEN(DIRECTORY-NUMBER) = 'Y'
               MOVE 'Invalid or duplicate migration version'
                   TO ERROR-MESSAGE
               PERFORM FATAL
           END-IF
           MOVE 'Y' TO VERSION-SEEN(DIRECTORY-NUMBER).

       SET-VERSION-DIRECTORY.
           MOVE STEP-INDEX TO DISPLAY-VERSION
           MOVE SPACES TO VERSION-DIR
           STRING FUNCTION TRIM(MIGRATION-DIR) '/v'
               FUNCTION TRIM(DISPLAY-VERSION) INTO VERSION-DIR
               ON OVERFLOW
                   MOVE 'Migration directory path is too long'
                       TO ERROR-MESSAGE
                   PERFORM FATAL
           END-STRING.

       CHECK-PLAN.
           MOVE 'plan' TO STEP-NAME
           PERFORM CHECK-RESOURCE
           OPEN INPUT MIGRATION-PLAN-FILE
           IF NOT MIGRATION-FILE-OK
               MOVE 'Cannot open the migration resource plan'
                   TO ERROR-MESSAGE
               PERFORM FATAL
           END-IF
           MOVE 0 TO RESOURCE-COUNT
           PERFORM UNTIL MIGRATION-FILE-EOF
               READ MIGRATION-PLAN-FILE
               EVALUATE TRUE
                   WHEN MIGRATION-FILE-EOF
                       CONTINUE
                   WHEN MIGRATION-FILE-OK
                       IF PLAN-FILE-LINE NOT = SPACES AND
                           PLAN-FILE-LINE(1:1) NOT = '#'
                           PERFORM CHECK-PLAN-RESOURCE
                       END-IF
                   WHEN OTHER
                       MOVE 'Cannot read migration resource plan'
                           TO ERROR-MESSAGE
                       PERFORM FATAL
               END-EVALUATE
           END-PERFORM
           CLOSE MIGRATION-PLAN-FILE.

       CHECK-PLAN-RESOURCE.
           ADD 1 TO RESOURCE-COUNT
           IF RESOURCE-COUNT > VERSION-LIMIT OR
               FUNCTION LENGTH(FUNCTION TRIM(PLAN-FILE-LINE))
                   > LENGTH OF STEP-NAME
               MOVE 'Migration resource plan exceeds its limits'
                   TO ERROR-MESSAGE
               PERFORM FATAL
           END-IF
           MOVE FUNCTION TRIM(PLAN-FILE-LINE) TO STEP-NAME
           MOVE STEP-NAME TO IDENTIFIER-UNDER-TEST
           PERFORM CHECK-IDENTIFIER
           IF NOT IDENTIFIER-IS-SAFE OR STEP-NAME = '.' OR '..'
               MOVE 'Invalid migration resource name'
                   TO ERROR-MESSAGE
               PERFORM FATAL
           END-IF
           PERFORM CHECK-RESOURCE.

       CHECK-RESOURCE.
           MOVE SPACES TO STEP-FILE-PATH
           STRING FUNCTION TRIM(VERSION-DIR) '/'
               FUNCTION TRIM(STEP-NAME) INTO STEP-FILE-PATH
               ON OVERFLOW
                   MOVE 'Migration resource path is too long'
                       TO ERROR-MESSAGE
                   PERFORM FATAL
           END-STRING
           CALL STATIC "bf_file_exists" USING BY REFERENCE
               FUNCTION CONCATENATE(
                   FUNCTION TRIM(STEP-FILE-PATH), x'00')
               RETURNING CALL-STATUS
           PERFORM CHECK-RESULT.

       EXECUTE-SQL.
           CALL STATIC "bf_sql" USING BY REFERENCE
               FUNCTION CONCATENATE(
                   FUNCTION TRIM(SQL-TEXT), x'00')
               RETURNING CALL-STATUS
           PERFORM CHECK-RESULT.

       READ-NUMBER.
           CALL STATIC "bf_number" USING BY REFERENCE
               FUNCTION CONCATENATE(
                   FUNCTION TRIM(SQL-TEXT), x'00')
               BY REFERENCE QUERY-VALUE
               RETURNING CALL-STATUS
           PERFORM CHECK-RESULT.

       CHECK-IDENTIFIER.
      *> Rejects any character outside IDENTIFIER-ALLOWED-CHARS. An
      *> empty name checks as safe; callers reject empty names
      *> separately.
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

      *> --------------------------------------------------------------
      *> Exit paths
      *> --------------------------------------------------------------
       FINISH.
           CALL STATIC "bf_close" RETURNING CLOSE-STATUS
           MOVE MIGRATION-OK TO RETURN-CODE
           STOP RUN.

       FATAL.
      *> Never returns: every failure path ends the program here so the
      *> open transaction rolls back inside bf_close. When ERROR-MESSAGE
      *> is SPACES the C layer holds the reason.
           IF ERROR-MESSAGE = SPACES
               CALL STATIC "bf_error" USING BY REFERENCE
                   ERROR-MESSAGE
                   BY VALUE LENGTH OF ERROR-MESSAGE
                   RETURNING CLOSE-STATUS
           END-IF
           DISPLAY 'bitfrost-migrate: '
               FUNCTION TRIM(ERROR-MESSAGE) UPON SYSERR
           CALL STATIC "bf_close" RETURNING CLOSE-STATUS
           MOVE MIGRATION-FAILED TO RETURN-CODE
           STOP RUN.

       CHECK-RESULT.
           IF CALL-STATUS NOT = MIGRATION-OK
               PERFORM FATAL
           END-IF.
