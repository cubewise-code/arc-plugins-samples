# Calculation Explorer plugin

Created by Muhammad Eissa, Cubewise — [meissa@cubewise.com](mailto:meissa@cubewise.com).

Trace a TM1 cell from a cube view down through every rule, consolidation and cross-cube hop —
and hand the result to someone else as a single interactive HTML file.

Arc's built-in trace tells you the rule statement and the immediate components. Calculation Explorer
answers the question you actually have: **where did this number come from?**

> **Using the plugin rather than changing it?** Read **[USER-GUIDE.md](USER-GUIDE.md)** instead —
> same ground, written for the person tracing a number, without the implementation notes. This file
> is the feature and implementation reference.

**Current release: v1.14.1**, verified against Arc 6.0.0. The server-memory bug that held every
earlier release back is **fixed in this one** — the request is now bounded, so the component closure
is never built. *Known limitations* records what it was, what it cost, and the one thing still worth
knowing: trace depth decides what the server builds, and the cost climbs steeply with it.

## What it does

- **The cell first, the tree on request.** Clicking a cell asks the server one small question —
  the value, the rule that produced it, its type and its coordinate, measured at **905 bytes** on
  the demo model — and stops there. Unlike the tree, this one cannot grow with how wide the cell is,
  because the query names no `Components` at all; what can lengthen it is a cell with several
  candidate rule statements, or a cube with many dimensions, and both are linear rather than
  combinatorial. **Build the component tree** is a separate, priced click. This is the
  only change that *reduces* what the open bug in *Known limitations* costs rather than rationing
  how often it is paid: the closure is never built unless somebody asks for it. The **Feeders** tab
  works off a previewed cell too, so feeders need no tree at all.
- **Start from a view.** Pick an instance, a cube and a view (public or private), then click any
  cell in the grid. Rule-derived cells are shaded and consolidated cells are bold, so the
  interesting cells are easy to spot. You can also paste MDX, or type the coordinates yourself.
- **Or start from the tree.** Right-click a **cube** → *Calculation Explorer* opens on that cube;
  right-click a **view** → it opens with that view loaded and ready to click a cell.
- **Or right-click the cell itself.** Arc's cube viewer cell menu → **Trace Calculation** opens
  *this* plugin on that cell and shows its value and rule (the tree is one further click), and →
  **Trace Feeders** opens it on the
  Feeders tab with that cell's feeder statements and fed cells already loaded. Arc's cell menu takes
  no plugins, so the navigation is intercepted rather than the menu extended (see below) — and each is
  reversible on its own: under *Open Arc's cell menu here* on the first tab, one checkbox governs
  **Trace Calculation** and one governs **Trace Feeders**, so you can keep Arc's feeder page while
  calculation traces open here, or the reverse. No reload either way. (Re-ticking was broken in
  v1.3.0; see "One setting, one object" below.)
- **Or paste a cell reference.** Arc's cube viewer has no plugin hook on its *cell* context menu,
  so the two-click path is: right-click a cell → **Cell Reference** → select the table it shows and
  paste it into the *Coordinates I type* box. That dialog puts three tab-separated columns on the
  clipboard, which is exactly what the box expects:

  ```
  Dimension            Hierarchy            Element
  Country and Region   Country and Region   Americas
  Retailers            Retailers            ALL RETAILERS
  Assumptions          Assumptions          GMWA
  Store Size           Store Size           Full Size Store
  Store Type           Store Type           Franchise Store
  DATA                 DATA                 DATA
  ```

  Rows are matched **by dimension name**, so the order does not matter, and the **hierarchy column
  is used for the trace** — which is what makes a cell on an alternate hierarchy traceable at all.
  The header row and the dialog's `Value:` line are ignored. The dialog does not name the cube, so
  pick that on the left first. Two-column tables (`Dimension`/`Element`), a plain
  `Germany, Feb, Gross Revenue` list in cube dimension order, and a
  `DB('Cube','Germany','Feb',…)` formula all work too. A paste that only covers some dimensions is
  not rejected: the matched rows are filled in, it says how many, and you finish the rest by hand.
- **Two ways to read a trace.** A *technical view* for developers (cubes, full coordinates, rule
  statements) and a **business view** for everyone else — see below.
- **Every node is labelled.** Each step shows the cube and the full coordinate that produced it —
  `Promotions Plan :: Country and Region = Asia Pacific, Promotions = Base Monthly Sales
  = 23,441,357.31` — not just a bare value. When a step used an **alternate hierarchy** it says so
  (`Country and Region:Country and Region 2025 = Europe`), because that is the kind of detail that
  quietly explains a wrong number.
- **Depth is a real limit, and a real cost — changed in v1.12.0.** Until v1.11.1 the requested depth was only how much came back *labelled*: TM1 returned the whole component closure whatever you asked for. Since v1.12.0 the request is bounded to the depth you ask for, so depth decides what the server builds. Each extra level multiplies it — measured on one cell of the demo model: **83 KB at depth 3, 1.1 MB at 4, 11.8 MB at 5, 37 MB at 6**. "Trace
  deeper here" on any node re-roots the trace at that cell and splices the result in, so you can
  keep going as far as the model does. **Auto-drill** follows the biggest contributor down for you.
- **Cross-cube hops are visible.** `DB()` lookups and attribute reads show up as what they are —
  a jump into another cube, including control cubes like `}ElementAttributes_<dim>`. The cube name
  is highlighted whenever it changes.
- **Rules are readable, and located.** Statements come back from the API with every newline
  stripped. Calculation Explorer finds each statement in the cube's rule file and shows it in the
  author's own formatting, with the **line number and the comment block above it**. When it cannot
  find it (generated rules, for instance) it re-indents the statement instead.
- **Consolidations are explained.** Each child shows its share of its parent, with a bar, so the
  one line that moves the number stands out.
- **Stored input cells are named as such.** A leaf that holds its own value — typed in or loaded,
  with no rule behind it — carries a green **input** chip on the row and a sentence in the panel:
  *the value was typed in or loaded, not calculated. The trace stops here.* That is usually the
  answer to "where did this number come from", so it is not left to an icon.
