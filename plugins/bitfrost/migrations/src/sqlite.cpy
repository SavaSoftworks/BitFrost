      *> Copyright (C) 2026 Nick Germaine
      *> SPDX-License-Identifier: GPL-3.0-only
      *>
      *> Shared declarations for the COBOL migration engine. COPY into
      *> the WORKING-STORAGE SECTION of every program; each program
      *> receives its own storage, so these items never carry state
      *> across programs.
      *>
      *> C binding contract (src/sqlite.c):
      *>   - bf_* names are lowercase C symbols; quote them exactly.
      *>   - Every 64-bit SQLite integer crosses the boundary BY
      *>     REFERENCE in both directions. GnuCOBOL 3.1 and 3.2 pass
      *>     BY VALUE integers as 32 bits, so wider values would
      *>     truncate.
      *>   - bf_ints / bf_bind_ints transfer runs of contiguous native
      *>     BINARY-DOUBLE SIGNED fields BY REFERENCE, with no padding
      *>     or numeric conversion. Counts/column positions BY VALUE.
      *>   - Text passed to bf_* needs one trailing NUL: x'00' appended
      *>     via FUNCTION CONCATENATE, or a z'...' literal for short
      *>     constants.
      *>   - bf_text_slice returns a counted, unpadded text field. Only
      *>     its returned length is valid; never inspect the field tail.
      *>   - Every bf_* call returns a C status in the RETURNING field:
      *>     MIGRATION-OK succeeds; anything else fails and the C layer
      *>     retains the message for the caller's FATAL to fetch.
      *>   - bf_next returns SQLite step codes: USAGE-ROW-AVAILABLE
      *>     means a row is ready to read, USAGE-STEP-COMPLETE means no
      *>     more rows.
       78  MIGRATION-OK                          VALUE 0.
       78  MIGRATION-FAILED                      VALUE 1.
       78  SQLITE-ROW-CODE                       VALUE 100.
       78  SQLITE-DONE-CODE                      VALUE 101.

      *> Sequential file status for the plan and column readers.
       01  MIGRATION-FILE-STATUS                 PIC XX.
           88  MIGRATION-FILE-OK                    VALUE '00'.
           88  MIGRATION-FILE-EOF                   VALUE '10'.

      *> Migration names are SQL literals and relative file names,
      *> never commands: every plan entry, table, and column name may
      *> use only the characters in IDENTIFIER-ALLOWED-CHARS, in order.
      *> The check walks the name with plain comparisons because
      *> GnuCOBOL 3.2's SUBSTITUTE ignores data-item pattern operands.
      *> Keep the count constant in sync with the field's length.
       78  IDENTIFIER-ALLOWED-CHAR-COUNT         VALUE 39.
       01  IDENTIFIER-ALLOWED-CHARS              PIC X(39) VALUE
           'abcdefghijklmnopqrstuvwxyz0123456789-._'.

       01  IDENTIFIER-UNDER-TEST                 PIC X(256).
       01  IDENTIFIER-TRIMMED                    PIC X(256).
       01  IDENTIFIER-LENGTH                     BINARY-LONG.
       01  IDENTIFIER-CHAR-INDEX                 BINARY-LONG.
       01  IDENTIFIER-ALLOW-INDEX                BINARY-LONG.
       01  IDENTIFIER-CHECK-FLAG                 PIC X.
           88  IDENTIFIER-IS-SAFE                    VALUE 'Y'.
