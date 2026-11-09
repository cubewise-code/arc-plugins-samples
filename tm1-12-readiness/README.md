# TM1 12 Readiness — an Arc for TM1 plugin

Created by Muhammad Eissa, Cubewise — [meissa@cubewise.com](mailto:meissa@cubewise.com).

This plugin prepares a TM1 v11 model for IBM's **Database Migration Utility** (`migrate_tm1`),
which moves it to **TM1 v12**, on PA as a Service or a local install. It also checks the
TM1 12 database once the model is there. It was called *SaaS Migration* up to v0.2.2. It works the same way throughout: **find → suggest → apply**, one finding at
a time or in bulk.

- **Findings.** Covers the following, each with a suggested action:
  - TI functions TM1 12 does not have (the process is left out by the utility);
  - MDX that fails or returns nothing in TM1 12;
  - removed control objects;
  - file paths TM1 12 cannot reach;
  - names the utility rejects.

  Each object name opens that object in Arc. A finding you decide to leave can be **skipped**:
  it leaves the list and the counts, Apply leaves its statement alone, and the skip is
  remembered for that instance in this browser.
- **Apply.** Comments out removed calls, together with the variable chains that depend on them.
  It stubs `ExecuteCommand` with a commented `ExecuteHttpRequest` template, and rewrites MDX
  attribute and subset references. Before writing, it saves a backup and dry-run compiles the
  fix. After writing, it reads the object back, compiles it, and rolls back if either step
  fails.
- **v12 compile check.** Dry-runs every v11 process against a connected TM1 12 database's
  compiler. Nothing is saved there.
- **CloudID (v11 only).** Creates the `CloudID` element in `}ClientProperties`, then lets you fill it by
  hand or by CSV import, or export a CSV to be filled in. It warns about duplicates and about
  clients that will not migrate.
- **TM1 Applications.** Deletes every `}tp_*` object (chores, processes, views, subsets, cubes,
  dimensions and their control objects) after a backup that restores them, cube data and
  attribute values included. It lists what outside TM1 Applications still points into it.
- **Bedrock.** Compares every Bedrock process with Bedrock 5 (from GitHub, or the bundled copy)
  and works out which ones business processes and chores use. On the TM1 12 database it
  upgrades the used ones, installs the Bedrock 5 processes callers need, and updates those
  callers: removed parameters are dropped and changed defaults are passed with their old value.
  It deletes the ones nothing uses, on either version.
- **Removed objects in use.** Flags every object the migration will remove, and highlights the
  surviving processes and chores that still use one.
- **Backups.** Every write saves the original first, as a JSON file in the Downloads folder. The
  Backups tab restores it.
- **Guide.** A one-stop migration guide for consultants: `MIGRATION-GUIDE.html`.

## Install

1. Copy this folder to `<Arc>\plugins\tm1-12-readiness`. Include `plugin.js`, `template.html`,
   `translate-en.json`, `README.md`, `MIGRATION-GUIDE.md`, `MIGRATION-GUIDE.html` and `img\`
   (and `bedrock\` if you have it: it is not in the public release, see below).
2. Hard-reload Arc with **Ctrl+Shift+R**. Arc caches plugin files for a long time, so a normal
   reload or a restart is not enough.
3. Open **Tools → TM1 12 Readiness** on the v11 instance, or on the TM1 12 database after the
   migration.

Arc picks up a new plugin folder by itself; `plugins.yml` does not need editing.

## Requirements

- Arc for TM1 6.0 or later.
- An **admin** session on the instance, for Apply, CloudID and restore. Scanning needs only read
  access.
- For the v12 compile check, a TM1 v12 (PA as a Service) database added to Arc.

## What it changes, and what it does not

- It changes only what an Apply, CloudID save, TM1 Applications clean-up, Bedrock run or restore
  writes, after a confirmation. Every one of those writes is backed up first.
- **Apply writes to the live v11 model.** A removed call no longer runs in v11 until cutover,
  and each finding says what that costs (for example, a load no longer turns transaction logging
  off).
- It deletes only in two places, each behind its own confirmation and a backup: the TM1
  Applications tab (`}tp_*` objects) and the Bedrock tab (Bedrock processes nothing uses). It does
  not rename objects, and it does not touch `tm1s.cfg`.

## Files

| File | What it is |
|---|---|
| `plugin.js` | the registration, the pure core (`saasMigrationCore`: tokenizer, scanners, fixers, CSV, catalogue), and the page |
| `template.html` | the page |
| `translate-en.json` | every UI string (`SAASMIG_*`) |
| `MIGRATION-GUIDE.md` / `.html` | the consultant guide; the `.html` is generated from the `.md` |
| `bedrock/bedrock.json` | optional, and **not in the public release**: an offline copy of Bedrock 5's installer asset, under Bedrock's own licence (`bedrock/LICENSE.md`, which does not allow publishing it on a web site without permission). Without it the Bedrock tab reads Bedrock 5 from github.com/cubewise-code/bedrock-5, and offers no other source |

The tests and the build tools live in the development repository, which is not published.

## Contact

Questions, feedback and bug reports: Muhammad Eissa, Cubewise — [meissa@cubewise.com](mailto:meissa@cubewise.com).

## License

Released under the MIT License, copyright Cubewise: see `LICENSE` and `NOTICE` at the top of the
repository. IBM's trademarks and Bedrock are not covered by it.