- **The traced cell is copyable.** The coordinate line stays on one line to leave room for the
  tree, but a chevron unwraps it in full for selecting, and two buttons copy it — as readable text,
  or as the `Dimension / Hierarchy / Element` table Arc's own Cell Reference produces, which pastes
  straight back into this plugin.
- **Feeders.** If a rule-derived cell reads zero when it should not, the Feeders tab runs
  `TraceFeeders` and `CheckFeeders` for that cell.
- **Interactive HTML export.** One self-contained file — no server, no CDN, no internet. It has the
  full collapsible tree, per-node contribution bars, syntax-highlighted rules with their line
  numbers, a filter box, hide-zero / rules-only toggles, a cube filter and a copy-as-text button.
  It follows the reader's light/dark preference and prints cleanly. All four ways out live behind
  the **Share** menu at the right of the trace toolbar: `Open HTML` shows it straight away,
  `Save HTML` writes the file, `Copy` puts a plain-text version on the clipboard and `Save text`
  writes that. They were four toolbar buttons until the toolbar started wrapping onto a second row,
  which on a page Arc clips rather than scrolls costs the tree that height (2.8).
- **History.** Every trace is remembered (in Arc's UI preferences) so you can re-run it later.
- **You can see that a trace is running, and TM1 says how long it has been running.** A walk takes
  15–22 s on the demo model and longer on a real one, so while one is in flight the tab strip
  carries a spinner, what the server is doing, the cube and the elapsed seconds — *Tracing on the
  server · Store Cost · 13s*. The seconds are **TM1's own**, read from its thread list, not timed in
  the page: a page timer keeps counting after a connection drops, and this one does not. It appears
  on **all six** ways in, including the three where you clicked nothing on this page — Arc's cell
  menu, an opened link and a history replay — which used to show nothing at all for the whole walk.
  See *One trace runs at a time* under *Known limitations* for the two questions it may ask you
  first.

A generated example of the export (`tests/sample-trace.html`) is kept in the development
repository, which is not published.

## The business view

The technical view answers "what does this rule do". The business view answers "where did the
number come from", and it does that by taking things away:

| | Technical view | Business view |
|---|---|---|
| Row label | `cube :: dim = el, dim = el, …` | **only the part that changed** — `Feb`, not the whole tuple |
| Detail | rule statement | **Cell**, **Calculation**, **Values used**, then the rule — collapsed |
| Breadth | whole tree expandable at once | **one branch open at a time** (accordion) + a breadcrumb of the path |
| Order | the model's own order | **biggest contributor first** (toggleable) |
| Zeros | shown | folded into `+ 3 with no value` |
| Cube hops | cube name on every row | only when it changes, as `— from Base Sales Forecast` |
| Rules | always visible | behind a **why** link, with the rule-file line |
| Going deeper | a "deeper" button per row | just keep clicking — a row with nothing under it fetches its next level |

Both views offer that only where a level can actually exist. `core.hasDeeperLevel(node)` is the single
predicate behind the business view's `⊞` caret, the technical view's deeper button, and the three
`deepen` call sites (`drill`, `autoDrill`, `resolveAll`): the node needs a cube and a tuple, and it
must not be a **stored input**. A `Simple` cell holds its own value, so the trace stops there by
definition — which is exactly what its `input` chip and its panel already say in words, while the row
drew a `⊞` beside them and fetched nothing when clicked. Terminal rows that *are* worth a click keep
the `⊞`; a stored input gets the plain `○`. The exported page needs no equivalent: it cannot fetch,
so its rows draw a caret only for children they already carry.

So a promotion value that took 16 technical rows opens as three:

```
Asia Pacific · 1 · % Planned Promotion Value        22.67
   Planned Promotion Value  ▓▓▓▓▓▓▓░░░   68%    5,560,339
   Base Monthly Sales       ▓▓▓░░░░░░░   32%   23,441,357
```

…and each click drills one level, keeping the breadcrumb honest:
`Promotions Plan 22.67 › Base Monthly Sales 23,441,357 › Mar 23,441,357`.

Both the plugin and the exported HTML open in the **business view**, with a toggle to the technical
one in the toolbar; the export carries both.

**Why?** is the affordance that matters here, so it is a filled blue pill rather than a grey
outline, and it turns solid and reads *Hide* while its panel is open — in the app and in the export.

The **traced cell's own panel opens itself**. It is the one node whose workings the reader definitely
came for, so asking for it was a wasted click. The seed is `$scope.why = { "0": true }` where the
trace is built — `"0"` is the root's id, the same one `state.openPath` gets — and the export keeps
the equivalent in a `whyOpen` map so that closing the panel survives the re-render every drill does.
The panel lives *inside* the tree's own scroll box (`.ce-btree`, `overflow-y: auto`, sized by
`ce-fill`), so it costs visible rows rather than pushing the tree off a page Arc clips (§2.8) — and
what keeps that cost bounded is the cap on *Values used* below.

A step that keeps the same element but switches **hierarchy** (`Americas` in the primary hierarchy →
`Americas` in `Country and Region 2025`) is labelled as such —
`Americas (Country and Region 2025 hierarchy)` — rather than reading as "nothing changed", which is
what it used to do.

## Demo data only

Every example in this file and in `USER-GUIDE.md`, every test fixture, and the
sample export in `tests/` names only **GO_New_Stores**, IBM's TM1 sample model that
ships with a local TM1 installation. No client model may be named anywhere in this repo: this folder is
handed to clients and the guide gets published. Two `DEMO DATA ONLY` tests fail
if a foreign cube, dimension or instance name appears in any file (the tests and their
allowlists are in the development repository, which is not published).

## The detail panel: Cell, Calculation, Values used

Both views open the same four sections, in the order a reader needs them:

1. **Cell** — the coordinate, one chip per dimension (`Retailers = ALL RETAILERS`,
   `Month = Apr`, …). An alternate hierarchy shows as
   `Country and Region:Country and Region 2025`.
