# drizzle-sqlite-fts

[![npm version](https://img.shields.io/npm/v/drizzle-sqlite-fts)](https://www.npmjs.com/package/drizzle-sqlite-fts)
[![CI](https://github.com/RagedPanda/drizzle-sqlite-fts/actions/workflows/ci.yml/badge.svg)](https://github.com/RagedPanda/drizzle-sqlite-fts/actions/workflows/ci.yml)
[![coverage](https://img.shields.io/badge/coverage-100%25-brightgreen)](https://github.com/RagedPanda/drizzle-sqlite-fts/actions/workflows/ci.yml)
[![npm downloads](https://img.shields.io/npm/dm/drizzle-sqlite-fts)](https://www.npmjs.com/package/drizzle-sqlite-fts)
[![types](https://img.shields.io/npm/types/drizzle-sqlite-fts)](https://www.npmjs.com/package/drizzle-sqlite-fts)
[![drizzle-orm](https://img.shields.io/npm/dependency-version/drizzle-sqlite-fts/peer/drizzle-orm)](https://orm.drizzle.team)
[![node](https://img.shields.io/node/v/drizzle-sqlite-fts)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/drizzle-sqlite-fts)](LICENSE)

SQLite FTS5 full-text search for [Drizzle ORM](https://orm.drizzle.team). Declare a search index next to the table it searches. You get the virtual table, the sync triggers and the backfill as ordinary drizzle-kit migrations, and you query the index with typed helpers that are safe to use with user input.

```ts
const results = db
	.select({id: notes.id, title: notes.title, excerpt: snippet(notesSearch, 'body', {open: '<b>', close: '</b>'})})
	.from(notesSearch)
	.innerJoin(notes, eq(notes.id, notesSearch.rowid))
	.where(match(notesSearch, userInput, {prefix: true}))
	.orderBy(bm25(notesSearch, {title: 10, body: 1}))
	.limit(20)
	.all();
```

## Why

Drizzle has no support for SQLite virtual tables. [drizzle-orm#2046](https://github.com/drizzle-team/drizzle-orm/issues/2046), the FTS5 feature request, has been open since 2024. So people using better-sqlite3, libsql/Turso or Cloudflare D1 either search with `LIKE '%term%'` or write the FTS5 table, its triggers and the `MATCH` SQL by hand in a custom migration.

`LIKE` reads every row whenever few rows match: in the [benchmark](#benchmarks) a rare word takes 7 ms on 100,000 notes, against 0.05 to 0.14 ms with FTS5. It also has no ranking, no stemming and no word boundaries (`%cat%` matches "concatenate").

The hand-written FTS5 route goes wrong in three places:

- **Triggers that corrupt the index.** An external-content index only stays correct if the delete and update triggers pass FTS5's `'delete'` command exactly the old values of the row. Get one column wrong and searches silently return stale or missing rows.
- **drizzle-kit removes your work.** `drizzle-kit push` drops FTS tables it doesn't know about. When you change a column, drizzle-kit rebuilds the SQLite table (create `__new_<table>`, copy, drop, rename), and every trigger on that table is dropped with it, so the index stops updating without any error.
- **Raw user input in `MATCH`.** FTS5 has its own query syntax. Passing search text straight to `MATCH` throws on input like `"` or `AND`, or lets users run queries you didn't intend.

drizzle-sqlite-fts writes the triggers from the [sqlite.org recipe](https://www.sqlite.org/fts5.html#external_content_tables), notices when drizzle-kit has rebuilt a table and restores its triggers, and quotes search text for you.

## Install

```sh
npm install drizzle-sqlite-fts
```

`drizzle-orm` 0.36.4 or later is a peer dependency, 1.0 release candidates included. The CLI also needs `drizzle-kit` 0.28.1 or later, which you already have if you generate migrations. Node.js 22.12 or later.

## Usage

### 1. Declare an index

Put the index in a schema file drizzle-kit reads, next to the table it searches:

```ts
// db/schema.ts
import {integer, sqliteTable, text} from 'drizzle-orm/sqlite-core';
import {fts5} from 'drizzle-sqlite-fts';

export const notes = sqliteTable('notes', {
	id: integer('id').primaryKey(),
	title: text('title').notNull(),
	body: text('body'),
});

// An external-content index: the rows stay in `notes`, and triggers keep the index in sync with them.
export const notesSearch = fts5('notes_fts', {table: notes, columns: ['title', 'body'], tokenize: 'porter unicode61'});
```

`fts5()` checks the declaration when the module loads: the columns must be text columns of that table, the table needs an integer key, and no column can use a name FTS5 reserves (`rowid`, `rank` or the index's own name).

### 2. Generate the migration

```sh
npx drizzle-kit generate          # your tables, as usual
npx drizzle-sqlite-fts generate   # the index, its triggers and the backfill, as the next migration
```

`drizzle-sqlite-fts generate` asks drizzle-kit for an empty custom migration and writes the SQL into it, so the migration lands in your migrations folder and journal like any other and runs with `migrate()` or `drizzle-kit migrate`. Run it after every `drizzle-kit generate`: when you change an index it writes the change, and when drizzle-kit rebuilt a table and dropped its triggers, it writes them again. With nothing to do it writes nothing.

Add `check` to CI. It exits with 1 when the schema has an index change that no migration covers yet:

```sh
npx drizzle-sqlite-fts check
```

### 3. Search

```ts
import {eq} from 'drizzle-orm';
import {bm25, highlight, match, snippet} from 'drizzle-sqlite-fts';

// Best matches first, with the matched words highlighted.
const results = db
	.select({
		id: notes.id,
		title: highlight(notesSearch, 'title', {open: '<mark>', close: '</mark>'}),
		excerpt: snippet(notesSearch, 'body', {open: '<mark>', close: '</mark>', tokens: 12}),
	})
	.from(notesSearch)
	.innerJoin(notes, eq(notes.id, notesSearch.rowid))
	.where(match(notesSearch, userInput, {prefix: true}))
	.orderBy(bm25(notesSearch, {title: 10, body: 1}), notesSearch.rowid)
	.limit(20)
	.all();
```

`match()` takes what the user typed. Each word becomes a quoted term and every term must appear, so `C++ OR "x` searches for those words instead of throwing a syntax error. With `{prefix: true}` the last word also matches words that start with it, for search-as-you-type. Input with no words matches nothing.

The handle is a Drizzle view, so it works with `select`, joins, `where`, `orderBy`, `limit` and subqueries. Besides your columns it has `rowid` (the indexed row's key) and `rank` (FTS5's rank, the same as `bm25()` without weights).

To show the newest matches instead of the most relevant, order by the key. FTS5 then stops after `limit` rows instead of scoring all of them, which is the fastest query in the [benchmarks](#benchmarks):

```ts
import {desc} from 'drizzle-orm';

const newest = db.select({id: notesSearch.rowid}).from(notesSearch)
	.where(match(notesSearch, userInput))
	.orderBy(desc(notesSearch.rowid))
	.limit(20)
	.all();
```

For queries you write yourself, with FTS5 operators, use `rawMatch()`:

```ts
import {rawMatch} from 'drizzle-sqlite-fts';

db.select({id: notesSearch.rowid}).from(notesSearch).where(rawMatch(notesSearch, 'title: (sqlite OR postgres) NOT draft')).all();
```

### Contentless and standalone indexes

When the text doesn't live in a Drizzle table, declare the columns by name and insert rows into the index yourself:

```ts
// Keeps its own copy of the text, so highlight() and snippet() work.
export const docs = fts5('docs', {mode: 'standalone', columns: ['title', 'body']});
// Stores no text at all, so it's smaller, but it can only tell you which rowids match.
export const logSearch = fts5('log_search', {mode: 'contentless', columns: ['message']});
```

```ts
db.run(sql`INSERT INTO ${docs} (rowid, title, body) VALUES (${id}, ${title}, ${body})`);
```

`highlight()` and `snippet()` on a contentless index are a type error, because there is no text to return.

### drizzle-kit push

`drizzle-kit push` compares the database with your schema and drops tables it doesn't recognise, which includes FTS5 indexes and their shadow tables. Hide them from it with `ftsTablesFilter()`:

```ts
// drizzle.config.ts
import {defineConfig} from 'drizzle-kit';
import {ftsTablesFilter} from 'drizzle-sqlite-fts';
import {notesSearch} from './db/schema';

export default defineConfig({
	dialect: 'sqlite',
	schema: './db/schema.ts',
	dbCredentials: {url: 'file:local.db'},
	tablesFilter: ftsTablesFilter(notesSearch), // ['!notes_fts', '!notes_fts_*']
});
```

Push never creates the index, so create it once with `npx drizzle-sqlite-fts sql`, which prints the statements for every index:

```sh
npx drizzle-sqlite-fts sql | sqlite3 local.db
```

If you already have a `tablesFilter`, spread the patterns into it: `tablesFilter: ['app_*', ...ftsTablesFilter(notesSearch)]`.

## API

### `fts5(name, options)`

Declares an index and returns its handle. External content is the default:

| Option | Type | |
| --- | --- | --- |
| `table` | Drizzle SQLite table | The table to search. |
| `columns` | column keys of `table` | Text columns to index. Their order is the column order in `bm25()`, `highlight()` and `snippet()`. |
| `contentRowid` | column key of `table` | A unique, not-null integer column that identifies each row. Defaults to the table's integer primary key. |
| `mode` | `'external'` | Optional. |

For an index without a Drizzle table, pass `mode: 'contentless'` or `mode: 'standalone'` and `columns` as an array of column names.

Every mode also takes FTS5's own options:

| Option | Type | Default | |
| --- | --- | --- | --- |
| `tokenize` | `string` | `unicode61` | The tokenizer and its arguments, such as `porter unicode61 remove_diacritics 2` or `trigram`. |
| `prefix` | `number[]` | none | Prefix lengths (1 to 999) to build extra indexes for, so prefix searches of those lengths are fast. |
| `detail` | `'full' \| 'column' \| 'none'` | `'full'` | `column` and `none` make the index smaller but disable phrase and NEAR queries. |
| `columnsize` | `boolean` | `true` | `false` stops storing each row's token count: a smaller index, slower `bm25()`. |

### Query helpers

| Helper | Returns | |
| --- | --- | --- |
| `match(index, text, {prefix?})` | condition | Rows that contain every word of `text`, a user's input. The text is a bound parameter. |
| `rawMatch(index, query)` | condition | Rows that match an FTS5 query as written. Only for queries you wrote. |
| `toMatchQuery(text, {prefix?})` | `string` | The FTS5 query `match()` would send, to use in your own SQL. |
| `bm25(index, weights?)` | `number` | Relevance, lower is better, so order ascending. `weights` is by column key, and columns you leave out weigh 1. |
| `highlight(index, column, {open, close})` | `string` | The column's text with each matched word wrapped in `open` and `close`. |
| `snippet(index, column, {open?, close?, ellipsis?, tokens?})` | `string` | A fragment of the column around the matches. `ellipsis` defaults to `…`, and `tokens` (1 to 64) to 16. |

`bm25()`, `highlight()` and `snippet()` only work in a query that has a `match()` or `rawMatch()` condition.

### `ftsTablesFilter(...indexes)`

Returns the `tablesFilter` patterns that hide each index and its shadow tables from `drizzle-kit push`.

### CLI

```
Usage: drizzle-sqlite-fts <command> [options]

Commands:
  generate   Write a migration for the FTS5 indexes that changed
  check      Exit with 1 when an index changed without a migration for it
  sql        Print SQL that creates every index, its triggers and its contents

Options:
  -c, --config <file>  The drizzle-kit config, by default drizzle.config.ts
  --name <name>        The migration name for generate, by default "fts"
  --allow-data-loss    Let generate recreate a contentless or standalone index empty
  -h, --help           Show this help

Exit codes: 0 done, 1 changes pending or an error, 2 a change was refused.
```

The CLI reads the same config as drizzle-kit (`dialect` `sqlite`, `turso` or `d1-http`, `schema`, `out` and `casing`) and finds every `fts5()` export in the schema files. It keeps the state of each index in a comment at the top of the migrations it writes, so it works out what changed from the migrations alone. Branches that each add an index merge cleanly.

Changing an external-content index recreates it and fills it again from the table. A standalone index that stays standalone keeps its rows: they're copied into the new one. A contentless index can't be refilled, so changing one, or turning a standalone index into another mode, is refused with exit code 2 unless you pass `--allow-data-loss`. Nothing is written when a change is refused.

## Benchmarks

Search over 100,000 notes, each with a 6-word title and a 60-word body. The words come from a made-up 20,000-word vocabulary with a Zipf-like spread, from a seeded generator, so every run builds the same data. Each query set is 50 different queries, and each returns the top 20. The table shows the median time per query over 7 runs, after 2 warmup runs. Times are in milliseconds, lower is better.

| Approach | Common word | Rare word | Two common words |
| --- | ---: | ---: | ---: |
| Drizzle `like()` on both columns, newest first | 0.055 | 7.176 | 0.135 |
| **drizzle-sqlite-fts `match()` + `bm25()`** | 1.760 | 0.140 | 0.345 |
| drizzle-sqlite-fts `match()`, newest first | 0.054 | 0.050 | 0.092 |
| Hand-written FTS5 SQL in a Drizzle `sql` template | 1.738 | 0.119 | 0.317 |
| Hand-written FTS5 SQL, prepared once (better-sqlite3, no Drizzle) | 1.745 | 0.101 | 0.303 |
| [SiftLite](https://github.com/aashahin/siftlite) 0.3 `search()` | 1.835 | 0.166 | 0.391 |
| [MiniSearch](https://github.com/lucaong/minisearch) 7, in memory | 1.924 | 0.060 | 1.899 |

What the numbers say:

- **`LIKE` is only fast when it can stop early.** A common word is in the first 20 rows it reads, so it's done quickly. A rare word makes it read the whole table, 50 to 140 times slower than FTS5. Real search boxes see both kinds of input.
- **Ranking costs time on common words.** `bm25()` has to score every row that matches before it can return the best 20, and a common word matches thousands. If you don't need relevance order, order by `rowid` and FTS5 stops after 20 rows.
- **The helpers cost 0.02 to 0.03 ms a query** over the same FTS5 SQL written by hand, which is Drizzle building the query. The benchmark checks that every FTS5 approach returns the same rows.
- **MiniSearch** answers rare-word queries fastest, but it keeps the whole index in JavaScript memory: building it took 4.5 s and 293 MB of heap here, on every process start. The FTS5 index lives in the database file: 36 MB on top of a 60 MB table, built once.
- **SiftLite** also uses FTS5 and gives the same results. It ships its own schema and CLI, separate from Drizzle's.

The index makes writes slower, because every write also updates it through the triggers:

| Write, in one transaction | No index | With the index and its triggers |
| --- | ---: | ---: |
| Insert 100,000 rows | 98 ms | 3,042 ms |
| Update the body of 10,000 rows | 3 ms | 105 ms |
| Delete 10,000 rows | 2 ms | 77 ms |

That's about 0.03 ms more per inserted row. For a large first import, load the rows before the index migration runs: its backfill indexes them all in one pass.

Machine: Apple M5, macOS, Node.js 24.17.0, SQLite 3.54.1 through better-sqlite3 12, in-memory database. To run it yourself:

```sh
git clone https://github.com/RagedPanda/drizzle-sqlite-fts && cd drizzle-sqlite-fts
npm ci
npm run bench                  # BENCH_ROWS and BENCH_RUNS change the size and the run count
```

## Good to know

- **`INSERT OR REPLACE` needs `PRAGMA recursive_triggers = ON`.** SQLite doesn't fire delete triggers for rows that `REPLACE` removes unless that pragma is on, so the old text stays in the index and `integrity-check` reports it as corrupt. Turn the pragma on for each connection, or use `INSERT ... ON CONFLICT DO UPDATE`, which fires the update trigger and is fine.
- **Paginate with a tiebreaker.** Rows with equal scores come back in any order, so pages can repeat or skip rows. Order by `bm25(...)` and then `rowid`.
- **Trigram needs three characters.** With `tokenize: 'trigram'` a search term shorter than three characters matches nothing.
- **`drizzle-kit push` needs `ftsTablesFilter()`**, or it drops the index. See [drizzle-kit push](#drizzle-kit-push).
- **Cloudflare D1** runs the migrations, but `wrangler d1 export` refuses databases that contain virtual tables. Drop the index before exporting, or export the tables you need.
- **Turso**: libSQL databases support FTS5. The newer Turso Database engine, the Rust rewrite of SQLite, doesn't support FTS5 at the time of writing.
- **Tested** in CI with better-sqlite3, libsql and node:sqlite, on Linux, macOS and Windows, with drizzle-orm 0.36, 0.45 and 1.0-rc. bun:sqlite and D1 run the same SQL but aren't tested in CI yet.
- **One runtime dependency:** [jiti](https://github.com/unjs/jiti), so the CLI can load your TypeScript config and schema files the way drizzle-kit does. Only the CLI loads it, so it never ends up in your application's bundle. jiti itself has no dependencies.

## Related

- [drizzle-orm#2046](https://github.com/drizzle-team/drizzle-orm/issues/2046): the upstream request for FTS5 and other virtual tables.
- [SiftLite](https://github.com/aashahin/siftlite): FTS5 search with its own index definitions and CLI, not tied to Drizzle.
- [MiniSearch](https://github.com/lucaong/minisearch): full-text search in JavaScript memory, for data that fits in the process.
- [drizzle-triggers](https://github.com/RagedPanda/drizzle-triggers): the same declare-then-generate approach for Postgres triggers and functions.
- [SQLite FTS5 documentation](https://www.sqlite.org/fts5.html): external content tables, bm25, highlight and snippet.

## License

MIT
