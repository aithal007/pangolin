import { assertEquals } from "@test/assert";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

// Guards the atomicity of the buffered audit-log flush in logRequestAudit.ts.
//
// better-sqlite3's transaction() is synchronous: it runs BEGIN, invokes the
// callback, then COMMIT. Handing it an `async` callback means the callback
// returns a promise at its first `await`, so COMMIT fires before any insert has
// run - the inserts then execute in autocommit mode, one implicit transaction
// each. A failure partway through therefore leaves earlier rows committed,
// which matters because flushAuditLogs() re-queues the whole slice on error and
// would duplicate them on the retry.
//
// These tests pin the two behaviors against a real SQLite database so the
// distinction can't silently regress.

const rows = sqliteTable("rows", {
    id: integer("id").primaryKey({ autoIncrement: true }),
    val: text("val").notNull()
});

const BATCH_DB_SIZE = 25;

function freshDb() {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite, { schema: { rows } });
    db.run(
        sql`CREATE TABLE rows (id INTEGER PRIMARY KEY AUTOINCREMENT, val TEXT NOT NULL)`
    );
    return { db, sqlite };
}

function makeRows(n: number) {
    return Array.from({ length: n }, (_, i) => ({ val: `row-${i}` }));
}

function countRows(sqlite: Database.Database): number {
    return (
        sqlite.prepare("SELECT COUNT(*) AS c FROM rows").get() as {
            c: number;
        }
    ).c;
}

async function runTests() {
    console.log("Running audit log transaction atomicity tests...");

    // A synchronous callback keeps the transaction open across every batch, so
    // a failure partway through rolls the whole flush back. This is the shape
    // insertAuditLogsAtomically() uses on SQLite.
    {
        const { db, sqlite } = freshDb();
        const toWrite = makeRows(60); // 25 / 25 / 10
        let threw = false;

        try {
            db.transaction((tx) => {
                for (let i = 0; i < toWrite.length; i += BATCH_DB_SIZE) {
                    if (i >= 50) {
                        throw new Error("simulated failure on third batch");
                    }
                    tx.insert(rows)
                        .values(toWrite.slice(i, i + BATCH_DB_SIZE))
                        .run();
                }
            });
        } catch {
            threw = true;
        }

        assertEquals(threw, true, "The failure should surface to the caller");
        assertEquals(
            countRows(sqlite),
            0,
            "A sync transaction callback must roll back every batch on failure"
        );
        sqlite.close();
    }

    // The happy path must still commit everything.
    {
        const { db, sqlite } = freshDb();
        const toWrite = makeRows(60);

        db.transaction((tx) => {
            for (let i = 0; i < toWrite.length; i += BATCH_DB_SIZE) {
                tx.insert(rows)
                    .values(toWrite.slice(i, i + BATCH_DB_SIZE))
                    .run();
            }
        });

        assertEquals(
            countRows(sqlite),
            60,
            "A sync transaction callback must commit every batch on success"
        );
        sqlite.close();
    }

    // Documents why the async form cannot be used here: COMMIT has already run
    // by the time the first insert executes, so nothing is rolled back.
    {
        const { db, sqlite } = freshDb();
        const toWrite = makeRows(60);

        let inTransactionAfterFirstAwait: boolean | null = null;
        try {
            await db.transaction(async (tx) => {
                for (let i = 0; i < toWrite.length; i += BATCH_DB_SIZE) {
                    if (i >= 50) {
                        throw new Error("simulated failure on third batch");
                    }
                    await tx
                        .insert(rows)
                        .values(toWrite.slice(i, i + BATCH_DB_SIZE));
                    if (inTransactionAfterFirstAwait === null) {
                        inTransactionAfterFirstAwait = sqlite.inTransaction;
                    }
                }
            });
        } catch {
            // expected
        }

        assertEquals(
            inTransactionAfterFirstAwait,
            false,
            "better-sqlite3 commits before an async callback's first await resolves"
        );
        assertEquals(
            countRows(sqlite),
            50,
            "An async callback leaves earlier batches committed - the bug this guards against"
        );
        sqlite.close();
    }

    console.log("All audit log transaction atomicity tests passed!");
}

runTests()
    .then(() => {
        console.log("\nAll tests passed successfully!");
    })
    .catch((error) => {
        console.error("Audit log transaction test failed:", error);
        process.exit(1);
    });