2. **Calculation** — the rule, rewritten as arithmetic with each operand's own value substituted
   in. `['Gross Sales Margin':{'Effect of All Store Promotions'}] = C:(['Gross Sales
   Margin':'ASPWA']*100)\['Gross Sales Margin':'GROSS REVENUE'];` becomes

   > **Effect of All Store Promotions** = ( ASPWA `4,168` × 100 ) \ GROSS REVENUE `124,431,529`

   Dimension qualifiers and `{set}` braces are dropped — and where an area names a *set* of
   elements, the heading resolves it to **the member this cell has**, because that line describes
   the cell rather than the rule's whole reach. With no coordinates to match against it says
   `first +N more` instead of picking one (§4n). Each operand is matched to the component
   that supplied its value, and each component is consumed once so a formula that references the
   same element twice lines up with the two components the server returned. An operand nothing
   reported a value for is marked rather than guessed at. A consolidation has no statement — it is
   stated as *Sum of N components*. A `DB( )` lookup gets its coordinates filled in — see below.
3. **Values used** — the components with their values, whether or not each matched an operand.
   **Capped at 12 rows**, with a line saying how many were left out. A consolidation has one
   component per child, up to `MAX_CHILDREN` of them: 250 rows at ~20px is 5,000px of list above a
   tree box around 600px tall, which was survivable while the panel only opened on request and is
   not now that the root's opens itself. Two details make the cut honest — the *Sum of N components*
   line above it counts **all** of them (`operandCount`, tracked separately from the list), and a
   consolidation's list is sorted **biggest first** before it is cut, because its children arrive in
   whatever order TM1 returned them and "the first twelve" would drop the largest contributor as
   readily as the smallest. A rule's operands are *not* sorted: there the order is the formula's, and
   sorting it would break the correspondence the section exists to show.
4. **Rule** — the original statement with its rule-file line number, collapsed by default.

### A `DB( )` lookup shows the coordinates TM1 actually read

A rule reads another cube with `DB('Cube', coord, coord, …)`, and those coordinates are almost
always `!dimension` references or `ATTRS( )` calls. The text therefore says *where to look* and
never *what was looked at* — which is exactly the question the panel exists to answer. Off the demo
model:

```
['Gross Sales Margin':{'Volume Discount', …}] = N:DB('Base Sales Forecast', !Country and Region,
   !Retailers, ATTRS('Gross Sales Margin', !Gross Sales Margin,
   '}Map_}Link_Gross Mrgin Calc_3CBase Sales Forecast'), !Store Type, !Budget version, !Month);
```

now reads

> DB('Base Sales Forecast', **Americas**, **Department Store**, **Volume Discount**,
> **Franchise Store**, **Budget version 1**, **Mar**) `95,577.52`

The bold parts are substituted; hovering one shows the text it replaced. **Every one of them is read
off the component TM1 returned for that lookup — this cell's own coordinates are never substituted
into the rule text.** That direction is the whole safety property, and §4l is why: `statements[0]`
is not reliably the node's own rule, so putting our coordinates into a statement can produce a
confidently wrong lookup, while reading them off the component cannot.

How a lookup is tied to its component (§2.1, §4l): **a DB call's arguments are in the target cube's
dimension order, and so is a component's `Tuple`.** So a component qualifies when it is in the
target cube, has one element per coordinate argument, and agrees with every argument the rule spells
out — checked by position, with no dimension list needed. A lookup binds only when **exactly one**
unused component qualifies.

Three consequences worth knowing:

- An argument the rule writes out is left **exactly as written**. `'1'` substituted back over itself
  says nothing; what is highlighted is only what a reader could not otherwise know. It is also what
  tells ten lookups apart: the promotions rule reads the same link cube ten times, differing only in
  a `'1'`…`'10'`, and each finds its own component by that literal at that position.
- Two lookups the text **cannot** tell apart are left verbatim, not guessed at. They may still
  resolve one at a time — the New Stores rule reads the same cube twice, one carrying a literal and
  one carrying none, and the second binds because it is then the only component of that cube still
  unspoken for.
- An unmatched lookup shows no `?`. That mark means "TM1 was asked for this operand and did not
  report it"; a lookup nothing was asked about would be a claim of absence there is no evidence for.

Lookups are bound **before** `[ … ]` operands. A `[ … ]` operand matches on element name alone and
ignores the cube, so it would happily consume a cross-cube component that merely shares a name;
binding the specific matcher first keeps the loose one off components already spoken for.

**The name is compared exactly, so the rule text is tidied only outside its quotes.** TM1 permits
consecutive spaces in an element name and the demo model has one — `Effect of  Single Retailer
Promotions`, two spaces. Collapsing whitespace across the whole statement (which is what v1.14.1
and earlier did) shortened that label by a space, no component could match it, and the panel printed
`?` for an operand TM1 had reported at 29 — while *Values used* four rows below printed the 29. HTML
collapses the double space as well, so the two labels rendered identically and nothing on screen
could show the difference. `collapseOutsideStrings` tidies the space *between* tokens and leaves
every quoted name exactly as the rule wrote it; the compare itself is left strict, because two
elements differing only in whitespace can both exist and binding the wrong one would be worse than
failing honestly.

**Every operand chip leads somewhere.** A matched one opens its component where it sits in the tree
(`jumpTo`, no request). An unmatched one traces the cell the reference names — this node's coordinate
with the reference's own members substituted in, built by `referencePairs` + `operandCoordinates` and
run through `previewCoordinates`, the same gated named-gesture path the cell menu and a link use, so
there is no second gate to keep in step. A reference that would need a **guess** leaves the chip
inert: `['X']` names no dimension, a `{set}` is not one cell, and a dimension this cube does not have
means the reference reaches another one. The chip also stops advertising itself while a walk or a
preview is in flight.

### Which returned statement is the cell's own

TM1 hands a node its **components'** statements as well as its own, and not in that order. The demo
model's `New Store Opening (hide)` returns **ten**: nine copies of the link cube's rule, and the
cell's own **last**. Reading `statements[0]` therefore showed a foreign formula as if it were the
cell's — §4l records this as the sharpest hazard in this area, and it is why a `DB( )` lookup could
not be resolved on the shape where it matters most.

The discriminator is exact rather than heuristic: **a `!dimension` reference always names a
dimension of the rule's own cube**, even where it sits inside a `DB( )` reading another one. A
statement naming `!ID numbers` and `!New Stores` cannot be a rule of a cube that has neither.

