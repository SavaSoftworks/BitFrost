/* Copyright (C) 2026 Nick Germaine
 * SPDX-License-Identifier: GPL-3.0-only
 * SQLite and POSIX bindings for the COBOL migration engine. Migration policy
 * and data transformations belong in runner.cob and the versioned steps. */
#define _POSIX_C_SOURCE 200809L
#include <sqlite3.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

static sqlite3 *db;
static char error[2048], lock_path[4096];
static dev_t lock_dev;
static ino_t lock_ino;
static int lock_owner;
static volatile sig_atomic_t interrupted;
static DIR *versions;

static void on_signal(int number) { (void)number; interrupted = 1; }
static int progress(void *unused) { (void)unused; return interrupted != 0; }

int bf_owner(int owner) { lock_owner = owner; return 0; }

static int fail(const char *message) {
    snprintf(error, sizeof error, "%s", message);
    return 1;
}
static int result(int rc) {
    return rc == SQLITE_OK ? 0 : fail(db ? sqlite3_errmsg(db) : sqlite3_errstr(rc));
}
int bf_error(char *out, int size) {
    memset(out, ' ', (size_t)size);
    size_t n = strlen(error);
    if (n > (size_t)size) n = (size_t)size;
    memcpy(out, error, n);
    return 0;
}
/* Expose directory entries only; version parsing and gap checks are COBOL. */
int bf_directory_open(const char *path) {
    versions = opendir(path);
    return versions ? 0 : fail("Cannot open migration versions directory");
}
int bf_directory_next(char *out, int size) {
    errno = 0;
    struct dirent *entry = readdir(versions);
    if (!entry) return errno ? fail(strerror(errno)) : 2;
    size_t length = strlen(entry->d_name);
    if (length >= (size_t)size) return fail("Migration directory name is too long");
    memset(out, ' ', (size_t)size);
    memcpy(out, entry->d_name, length);
    return 0;
}
int bf_directory_close(void) {
    int rc = closedir(versions);
    versions = NULL;
    return rc ? fail(strerror(errno)) : 0;
}
int bf_sql(const char *sql) {
    if (interrupted) return fail("Migration interrupted; transaction rolled back");
    return result(sqlite3_exec(db, sql, NULL, NULL, NULL));
}
int bf_query(const char *sql, sqlite3_stmt **stmt) {
    return result(sqlite3_prepare_v2(db, sql, -1, stmt, NULL));
}
int bf_next(sqlite3_stmt *stmt) {
    int rc = sqlite3_step(stmt);
    if (rc != SQLITE_ROW && rc != SQLITE_DONE) result(rc);
    return rc;
}
int bf_done(sqlite3_stmt *stmt) { return result(sqlite3_finalize(stmt)); }
int bf_int(sqlite3_stmt *stmt, int col, long long *value) {
    *value = sqlite3_column_int64(stmt, col);
    return 0;
}
int bf_text(sqlite3_stmt *stmt, int col, char *out, int size) {
    int n = sqlite3_column_bytes(stmt, col);
    memset(out, ' ', (size_t)size);
    if (n >= size) return fail("Database identifier exceeds migration buffer");
    if (n) memcpy(out, sqlite3_column_text(stmt, col), (size_t)n);
    return 0;
}
int bf_bind_text(sqlite3_stmt *stmt, int col, const char *text) {
    return result(sqlite3_bind_text(stmt, col, text, -1, SQLITE_TRANSIENT));
}
int bf_bind_int(sqlite3_stmt *stmt, int col, const long long *value) {
    /* GnuCOBOL 3.1 defaults BY VALUE integers to 32 bits. Pass all SQLite
     * 64-bit values by reference, in both directions, across this boundary. */
    return result(sqlite3_bind_int64(stmt, col, *value));
}
int bf_run(sqlite3_stmt *stmt) {
    int rc = sqlite3_step(stmt);
    if (rc != SQLITE_DONE) return result(rc);
    return result(sqlite3_reset(stmt));
}
int bf_reset(sqlite3_stmt *stmt) { return result(sqlite3_reset(stmt)); }
int bf_column(const char *table, const char *column) {
    sqlite3_stmt *stmt = NULL;
    if (bf_query("SELECT 1 FROM pragma_table_info(?) WHERE name=?", &stmt)) return -1;
    sqlite3_bind_text(stmt, 1, table, -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(stmt, 2, column, -1, SQLITE_TRANSIENT);
    int rc = bf_next(stmt);
    sqlite3_finalize(stmt);
    return rc == SQLITE_ROW ? 1 : rc == SQLITE_DONE ? 0 : -1;
}

/* Match JavaScript's local Date constructor, including choosing the first
 * occurrence of an ambiguous autumn hour. SQLite's UTC arithmetic cannot. */
static void local_hour(sqlite3_context *ctx, int argc, sqlite3_value **values) {
    (void)argc;
    if (sqlite3_value_type(values[0]) == SQLITE_NULL) { sqlite3_result_null(ctx); return; }
    sqlite3_int64 millis = sqlite3_value_int64(values[0]);
    time_t seconds = (time_t)(millis / 1000 - (millis < 0 && millis % 1000 != 0));
    struct tm local;
    if (!localtime_r(&seconds, &local)) { sqlite3_result_error(ctx, "Invalid timestamp", -1); return; }
    local.tm_min = local.tm_sec = 0;
    local.tm_isdst = -1;
    time_t selected = mktime(&local);
    for (int dst = 0; dst <= 1; ++dst) {
        struct tm trial = local, check;
        trial.tm_isdst = dst;
        time_t value = mktime(&trial);
        if (localtime_r(&value, &check) && check.tm_year == local.tm_year &&
            check.tm_yday == local.tm_yday && check.tm_hour == local.tm_hour &&
            check.tm_min == 0 && value < selected) selected = value;
    }
    sqlite3_result_int64(ctx, (sqlite3_int64)selected * 1000);
}

static void release_lock(void) {
    struct stat st;
    if (*lock_path && !lstat(lock_path, &st) && st.st_dev == lock_dev && st.st_ino == lock_ino)
        unlink(lock_path);
    *lock_path = 0;
}
static int lock_data(const char *file) {
    char temporary[4096], candidate[4096];
    const char *slash = strrchr(file, '/');
    int len = slash ? (int)(slash - file + 1) : 0;
    if (snprintf(candidate, sizeof candidate, "%.*sdaemon.lock", len, file) >= (int)sizeof candidate ||
        snprintf(temporary, sizeof temporary, "%.*s.migrate-lock.XXXXXX", len, file) >= (int)sizeof temporary)
        return fail("Database path is too long");
    if (lock_owner) {
        struct stat held_stat;
        if (lstat(candidate, &held_stat) || !S_ISREG(held_stat.st_mode) || held_stat.st_uid != getuid())
            return fail("Installer lock must be a regular file owned by you");
        FILE *held = fopen(candidate, "r");
        long owner = 0;
        int matched = held && fscanf(held, "%ld", &owner) == 1 && owner == lock_owner &&
            (kill((pid_t)owner, 0) == 0 || errno == EPERM);
        if (held) fclose(held);
        return matched ? 0 : fail("Installer does not hold the database lock");
    }
    int fd = mkstemp(temporary);
    if (fd < 0) return fail(strerror(errno));
    char pid[32];
    int n = snprintf(pid, sizeof pid, "%ld", (long)getpid());
    struct stat mine;
    int ok = write(fd, pid, (size_t)n) == n && fstat(fd, &mine) == 0;
    close(fd);
    if (!ok) { unlink(temporary); return fail("Cannot write migration lock"); }
    /* Never remove somebody else's lock, including an ambiguous stale lock.
     * The installer uses takeLock() to clean up dead daemon PIDs first. */
    if (link(temporary, candidate)) {
        unlink(temporary);
        return fail("Data lock exists; close BitFrost and stop its daemon before migrating");
    }
    unlink(temporary);
    strcpy(lock_path, candidate);
    lock_dev = mine.st_dev;
    lock_ino = mine.st_ino;
    atexit(release_lock);
    return 0;
}
int bf_open(const char *file) {
    struct stat st;
    if (!lstat(file, &st) && (!S_ISREG(st.st_mode) || st.st_nlink != 1))
        return fail("Database must be a regular file without hard links or symlinks");
    if (lock_data(file)) return 1;
    /* Create the database privately before SQLite creates any sidecars. */
    int fd = open(file, O_WRONLY | O_CREAT | O_NOFOLLOW, 0600);
    if (fd < 0) return fail(strerror(errno));
    int rc = fchmod(fd, 0600);
    close(fd);
    if (rc) return fail(strerror(errno));
    rc = sqlite3_open_v2(file, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE, NULL);
    if (result(rc)) return 1;
    sqlite3_busy_timeout(db, 5000);
    sqlite3_progress_handler(db, 10000, progress, NULL);
    struct sigaction action = {0};
    action.sa_handler = on_signal;
    sigemptyset(&action.sa_mask);
    sigaction(SIGINT, &action, NULL);
    sigaction(SIGTERM, &action, NULL);
    sigaction(SIGHUP, &action, NULL);
    rc = sqlite3_create_function_v2(db, "local_hour", 1, SQLITE_UTF8, NULL, local_hour, NULL, NULL, NULL);
    if (result(rc)) return 1;
    return bf_sql("PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;");
}
int bf_close(void) {
    if (db) {
        sqlite3_stmt *stmt;
        while ((stmt = sqlite3_next_stmt(db, NULL))) sqlite3_finalize(stmt);
        sqlite3_exec(db, "ROLLBACK", NULL, NULL, NULL);
    }
    int rc = db ? sqlite3_close(db) : SQLITE_OK;
    db = NULL;
    release_lock();
    return rc;
}
int bf_number(const char *sql, long long *value) {
    sqlite3_stmt *stmt = NULL;
    if (bf_query(sql, &stmt)) return 1;
    int rc = bf_next(stmt);
    if (rc == SQLITE_ROW) *value = sqlite3_column_int64(stmt, 0);
    sqlite3_finalize(stmt);
    return rc == SQLITE_ROW ? 0 : fail("Migration scalar query returned no row");
}
int bf_file_exists(const char *file) {
    struct stat st;
    return stat(file, &st) || !S_ISREG(st.st_mode) ? fail("Migration resource file is missing") : 0;
}
static int authorize(void *arg, int action, const char *a, const char *b, const char *c, const char *d) {
    (void)arg; (void)a; (void)b; (void)c; (void)d;
    return action == SQLITE_TRANSACTION || action == SQLITE_SAVEPOINT || action == SQLITE_PRAGMA ||
        action == SQLITE_ATTACH || action == SQLITE_DETACH ? SQLITE_DENY : SQLITE_OK;
}
int bf_file(const char *file) {
    FILE *input = fopen(file, "rb");
    if (!input) return fail(strerror(errno));
    if (fseek(input, 0, SEEK_END)) { fclose(input); return fail("Cannot size SQL file"); }
    long size = ftell(input);
    if (size < 0 || size > 8 * 1024 * 1024) { fclose(input); return fail("SQL file exceeds 8 MiB"); }
    rewind(input);
    char *sql = malloc((size_t)size + 1);
    if (!sql) { fclose(input); return fail("Out of memory reading SQL"); }
    int ok = fread(sql, 1, (size_t)size, input) == (size_t)size && !ferror(input);
    fclose(input);
    sql[size] = 0;
    if (!ok || memchr(sql, 0, (size_t)size)) { free(sql); return fail("Invalid SQL file"); }
    sqlite3_set_authorizer(db, authorize, NULL);
    int rc = bf_sql(sql);
    sqlite3_set_authorizer(db, NULL, NULL);
    free(sql);
    return rc;
}

/* Use a second, read-only connection while the writer holds BEGIN IMMEDIATE:
 * backup_step on the writing connection itself would return SQLITE_LOCKED. */
int bf_backup(const char *file, const char *directory, char *out, int capacity) {
    struct stat st;
    if (mkdir(directory, 0700) && errno != EEXIST) return fail(strerror(errno));
    if (lstat(directory, &st) || !S_ISDIR(st.st_mode) || st.st_uid != getuid() ||
        chmod(directory, 0700)) return fail("Backup directory must be a private directory owned by you");
    char target[4096];
    if (snprintf(target, sizeof target, "%s/bitfrost-before-migration-XXXXXX", directory) >= (int)sizeof target)
        return fail("Backup path is too long");
    int fd = mkstemp(target);
    if (fd < 0) return fail(strerror(errno));
    close(fd);
    sqlite3 *source = NULL, *destination = NULL;
    int rc = sqlite3_open_v2(file, &source, SQLITE_OPEN_READONLY, NULL);
    if (rc == SQLITE_OK) rc = sqlite3_open(target, &destination);
    if (rc == SQLITE_OK) {
        sqlite3_backup *backup = sqlite3_backup_init(destination, "main", source, "main");
        if (!backup) rc = sqlite3_errcode(destination);
        else {
            do { rc = sqlite3_backup_step(backup, 256); } while (rc == SQLITE_OK && !interrupted);
            if (interrupted) rc = SQLITE_INTERRUPT;
            int finish = sqlite3_backup_finish(backup);
            rc = rc == SQLITE_DONE ? finish : rc;
        }
    }
    if (source) sqlite3_close(source);
    if (destination) sqlite3_close(destination);
    if (rc != SQLITE_OK) { unlink(target); return fail(sqlite3_errstr(rc)); }
    fd = open(target, O_RDONLY);
    int synced = fd >= 0 && fsync(fd) == 0;
    if (fd >= 0) close(fd);
    fd = open(directory, O_RDONLY);
    synced = synced && fd >= 0 && fsync(fd) == 0;
    if (fd >= 0) close(fd);
    if (!synced) return fail("Could not sync the database backup; source left unchanged");
    if (strlen(target) >= (size_t)capacity) return fail("Backup path exceeds output buffer");
    memset(out, ' ', (size_t)capacity);
    memcpy(out, target, strlen(target));
    return 0;
}
int bf_validate(void) {
    sqlite3_stmt *stmt = NULL;
    if (bf_query("PRAGMA quick_check", &stmt)) return 1;
    int rc = bf_next(stmt);
    int valid = rc == SQLITE_ROW && strcmp((const char *)sqlite3_column_text(stmt, 0), "ok") == 0;
    sqlite3_finalize(stmt);
    if (!valid) return fail("Database integrity check failed");
    if (bf_query("PRAGMA foreign_key_check", &stmt)) return 1;
    rc = bf_next(stmt);
    sqlite3_finalize(stmt);
    return rc == SQLITE_DONE ? 0 : fail("Database foreign key check failed");
}
