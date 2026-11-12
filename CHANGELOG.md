# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `fts5()` declares an FTS5 full-text index next to your Drizzle schema: external-content over an existing table (the default), contentless or standalone, with `tokenize`, `prefix`, `detail` and `columnsize` options. It checks the declaration up front (text columns only, a stable integer key, names FTS5 reserves) and returns a typed handle you can select from with `rowid` and `rank`. ([#3](https://github.com/RagedPanda/drizzle-sqlite-fts/pull/3) by [@RagedPanda](https://github.com/RagedPanda))
- `match()`, `rawMatch()`, `bm25()`, `highlight()` and `snippet()` query helpers. `match()` turns what a user typed into a query that can't be an FTS5 syntax error, with an optional prefix match for search-as-you-type; `bm25()` weights take column keys; `highlight()` and `snippet()` refuse a contentless index at compile time. ([#5](https://github.com/RagedPanda/drizzle-sqlite-fts/pull/5) by [@RagedPanda](https://github.com/RagedPanda))
- A `drizzle-sqlite-fts` CLI. `generate` writes the SQL for the indexes that changed into a migration drizzle-kit creates, and recreates the sync triggers when drizzle-kit rebuilds a table and drops them. `check` exits with 1 when an index changed without a migration, for CI. `sql` prints everything for a database you set up by hand. Changes that would lose rows or cannot run are refused with exit code 2, and nothing is written. ([#7](https://github.com/RagedPanda/drizzle-sqlite-fts/pull/7) by [@RagedPanda](https://github.com/RagedPanda))
- `ftsTablesFilter()` returns `tablesFilter` patterns that stop `drizzle-kit push` from dropping your indexes and their shadow tables. ([#7](https://github.com/RagedPanda/drizzle-sqlite-fts/pull/7) by [@RagedPanda](https://github.com/RagedPanda))

[Unreleased]: https://github.com/RagedPanda/drizzle-sqlite-fts/commits/main