It is written as a *keep* test and not a *drop* test, deliberately. A dimension name holding a
character the reference scanner stops at would be read short; dropping on that would hide the right
statement, while keeping on it merely fails to promote it and the whole set falls back to what was
shown before. The worst case is therefore the old behaviour, not a worse one. The same fallback
covers a node with no coordinates to test against.

Statements set aside are **counted and named** under the formula, and still listed in full under
*Rule*, because the two counts would otherwise disagree with no explanation.

### `calcFor` memoises on the node, not on the id

The template asks for the *Calculation* view on every digest of an open row, so it has to hand back
the same object each time or Angular never settles. That memo is stored **on the node**
(`node.calcView`), and the reason is a bug that shipped invisibly until the root's panel started
opening itself.

It used to be a map keyed by `node.id`, cleared at the top of each trace. But an id is only unique
within one trace, and every re-trace has a window where `$scope.trace` already holds the new tree
while `$scope.rows` still holds the old one — `enrichTree` is asynchronous and `refreshRows` runs
only when it resolves. A digest inside that window filled key `"0"` from the **old** root, and every
later ask for the new root got that answer back. Measured in the running app: a consolidation of 8
retailers reporting `Store Cost`'s `GMWA` rule, with the previous cell's operand values, under its
own correct coordinates. Emptying the map first never helped, because it is the refill that lands.

A node object belongs to exactly one trace, so keyed this way there is no window, nothing to
invalidate when a trace arrives, and no reset for a later code path to forget. The one place that
does invalidate is `deepen`, which replaces a node's children and so changes its operands.

### Percentages only where they mean something

A share of the parent is shown only when the children actually add up to it — always for a
consolidation, and for a rule only when the arithmetic checks out. So
`['Cost'] = N: ['Material'] + ['Resource']` gets percentages, while
`(['ASPWA']*100) \ ['GROSS REVENUE']` does not. Without that test a margin of 9.45 with an operand
of 124,431,529 rendered as **1317220763%**. Shares are also withheld when a node's children were
truncated by the render cap, because the sum would be incomplete.

### When a level has no coordinates

Nodes below the requested depth come back without coordinates. Rather than showing
"(no coordinates)", the label falls back to the element the rule writes to, in italics, and the row
offers **Resolve** — which re-traces the nearest labelled ancestor and splices the real coordinates
in. The toolbar's **Resolve labels** button does the whole tree in one go (capped, and it says so
when the cap is what stopped it).

## What keeps a big trace from taking the page down

These are not theoretical numbers. Tracing a rule cell of `Gross Margin Calculation` in
`GO_New_Stores` — `ALL RETAILERS / All Subsidiaries / Corporate Store / Total Year` — returns
**241,689 components** in ~15–22 s, of which only the first few levels carry coordinates. The API
sends the whole `Components` tree whatever `$expand` depth you ask for, so *lowering the trace depth
does* make this smaller since v1.12.0 — the request is bounded to the depth you ask for. Before v1.12.0 it did not, and only reduced how many levels came back labelled.

Three caps, each of which says what it did rather than quietly dropping things:

The budget is filled **breadth first**, and that is not a detail. Depth first spent the whole
allowance on the first branch: tracing `(['ASPWA']*100) \ ['GROSS REVENUE']` built 20,000 nodes
inside `ASPWA` and never created `GROSS REVENUE` at all, so the formula rendered
`GROSS REVENUE ?` as though TM1 had not returned it — it had, worth 1,491,096,086.6. Level by level,
every shallow level is complete before anything deeper is built, so a rule always shows all of its
operands and what runs out is detail at the frontier.

| Cap | Value | What you see |
|---|---|---|
| Nodes normalised from one trace | 20,000 | a warning naming how many components were left out, and the node it stopped at offers *trace deeper from here* |
| Rows handed to the DOM at once | 800 | a note at the end of the tree; collapse a branch or filter to see the rest |
| Exported page size | asks above 10 MB | the real size in the question — that 20,000 node trace exports as an **81 MB** page |
| Components rendered per node | 250 | reported per node; trace that child directly to see inside it |

The tree and the view grid also scroll on their own, because **Arc's tab content area clips a
plugin's content instead of scrolling it** (measured: `overflow: hidden`, 818 px of room against
923 px of content). A `ce-fill` directive measures where each box actually sits inside the clipping
container and sizes it to what is left, so a long trace is always reachable.

## Add this plugin to your environment

1. Copy the `calculation-explorer` folder into your Arc `plugins` folder — the one next to `arc.exe`
   (e.g. `C:\arc\plugins`). Arc adds `calculation-explorer: enabled: true` to `plugins.yml` itself on
   its next start.
2. **Hard-reload the Arc window** (`Ctrl+Shift+R`, or `Ctrl+F5`).
3. Open it from **Tools > Calculation Explorer**.

### Why step 2 is not optional

Arc concatenates every plugin's `plugin.js` into a single bundle served at
`/__/plugins__v<arc-version>.js` with `Cache-Control: public, max-age=31536000`. The URL changes
only when the Arc *version* changes — never when a plugin changes. So a browser that has already
fetched that bundle will keep running the old copy for a year, and restarting Arc does not help:
the server is fine, it is the client that never asks again. A hard reload bypasses that cache.

The same applies to **every edit** you make to this plugin, not just the first install — hard-reload
is the development loop. Note also that clearing `%APPDATA%\ArcForTM1\cache` does nothing when Arc
is being viewed in a normal browser tab; the stale bundle lives in that browser's own cache.

If a hard reload is awkward (an embedded window that swallows the shortcut, say), refetching just
that one resource from the console works too, then reload normally:

```js
var src = document.querySelector('script[src*="plugins__v"]').getAttribute('src');
fetch(src, { cache: 'reload' }).then(function () { location.reload(); });
```

**Read the URL rather than typing it.** Arc serves the running version in its own index, as
`<script src="__/plugins__v6.0.0.js">`, and that is the only version-proof way to name the bundle:
this snippet said `/__/plugins__v5.3.2207.js` until Arc 6.0.0 arrived, at which point it refetched
a URL that no longer exists and then reloaded — doing nothing while looking like it had worked.

