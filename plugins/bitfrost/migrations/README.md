# Database migrations

`install.sh` runs the COBOL migration executable before activating a release.
`bitfrost update` uses that same installer. This also handles reinstalling after
an uninstall that kept history. Installing does not start the daemon.

The installer asks an idle daemon to stop and holds `daemon.lock` through
migration and activation. Running agents block installation. Before changing an
existing database, the engine saves a private SQLite backup, including committed
WAL data, in `~/bitfrost-db-backups` (`BITFROST_BACKUP_DIR` overrides it). Backups
are outside the application's uninstall directories.

All pending steps, their history records, and `PRAGMA user_version` commit in one
transaction. Failure or interruption rolls everything back; the backup remains.
Rerunning applies only pending steps. Newer databases are refused, never downgraded.
Schema and data share the version: a version is current only after its processing
has completed. Daemon startup never upgrades an existing database or rebuilds
historical rollups.

## Version layout

Schema versions are SQLite `PRAGMA user_version` values, separate from application
release numbers. The root `package.json` declares the current schema in `dbVersion`.
The daemon reads it, and the migration build embeds that same target in COBOL,
checking that exactly v1 through vN exist. Release packaging bundles the package
metadata into the plugin for standalone Claude Code copies.
Install-time migration also checks that the binary's compiled target matches
`dbVersion` before opening the database.
`src/` contains only shared engine code. Each migration owns its
COBOL entry point and resources beside it:

```text
migrations/
  src/
    runner.cob
    files.cob
    sqlite.c
    sqlite.cpy
    handler-ws.cpy
    handler-procedures.cpy
  versions/
    v1/                     # Original history tables
      main.cob
      plan
      schema.sql
    v2/                     # Process identity and approval IDs
    v3/                     # Client-input receipts
    v4/                     # Session aggregates and history indexes
    v5/                     # Hourly rollups, replacing daily usage
    v6/                     # Provider request counters
    v7/                     # Full-input correction for expired v6 turns
    v8/                     # Request-aware billing and retained rollups
      main.cob
      plan
      columns
      schema.sql
      indexes.sql
      ...
```

The build discovers all `vN/main.cob` files in numeric order and generates the
compiled registry and dispatch. No manual handler list is needed. Both build and
runtime require consecutive folders beginning at v1; missing versions, missing
resources, or folders that do not match the compiled binary stop the upgrade.
A v4 database runs v5, v6, v7 and v8 today. Adding v9 extends that sequence by one.
An already-current database does no data processing and creates no backup.

A version's `plan` lists one resource filename per line, with optional `#` comments.
It is a resource manifest, checked before the engine opens the database.
`main.cob` controls execution order and conditions; plan order does not execute
SQL. All resource names are local filenames. A purely procedural migration may
have an empty plan. Keep released version folders unchanged.

## Adding a migration

Create `versions/v9/` with `main.cob`, `plan`, and every file it uses. Declare
`PROGRAM-ID. MIGRATION-V9.` and use this linkage contract:

- `LS-MIGRATION-DIR`: this version's folder, `PIC X(4096)`.
- `LS-SOURCE-VERSION`: the database version at transaction entry,
  `BINARY-DOUBLE SIGNED`. It remains unchanged throughout the chain, so a fix
  specific to original v6 data is not accidentally applied to a v4 upgrade.
- `LS-ERROR-MESSAGE`: `PIC X(2048)`, spaces on entry. Fill it for a handler error;
  leave spaces for a SQLite binding error. Return success/failure in `RETURN-CODE`.

For a SQL migration, copy the small `v1/main.cob` template, change its program ID
and comment to v9, and call `APPLY-SQL-FILE` for each SQL resource. Additive columns
can use `APPLY-COLUMNS` with a file containing `table|column|definition` lines.
The shared helpers are COBOL and propagate failures to the runner.

For example, v9 could contain a `project-totals.sql` resource:

```sql
CREATE TABLE project_totals (cwd TEXT PRIMARY KEY, tokens INTEGER NOT NULL);
INSERT INTO project_totals
  SELECT cwd,SUM(tokens) FROM sessions WHERE cwd IS NOT NULL GROUP BY cwd;
```

List `project-totals.sql` in v9's `plan`, then call it from `main.cob`:

```cobol
           MOVE 'project-totals.sql' TO STEP-NAME
           PERFORM APPLY-SQL-FILE
```

For more involved processing, use private working storage and prepared SQLite
statements, as in `v8/main.cob`. Handlers never manage transactions, set schema
versions, or exit the process. SQL files cannot commit, issue PRAGMAs, or attach
another database; the engine owns those operations.

Rebuild the executable for every release platform. Set the root `package.json`
`dbVersion` to the new target and provide its complete `schema.sql` and `indexes.sql`
snapshot in that version folder for empty development/in-memory databases. Existing
installed databases always use the COBOL migration chain during install/update.

## Engine responsibilities

`src/runner.cob` owns version discovery and validation, backups, the transaction,
dispatch, migration history and process exit. `src/files.cob` provides shared
SQL-file and additive-column operations. `src/sqlite.c` supplies SQLite/POSIX
bindings and the local-hour function. The handler copybooks keep small migrations
readable; `STYLE.md` documents the COBOL conventions.

The v8 handler streams usage events, corrects request billing, and rebuilds hourly
rollups for older schemas. Original v7 databases receive corrections without losing
rollups whose source events expired. Deleted history from older releases cannot
be recovered.

`release/generate-migrations.mjs` only generates the build registry and combined
COBOL source. Runtime migration selection and processing are COBOL.
`daemon/migrate.ts` stops the daemon, coordinates the installation lock, and
launches the executable.

## Building and testing

Development builds need Node.js, GnuCOBOL, a C compiler, and SQLite development headers:

```sh
release/build-migrations.sh
node --test --disable-warning=ExperimentalWarning plugins/bitfrost/daemon/test/migration.spec.ts
```

`release/build-migrations.sh --static` uses pinned, checksum-verified GnuCOBOL
3.2, GMP 6.3.0, and SQLite 3.50.4 sources. It needs Node.js, GnuCOBOL 3.2, a C compiler,
make, m4, curl, tar, and unzip. Linux releases build with musl; macOS builds both
architectures with a 12.3 deployment target. Shipped binaries contain their
COBOL runtime, GMP, and SQLite, so users install no extra libraries. Build scripts
share the repository's CPU budget and affinity settings.

To migrate an installed database manually, run `bitfrost migrate`. To run a
matching version tree on an offline database:

```sh
plugins/bitfrost/migrations/build/bitfrost-migrate \
  --db /path/to/bitfrost.db --migrations /path/to/versions --backup-dir /path/to/backups
```

To build a separate version tree without replacing the normal development binary,
provide a package file with its target `dbVersion`:

```sh
release/build-migrations.sh --versions /path/to/versions \
  --package-json /path/to/package.json --build-dir /tmp/migration-build
```

The database's parent directory must exist. The native runner refuses an existing
`daemon.lock`; `bitfrost migrate` also handles stale daemon locks. Test against a
copy and inspect the backup before distributing a new migration.

## Dependencies

Release binaries link the GnuCOBOL runtime (LGPL-3.0-or-later), GMP
(LGPL-3.0-or-later or GPL-2.0-or-later), and SQLite (public domain). Source URLs,
versions, and SHA-256 checksums are in `release/build-migrations.sh`; the source
archives include their licenses. BitFrost's migration sources use GPL-3.0-only.
