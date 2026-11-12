# drizzle-sqlite-fts

SQLite FTS5 full-text search for [Drizzle ORM](https://orm.drizzle.team). Declare a search index next to the table it searches. You get the virtual table, the sync triggers and the backfill as ordinary drizzle-kit migrations, and you query the index with typed helpers that are safe to use with user input.

> **Work in progress.** The package is being built in small, reviewed steps and is not on npm yet. The API below is the plan, and it may still change before 0.1.0. Follow [drizzle-orm#2046](https://github.com/drizzle-team/drizzle-orm/issues/2046) or watch this repo for the first release.

## Why

Drizzle has no support for SQLite virtual tables. [drizzle-orm#2046](https://github.com/drizzle-team/drizzle-orm/issues/2046), the FTS5 feature request, has been open since 2024. So people using better-sqlite3, libsql/Turso or Cloudflare D1 write the FTS5 table, its triggers and the `MATCH` SQL by hand, in a custom migration. That approach goes wrong in three places:

- **Triggers that corrupt the index.** An external-content index only stays correct if the delete and update triggers pass FTS5's `'delete'` command exactly the old values of the row. Get one column wrong and searches silently return stale or missing rows.
- **drizzle-kit removes your work.** `drizzle-kit push` drops FTS tables it doesn't know about. When you change a column, drizzle-kit rebuilds the SQLite table (create `__new_<table>`, copy, drop, rename), and every trigger on that table is dropped with it, so the index stops updating without any error.
- **Raw user input in `MATCH`.** FTS5 has its own query syntax. Passing search text straight to `MATCH` throws on input like `"` or `AND`, or lets users run queries you didn't intend.

drizzle-sqlite-fts writes the triggers from the sqlite.org recipe, notices when drizzle-kit has rebuilt a table and restores its triggers, and quotes search text for you.

## Planned usage

```ts
import {integer, sqliteTable, text} from 'drizzle-orm/sqlite-core';
import {fts5} from 'drizzle-sqlite-fts';

export const notes = sqliteTable('notes', {
	id: integer('id').primaryKey(),
	title: text('title').notNull(),
	body: text('body'),
});

// An external-content index: the rows stay in `notes`, the index only holds the search data.
export const notesSearch = fts5('notes_fts', {table: notes, columns: ['title', 'body'], tokenize: 'porter unicode61'});
```

```sh
npx drizzle-kit generate          # your tables, as usual
npx drizzle-sqlite-fts generate   # the index, its triggers and the backfill, as the next migration
npx drizzle-sqlite-fts check      # in CI: fails when the migrations are behind the schema
```

```ts
import {eq} from 'drizzle-orm';
import {bm25, match, snippet} from 'drizzle-sqlite-fts';

const results = await db
	.select({id: notes.id, title: notes.title, excerpt: snippet(notesSearch, 'body')})
	.from(notesSearch)
	.innerJoin(notes, eq(notes.id, notesSearch.rowid))
	.where(match(notesSearch, userInput, {prefix: true}))
	.orderBy(bm25(notesSearch, {title: 10, body: 1}))
	.limit(20);
```

Contentless and standalone indexes can be declared too, with `fts5('docs', {mode: 'standalone', columns: ['title', 'body']})`.

## Status

| Step | State |
|---|---|
| Package scaffold: ESM and CommonJS builds, CI on Linux, macOS and Windows, drizzle-orm 0.36, 0.45 and 1.0-rc | Done |
| `fts5()` declaration with checks up front and a typed query handle | Done |
| SQL for the index, sync triggers, backfill and drop, tested against a real SQLite database | Done |
| Migration state across branches, and detecting drizzle-kit table rebuilds | Done |
| `generate`, `check` and `sql` commands, plus a `drizzle-kit push` filter | In progress |
| `match`, `bm25`, `highlight` and `snippet` query helpers | Done |
| Full API reference, benchmarks and the first npm release | Planned |

Tested in CI with better-sqlite3. libsql and node:sqlite are planned for the end-to-end tests; bun:sqlite and Cloudflare D1 should work with the generated SQL but won't be tested in 0.1.

## Related

- [drizzle-orm#2046](https://github.com/drizzle-team/drizzle-orm/issues/2046): the upstream request for FTS5 and other virtual tables.
- [drizzle-triggers](https://github.com/RagedPanda/drizzle-triggers): the same declare-then-generate approach for Postgres triggers and functions.
- [SQLite FTS5 documentation](https://www.sqlite.org/fts5.html): external content tables, bm25, highlight and snippet.

## License

MIT