`template.html`, `detail.html` and `translate-en.json` are separate resources with the same
year-long cache, so an edit to the markup or the strings needs those refetched too:

```js
['template.html', 'detail.html', 'translate-en.json'].forEach(function (f) {
   fetch('__/plugins/calculation-explorer/' + f, { cache: 'reload' });
});
```

## How it works, briefly

The trace comes from `POST /api/v1/Cubes('<cube>')/tm1.TraceCellCalculation` with the cell as a
`Tuple@odata.bind` body. The readability comes from expanding navigation properties the API does
not return by default:

```
?$expand=Tuple($select=Name;$expand=Hierarchy($select=Name;$expand=Dimension($select=Name))),
         Cube($select=Name),
         Components/Tuple(...),Components/Cube($select=Name),
         Components/Components/Tuple(...),Components/Components/Cube($select=Name)
```

`Components` is a complex type, so an `$expand` path may not end on it — every level has to
terminate on `Tuple` or `Cube`. The component tree itself always comes back in full; only the
labels are depth-limited, which is why nodes below the requested depth appear greyed out until you
trace deeper from their parent.

The pure logic (coordinate maths, statement location, tree normalisation, report building) lives in
the `calcExplorerCore` factory and is unit tested outside Arc:

```bash
node tests/run-tests.js
```

### Taking over a built-in page

Arc's cell context menu is not extensible, and `trace-calculation` and `trace-feeders` are **core
ui-router states**, not plugins — so `$rootScope.pluginUpgrades`, which rewrites plugin ids, has
nothing to grab. What works is that Arc runs ui-router 1.x and `$transitions` is injectable from a
plugin:

```js
$transitions.onBefore({ to: "trace-calculation" }, function (transition) {
   var p = transition.params();          // {instance, cube, elements, cellstatus}
   return transition.router.stateService.target("cubewiseCalculationExplorer", { instance: p.instance });
});
```

`trace-feeders` (`/trace-feeders/:instance/:cube/:elements`, no `cellstatus`) builds `elements`
exactly the same way, so both hooks are registered off one body with a `wantFeeders` flag and a
switch each -- `uiPrefs.calcExplorerTakeover` for the calculation page and
`uiPrefs.calcExplorerTakeoverFeeders` for the feeder page, both resolved through
`core.takeoverSettings()`, which carries a pre-v1.4.0 single setting forward to both so an upgrade
cannot hand back a takeover someone had refused. A Trace Feeders handover runs only the feeder check — that is
what was asked for, and it needs nothing but the coordinate, so it does not sit through a calculation
trace of a cell that might take 20 s. The coordinate rows are filled either way, so *Trace this
cell's calculation* on the feeders tab is one click.

`elements` arrives as one part per dimension, each `<dimension>:<element>` (or
`<dimension>:<hierarchy>:<element>`) with **each side percent-encoded individually**, the parts
joined by a literal `,` or `|`. ui-router removes one layer, so `%20` and `%25` survive:

```
Country%20and%20Region:Asia%20Pacific,ID%20numbers:1,Promotions:%25%20Planned%20Promotion%20Value
```

The parse is exact rather than a guess because `encodeURIComponent` escapes `,` `|` and `:` (as
`%2C` `%7C` `%3A`), so any literal one of them is a delimiter and never part of a name. Because each
part names its own dimension, order does not matter and a reported hierarchy is used for the trace.
Every part must match a dimension the cube actually has, exactly once; when it does not, the plugin
declines, Arc's own page opens, and the raw parameter is left in the paste box where you can see it.
A bare positional list (`El1|El2|El3` in cube dimension order) is accepted too.

### A page plugin can own its URL, but not its parameters

`$rootScope.plugin` reads `path` and `params` off a page registration and passes them straight into
the state it registers -- `path` **replaces** the URL it would have generated, so the base has to be
repeated verbatim. That much works: the page is registered as
`/calculation-explorer/:instance?cube&view&elements&depth`, and `$state.href()` builds links with the
cell in them.

What does not work is keeping anything there. Arc re-navigates every page-plugin state with
`{instance}` alone, immediately, and ui-router then re-syncs the state from that bare URL -- so by the
time a page could read `$state.params`, the cell is gone. Measured, not guessed: see
`PROJECT-PLAN.md` §2.12.

So the address is read **once, at file-parse time** (`calcExplorerHashAtLoad`), which is the only
moment it is still intact, and handed to the page through the same channel a context-menu click uses.
That covers a fresh load. A link pasted into an Arc that is *already running* is only a hash change,
so it never reaches that read -- it is caught instead by a `$locationChangeSuccess` listener in the
same run block, which works because **Arc's strip is a second navigation cycle about 40ms later, not
part of the first one's digest** (§2.12a, measured). Both ways in build the same request through the
same channel. The page still offers a link button rather than expecting anyone to copy the address
bar, because the address still normalises -- after a paste it shows the previous page's URL.

Two traps for anyone reusing this: a top-level `var` in a plugin file is a **global**, because Arc
concatenates every plugin's `plugin.js` into one bundle -- and do not name it `CALCEXPLORER_*`, since
that shape means "translate key" here and the key-coverage test will report it as a missing string.

### One setting, one object

`$rootScope.uiPrefs` is server-backed (`/_api/user-preferences/defaults` and `/overrides`), so Arc
can **replace** that object rather than mutate it. v1.3.0 read and wrote the takeover setting through
two different paths -- the checkbox bound to `$scope.uiPrefs`, captured once when the page opened,
while the transition hook read `$rootScope.uiPrefs` fresh on every transition. Replace the object
between those two and the setting splits in half: the tick lands on the orphan, the hook keeps
reading the live one, and the switch reads *on* while the takeover is off. Which is exactly what was
reported, and exactly what happens if you swap the object under an open page.

So: nothing captures that object. The checkbox writes through `setTakeover()`, one `$watch` on the
object's *identity* re-adopts whatever is current (the trace history rides along, since it lived on
the same object), and a unit test fails if a capture ever comes back. The general lesson for any
plugin setting Arc persists: read it live at the point of use, and never let a template bind to a
reference you took a copy of.

