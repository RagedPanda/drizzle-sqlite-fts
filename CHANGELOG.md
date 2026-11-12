# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `fts5()` declares an FTS5 full-text index next to your Drizzle schema: external-content over an existing table (the default), contentless or standalone, with `tokenize`, `prefix`, `detail` and `columnsize` options. It checks the declaration up front (text columns only, a stable integer key, names FTS5 reserves) and returns a typed handle you can select from with `rowid` and `rank`. ([#3](https://github.com/RagedPanda/drizzle-sqlite-fts/pull/3) by [@RagedPanda](https://github.com/RagedPanda))

[Unreleased]: https://github.com/RagedPanda/drizzle-sqlite-fts/commits/main