Two things about that object on Arc 6.0.0, both measured. It now carries a **`$`-prefixed API** on
the same plain object — `$default`, `$reset`, `$sync`, `$apply`, `$supported` — so a plugin key
called `$anything` would collide with Arc's own, and enumerating `uiPrefs` no longer yields only
settings. And this plugin's three keys came through the major upgrade **with their values**, and
through a hard reload, which is direct evidence the object is still server-backed rather than a
browser store. What is still not established is the thing this section is actually about: whether
Arc 6.0 ever *replaces* it. Nothing swapped it while it was being watched, so the identity `$watch`
stays.

### Asking the server what it is already doing (v1.10.0)

Two reads, both through Arc's proxy with the session the page already has, and both new in v1.10.0:

| Request | What it gives |
|---|---|
| `GET /<instance>/Threads` | every in-flight walk this reader is allowed to see — a calculation trace is `Function: POST …/tm1.TraceCellCalculation`, `State: Run`, with `Name` (the TM1 user), `Context` (`Arc/6.0.0`) and `ElapsedTime` (`P0DT00H00M13S`) |
| `GET /<instance>/ActiveUser?$select=Name` | who this page is, so a walk can be classified as yours or somebody else's. Cached per instance, **on success only** — a failed read is usually a session still coming up, and remembering that would switch the guard off for the life of the page |

**The classification is pure and lives in `calcExplorerCore`**: `parseIsoDuration` and
`inFlightTraces(payload, userName) → {mine, others}`. That is deliberate — the test suite has no
Angular and no DOM, so putting the judgement in a factory function is what makes it testable at all,
and it is where twelve of this feature's nineteen tests point. `inFlightTraces` **never throws for
anything**: a body that is not an object, a missing `value`, a thread with no `Function`, an
`ElapsedTime` nobody can parse — every one reads as "nothing seen", which leaves tracing as it was.

Four things to know before editing it:

- **The order in `traceCoordinates` is the feature.** `walkInFlight()` then `claimWalk()` are
  synchronous and run *before* anything is awaited, so the local one-walk limit still lands on the
  gesture; the claim is then held across the pre-flight request **and** across the dialog it may
  raise. A claim taken after the await would leave a window as wide as the round trip plus however
  long the dialog stands open. Cancel releases it; Continue runs on the claim already held and never
  re-claims.
- **`deepen`, auto-drill and resolve-all have no pre-flight, on purpose.** A confirm per hop in a
  15-hop drill is unusable, and they already ask once with the real count. All six entry paths land
  on `traceCoordinates`, which is what lets the indicator and the guard cover every one of them
  without hanging off any control.
- **The elapsed seconds are the server's, and there is no client clock anywhere in the indicator** —
  a structural test asserts the whole region contains no `new Date`, `Date.now`, `setInterval` or
  `setTimeout`, and that `$interval` is not injected. The poll is a chain of one-shot `$timeout`s at
  `WALK_POLL_MS = 1000` with a hard cap of `MAX_WALK_POLLS = 120`.
- **`receiving` is a real phase, not a cosmetic one.** The walking thread leaves `/Threads`
  **0.3–0.9 s before the first byte reaches the browser** (measured), so a purely thread-list-driven
  indicator would go dark while 133 MB is still streaming — precisely when a user decides nothing is
  happening and reloads. The seconds hold at the server's last reading during it, because that is
  what they are.

**And the trap this shipped a fix for, which generalises past this plugin: cancelling a timer does
not cancel a request already in flight.** The `$destroy` handler originally called `stopWalkPoll()`
alone, and a `readWalks()` already out then resolved onto the dead scope, found `state.walkNotice`
still set, and scheduled a fresh poll — 8 further `/Threads` reads in the 14 s after the tab was
torn down. The handler now calls `clearWalkNotice()` as well, because taking the state away is what
makes the callback's own guards fire. Both calls are load-bearing and a test pins the second.

### Three Arc behaviours worth knowing before you edit this

All three were found by driving the running app, not by reading docs:

- **What `$tm1.instances()` returns has already changed shape once, and only lodash absorbed it.**
  Up to Arc 5.3.2207 it was an **array**; from Arc 6.0.0 it is an **object keyed by instance name**
  (and it is the same object as `$rootScope.instances`, not a copy). This plugin filters and maps it
  with `_.filter` / `_.map`, which take a collection of either shape, so the instance dropdown
  carried on working with no edit and no test failing. **`.length`, `[0]`, `.forEach` or
  `Array.isArray` would all have broken outright** — and would have broken into an *empty instance
  list*, which is the state that makes every later request go to `/undefined/Cubes(...)` and 404
  (below). So treat it as a collection of unspecified shape and keep lodash between it and
  everything else: that this survived a major upgrade was luck, not design.

- **`$translate.instant()` does not return a string here.** Arc configures angular-translate to
  sanitise, so it hands back a `$sce` *trusted value wrapper* — `typeof "object"`, still true on Arc
  6.0.0. Passing one to `Notification.error({title: …})` throws `[$sce:itype]`, which is how every
  toast this plugin raised was silently lost. Everything user-facing goes through a small
  `translated()` helper that unwraps with `$sce.valueOf`, and it is still needed. The template's
  `translate` directive is unaffected. (One detail that *has* moved: concatenating a wrapper into a
  string used to render `[object Object]` and on 6.0.0 renders the text. Nobody re-ran that against
  5.3 to say whether it changed or was always so — either way the throw is the half that matters,
  and the throw is still there.)
- **The instance can arrive late.** Landing straight on `/calculation-explorer/<instance>` — a
  bookmark, a reload, a context-menu click while Arc is still connecting — can run the page before
  Arc reports any instance as loaded. The `<select>` then has no option to hold the value,
  `ngOptions` writes `undefined` over the model, and every request goes to `/undefined/Cubes(...)`
  and 404s. The page now adopts the instance it was opened for and retries the list once.

## Known limitations

- **FIXED in v1.12.0 — a trace used to cost the *server* far more than it cost the page.** This was
  the plugin's one serious defect and the reason earlier releases carried a blanket warning against
  production use. **That warning is withdrawn as of v1.12.0**: the request is bounded to the depth
  you ask for, so the server never builds the component closure. What remains is a cost you choose,
  and the numbers are below.

  The history, because it is the reason the fix looks the way it does. Reported from a live site: of
  two instances on one admin host, the one a calculation trace was run against grew from ~1 GB to
  ~200 GB and stayed there until restart.

  What was measured on the demo model (2026-09-08), tracing one cell of `Gross Margin Calculation`
  that returns 241,688 components: the response is **133 MB**, it takes **18 s**, and the TM1
  process goes from **49.5 MB to 465.2 MB resident and does not give it back** — about **1.8 KB of
  server memory per component**. Running the *same* trace again lands at 464.8 MB, so it is a
  high-water mark rather than a leak: **repeated tracing does not compound, but one trace of a very
  wide cell is the whole exposure.** At 1.8 KB/component the reported ~200 GB is around 116 million
  components, so the thing to be careful of is a single cell consolidated over very large
  dimensions.

  **FIXED AT THE SOURCE IN v1.12.0, and the two paragraphs that used to sit here were wrong.**
  They said that nothing bounds the response and that any caller pays the same price. The first
  was the right test spelled the wrong way; the second was an inference from it, and driving Arc's
  own built-in Trace Calculation refuted it.

  `$top` and `$levels` on `Components` really are rejected (HTTP 400) — that part stands. But
  `Components` being a **structural** property of a complex type is exactly why a request with *no
  query options at all* returns the whole closure: the default projection includes it, recursively.
  "No options" is the **maximum** projection, not the minimum. A top-level `$select` naming
  `Components/...` **paths** bounds the walk to the depth named, and the HTTP 400's own message
  — *"Expecting '/' after property of complex type in expand path"* — was pointing at that
  spelling all along. **Arc's own Trace Calculation has been sending it all along**, which is why
  the same cell costs **+0.7 MB** through Arc's page and cost **+437 MB** through this one.

  Measured on the same cell, same session, minutes apart:

  | Request | Time | Payload | TM1 resident |
  |---|---|---|---|
  | unbounded (what this plugin sent until v1.11.1) | 19,183 ms | 132,926,596 B | **+437 MB**, kept |
  | bounded to the requested depth (v1.12.0) | 1,043 ms | 83,191 B | **0 MB** |

  **Those are one cell's numbers, and the cell beside it is not like it.** At the same default
  depth, on the same cube of the demo model, four cells measured **24 KB, 81 KB, 512 KB and
  591 KB** — a 25× spread — each in about two seconds. The demo model's largest non-control
  dimension has **39 elements**; a production dimension has thousands, and a consolidation over
  one returns thousands of components at the first level alone. So read the table as *the shape
  of the fix*, not as a budget for your model: what a trace costs depends on the depth **and** on
  how wide the cell is.

  Same root value, same labels, and the same 115 rows the page actually draws at depth 3. Driven
  end to end through the page's own flow afterwards: 2,068 ms, `nodeCount 115`, and the TM1
  process flat at 467 MB commit across the whole trace.

  **What is left, and it is now a choice with a printed price rather than the default.** Depth
  decides what the server builds, and the growth is steep — about 4× a level on the measured
  cell, so a high depth on a very wide cell can still reach the old cost. The depth control says
  so, with those numbers. The plugin no longer asks for the whole closure at any depth it offers
  by default.

  What the plugin does about it today, in three parts. **The request is bounded** (above), so the
  closure is never built. **Exactly one trace runs at a time**
  (below), so the cost cannot be paid twice by accident. And **since v1.11.0 the cost is not
  paid at all until somebody asks for it**: clicking a cell fetches only the cell — its value,
  its rule, its type and its coordinate, measured at **905 bytes** — because the server does
  not build the component closure unless the closure is requested. The tree is a separate
  button that says what it costs. That does not make a walk cheaper, but it does mean the six
  ways into this plugin no longer spend 400 MB of server memory answering a question nobody
  asked — an opened link and a cell-menu handover previously did exactly that, with no gesture
  on this page at all. `PROJECT-PLAN.md` §5 item 0, §5a and §5a.9.

- **One trace runs at a time, and that is a deliberate limit rather than a queue.** A trace is one
  server-side walk, the bug above is about what that walk costs, and every cap in the table above
  acts on the *response*. So the page allows exactly one walk in flight: the grid stops taking
  clicks and marks the cell it is working on, a *deeper* caret is refused while anything is
  running (re-rooting a trace at a node is a second full walk, not a continuation), and the two
  fan-out actions — *Auto-drill*, which re-traces at every hop, and *Resolve all*, which traces
  once per unresolved boundary — ask first and tell you how many traces they are about to request.
  A refused trace says so rather than queueing.

  **And since v1.10.0 the server is asked too, because the page's own memory is not enough.** A
  walk **outlives the page that asked for it** by at least ten seconds (measured), so reloading —
  the natural thing to do when nothing appears to be happening — used to hand you a fresh page with
  the limit reset while TM1 was still walking, and one click then bought two concurrent walks. So
  before starting a walk the plugin reads TM1's thread list, and if something is already running it
  asks:

  - **your own earlier trace** — *"Your last trace is still running on the server (started 12s ago).
    It will finish whether or not you wait…"*. This is the common case, because a reload is what
    produces it. On load the page also just **shows** that walk running, rather than waiting to
    complain about it;
  - **another user's** — *"Another user (Name) is running a cell trace, started 12s ago. Running two
    at once increases the server's memory use and slows both."*

  Both end in a choice rather than a block. Two things worth knowing about what it can and cannot
  tell you: **it never claims the server is quiet**, because TM1 shows an administrator every thread
  and everybody else only their own, so nothing seen is not the same as nothing running; and if the
  thread list cannot be read at all, **tracing carries on exactly as before** — the guard fails open,
  because a permissions difference must not become an outage. The repeating drill actions do not ask
  per hop; they ask once, up front, as above.

- **Row paging depends on the session keeping the cellset alive.** When it does, the grid pages
  through the row axis properly. When it does not, the plugin falls back to one capped request and
  tells you how many rows and columns it is showing — narrow the view or use MDX to reach the rest.
- **Very wide consolidations are capped** at 250 components per node, a trace at 20,000 nodes and
  the rendered tree at 800 rows. Every cap reports itself — see the table above.
- **A `DB( )` lookup that no single component identifies is left verbatim.** It binds only when
  exactly one unused component is in the target cube, has one element per coordinate argument, and
  agrees with every argument the rule spells out — so two lookups the text cannot tell apart keep
  their `!dimension` references. That is deliberate: see *A `DB( )` lookup shows the coordinates TM1
  actually read*.
- **When TM1 reports several candidate statements for a cell**, the first is used for the formula
  and the panel says how many there were. TM1 does not say which one actually fired. Statements that
  are provably not this cell's — they name a dimension the cube does not have, so they belong to its
  components — are set aside first and counted separately; among what is left, it is still the first.
- **Rule-file matching is textual.** It ignores whitespace and comments and is case-insensitive,
  so it copes with the API's collapsed statements, but a generated or macro-expanded rule may not
  be found — the trace still works, only the line number is missing.
- **A running trace can be cancelled, and only by an administrator** (§5e). The walkbar carries a
  `Cancel` for this page's own walk, and one line per walk the server reports, each with its own.
  It is `POST /Threads(<id>)/tm1.CancelOperation` — measured at **204 in ~1 s** on a depth-6 walk,
  after which the thread leaves `/Threads` and the waiting client returns
  `TM1UserException: Cancel` through the plugin's own error path.

  Four things about it are deliberate. The id is **re-checked against a fresh `/Threads` read**
  before the POST — the thread must still exist, still be a `tm1.TraceCellCalculation`, still be
  running, and still be yours unless you are an admin — so a stale row cannot become a cancel
  aimed at whatever holds that id now. **Two of your own walks means listing them, not guessing**
  which to kill. A **404 reads as "already finished"**, which is what a late cancel returns
  (measured at 8 ms). And a cancelled walk is **not** a failure: `cancelledByMe` plus a match on
  TM1's own `TM1UserException: Cancel` route it to a notice rather than the red box, the second
  being the only signal available on the page of the person whose trace an admin stopped.

  **Admin is `Type: "Admin"` or membership of `ADMIN`, and nothing else** — TM1's other
  administrative types have not been measured cancelling anything, and whether a **non-admin may
  cancel their own walk is not established** (§5e.2: it needs a granted non-admin account and
  that user's own session). The flag comes off the `/ActiveUser` read the walk guard already
  makes, widened to `$select=Name,Type&$expand=Groups($select=Name)`, with the narrow read as a
  fallback so that a server refusing the expansion costs the walk indicator nothing.

  **Cancelling hands no memory back** (§5a.7: TM1 keeps its pool at the high-water mark). It
  stops the walk and frees the client, and no string in the UI may suggest otherwise.
- **Feeder detail depends on the server.** `FedCells` are requested with their coordinates expanded
  and fall back to an un-expanded call if the server refuses. On that fallback a fed cell arrives
  as `{ "Fed": true }` and nothing else — measured — so those rows say they are unlabelled rather
  than printing the object.
- **Each fed cell carries the server's own `Fed` boolean**, and the list renders it as a tick. It
  arrives by default, because the request carries no top-level `$select` — the same structural-
  property behaviour that decides `Components` on a calculation trace. Three states, not two:
  `true` is fed, `false` is a cell a feeder statement names that nothing reaches (a rule value
  there reads as zero), and **anything else is *not reported*, which is never rendered as *not
  fed***. A row opens into one `dimension = element` line per member, paired with the cube's
  dimension names; a tuple whose length does not match that list keeps its elements in server
  order with no dimension claimed against them.

  Both the `false` and the *not reported* states are **unverified against a live server**: every
  fed cell GO_New_Stores answers is `Fed: true`, including one whose feeder's source cells are
  both empty (`Gross Margin Calculation`, `Existing Stores Revenue`, Direct Marketing / GO
  Accessories / Corporate Store / Sep) — so that model cannot produce a cross without being
  deliberately broken. Both branches are pinned by unit tests instead.
- **The *Feeder check* section reports a defect, so empty is the pass.** The two actions answer
  opposite questions: `tm1.TraceFeeders` is *what does this cell feed* (the statements whose source
  area covers it, and its fed cells), while `tm1.CheckFeeders` is the **underfeeding detector** — it
  lists rule-derived cells in scope that hold a value no feeder reaches. Rows mean numbers are
  wrong somewhere below; no rows means the check found nothing to report. Arc's own page does not
  call it at all, which is why this plugin does.

  Four things have to hold before it *can* list anything: `SKIPCHECK` in the cube's rules (without
  it feeders are ignored entirely and there is nothing to check); rule-derived cells in scope (a
  stored input or a pure consolidation has nothing to be fed); one of them non-zero and unfed —
  including the two cases that are easy to miss, a link rule whose feeder lives in the *source*
  cube, and a feeder whose own source cell is zero so it never fired; and a scan that fits
  `CheckFeedersMaximumCells` (3,000,000 by default), past which the server stops, so empty on a very
  wide area is not proof. Measured on GO_New_Stores: `{value: []}` for a rule-derived fed cell
  (`ADJUSTED GROSS REVENUE`) and for the consolidated §2.7 cell — expected, because that cube's
  rules and feeders are both autogenerated and therefore agree.
- **The first two sections belong to the cell that feeds.** They report what *this* cell feeds, so a
  cell that no feeder statement feeds **from** comes back empty in both — rule-derived or not. A
  rule-derived cell can perfectly well be a feeder source: `Existing Stores Revenue` in the demo
  model is calculated by a link rule *and* feeds `GROSS REVENUE`.
- **Element names containing a single quote** are escaped (doubled) as OData requires. Names
  containing a forward slash are not handled.
- No sandbox / "as of" support yet.

## About Plugins

Before going any further we recommend reading these two help articles:
* [How plugins work](https://code.cubewise.com/arc-docs/how-plugins-work)
* [How to create your plugins](https://code.cubewise.com/arc-docs/how-to-create-your-plugins)

## Contact

Questions, feedback and bug reports: Muhammad Eissa, Cubewise — [meissa@cubewise.com](mailto:meissa@cubewise.com).

## License

Released under the MIT License, copyright Cubewise: see `LICENSE` and `NOTICE` at the top of the
repository. IBM's trademarks and Bedrock are not covered by it.
