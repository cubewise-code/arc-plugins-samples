---
name: arc-plugin-dev
description: >-
  Build, debug, and extend plugins for Arc (Cubewise), the AngularJS-based IDE
  for IBM Planning Analytics / TM1. Use when creating a new Arc plugin, adding
  TM1 REST API calls, calling the Pulse API through Arc's /_pulse proxy (change
  tracking, locking, Test Hub, monitoring and usage history), writing MDX
  queries, handling cell writes, building dialogs with $dialogs, or diagnosing
  Arc-specific async/promise behaviour.
  For checking a finished plugin before publishing, use review-arc-plugin.
---

# Arc Plugin Development

Arc is an AngularJS-based IDE for IBM Planning Analytics (TM1). Plugins extend
it with custom pages or context-menu actions.

Plugins in this repo are copied by people and by LLMs, so write them the way
`review-arc-plugin` checks them: `$dialogs` not `ngDialog`, `_logger` not
`console`, a `close-tab` handler on every page, and `result.status` checked
before `result.data` is used. When this skill and `review-arc-plugin` disagree,
`review-arc-plugin` wins; fix this file.

Working examples in this repo:
- Page plugin: `randomise-data`, `rest-api-sanity-check`, `cheatsheet`
- Menu plugin with a form dialog: `bedrock-cube-data-export`
- `_logger`: `randomise-data`
- `$tm1.cellUpdate` with a sandbox argument: `cheatsheet`
- Content in an editable data file, a control cube created on first use, a helper TI
  process, keyboard shortcuts: `academy`
- Pulse API calls through Arc's proxy, a search box across all columns: `pulse-api-sanity-check`
- Pulse workbook data and object relationships, an SVG diagram with Arc's icons: `workbook-flow-diagram`

## Plugin File Structure

Each plugin lives in its own folder:

```
my-plugin/
  plugin.js          # AngularJS registration + logic
  template.html      # HTML template (page plugins and dialog forms)
  translate-en.json  # i18n key-value pairs
  README.md          # what it does, what it needs, settings
```

The folder name must match `^[A-Za-z0-9][A-Za-z0-9_-]*$`.

## Plugin Types

### 1. Page Plugin (opens as a new tab)

Register with `"page"` and provide a `menu` option. Implement as an `arc.directive`:

```js
arc.run(['$rootScope', function ($rootScope) {
  $rootScope.plugin("myPluginId", "My Plugin", "page", {
    menu: "tools",          // menu group: "tools", "data", etc.
    icon: "fa-plug",        // Font Awesome icon class
    description: "What this plugin does",
    author: "Your Name",
    url: "https://...",
    version: "1.0.0"
  });
}]);

arc.directive("myPluginId", function () {
  return {
    restrict: "EA",
    replace: true,
    scope: { instance: "=tm1Instance" },
    templateUrl: "__/plugins/my-plugin/template.html",
    controller: ["$scope", "$rootScope", "$http", "$tm1", "$translate", "$timeout",
      function ($scope, $rootScope, $http, $tm1, $translate, $timeout) {

        // `log` is a global, do not inject it
        var _logger = log.getLogger("MyPlugin");

        // Close tab handler: required, or the tab cannot be closed.
        // Use the registered id, and pass args on unchanged.
        $scope.$on("close-tab", function (event, args) {
          if (args.page == "myPluginId" && args.instance == $scope.instance) {
            $rootScope.close(args.page, args);
          }
        });

        $scope.$on("login-reload", function (event, args) { /* re-init on login */ });
        $scope.$on("$destroy", function (event) { /* cleanup */ });
      }]
  };
});
```

**A long page needs its own scroller.** Arc puts a page in a tab panel of fixed
height inside a box with `overflow: hidden`, so content taller than the tab is cut
off with no scrollbar. Give the template's root element
`height: 100%; overflow-y: auto;` (as `academy` does).

All of `description`, `author`, `version`, `icon`, `url` (and `menu` for a page)
feed the Plugins Manager list; a missing one shows as empty. Do not comment out
the `$rootScope.plugin(...)` call: the release builder skips a plugin without one.

### 2. Menu Plugin (context-menu action on a TM1 object)

Register with a `"menu/<objectType>"` type. Implement as an `arc.service` with an `execute` method:

```js
arc.run(['$rootScope', function ($rootScope) {
  $rootScope.plugin("myMenuPlugin", "Action Label", "menu/cube", {
    icon: "fa-bolt",
    description: "Action description",
    author: "Your Name",
    url: "https://...",
    version: "1.0.0"
  });
}]);

arc.service('myMenuPlugin', ['$rootScope', '$tm1', '$dialogs', 'Notification',
  function ($rootScope, $tm1, $dialogs, Notification) {
    this.execute = function (instance, name, branch) {
      // instance = TM1 server name, name = object name, branch = tree node
    };
  }
]);
```

Available `menu/` object types: `cube`, `process`, `dimension`, `chore`, `subsets`, `views`, `hierarchy`.

## Key AngularJS Services

| Service | Purpose |
|---------|---------|
| `$tm1` | TM1 REST API calls: `$tm1.async(instance, method, url, body)`, `$tm1.processExecute(instance, name, params)`, `$tm1.choreExecute(instance, name)`, `$tm1.instances()`, `$tm1.instance(name)`, `$tm1.cubeDimensions(instance, cube)`, `$tm1.cellUpdate(value, instance, cube, sandbox, ...elementNames)`. All return promises. Pass `null` as `sandbox` to write to base data. Before relying on any other signature, read it in Arc's `server/assets/app/services/$tm1.js`. |
| `$dialogs` | Arc dialogs: `registerDialog`, `showDialog`, and the one-liners `alert`, `error`, `errorDetail`, `input`, `confirm`. See **Dialogs** below. |
| `$rootScope` | Global state; `$rootScope.uiPrefs` for persisted preferences (e.g. `uiPrefs.controlObjects`: show/hide TM1 control objects); `$rootScope.reloadInstance(instance)` refreshes the tree. |
| `$http` | For raw REST/OData calls not covered by `$tm1`: `encodeURIComponent(instance) + "/<ODataPath>"`, e.g. `$http.get(encodeURIComponent(instance) + "/Cubes/$count")`, `.../Configuration/ProductVersion/$value`. For MDX: `$http.post(encodeURIComponent(instance) + "/ExecuteMDX?$expand=Cells", { MDX: mdxQuery })`, read via `result.data.Cells[0].Value`. |
| `$translate` | i18n: `$translate.instant("MY_KEY")` (key must be in `translate-en.json`) |
| `$timeout` | Delayed execution |
| `$q` | Promises, e.g. `$q.all([...])`. Inject it when you use it. |
| `$subsetDialogs` | TM1 subset/element editor: `$subsetDialogs.open(instance, dimension, hierarchyName, subsetObject, handler)`, where `subsetObject` is `{ name, expression, expressions, alias, isSelector }` and `handler(subset, elements)` fires on selection with `subset.selected` holding the clicked element. See `bedrock-cube-data-export`. |
| `$helper` | Misc utilities, e.g. `$helper.escapeName(str)` to sanitize a name before embedding it in MDX |
| `Notification` | Toasts: `Notification.success({title, message})`, `.error(...)` |

`log` and `_` (lodash) are globals, not services: do not add them to an injection
list, or Angular fails with an unknown provider and the plugin does not load.

## Logging

No `console.log` / `console.warn` / `console.error`. Use Arc's logger:

```js
var _logger = log.getLogger("MyPlugin");
_logger.info("Loaded", count);
_logger.error("Load failed", result.status);
```

## Plugin ID Rules

- Use **camelCase** (e.g. `myNewPlugin`, `tm1RestApiQuery`)
- Must be **unique** across all installed plugins, including those built into Arc
- The same ID is used in: `arc.run` registration, `arc.directive`/`arc.service` name, and the `close-tab` handler

## Asset Path Convention

Always write the literal `__/plugins/<folder-name>/<file>.html` path, for
`templateUrl` and for any other asset. Do not build the path by string
concatenation: Arc rewrites the literal when it installs the plugin under a
different folder, and a concatenated path is missed.

```js
templateUrl: "__/plugins/my-plugin/template.html"
```

## translate-en.json

Keys used in templates via `{{ 'MY_KEY' | translate }}` or in JS via `$translate.instant("MY_KEY")`.
Prefer Arc's existing keys for common words (`translate="CANCEL"`, `translate="DELETE"`).

```json
{
  "SUBMIT": "Submit",
  "RESULT": "Result"
}
```

## Verifying a Deployed Change

"I applied the fix but it still doesn't work" is very often "the deployed copy
doesn't match the source yet" (stale copy, missed file, or browser-cached JS)
rather than a bug in the fix. To tell them apart:

- Keep the plugin's `version` option in `$rootScope.plugin(...)` (or a
  `*_META.version` constant passed into it) and bump it on every change.
- After redeploying and hard-refreshing the browser, confirm the live version in
  Arc's Plugins Manager, or by typing the meta object's name in the browser console.
- If behaviour is unchanged once the new version is confirmed live, treat it as a
  real logic bug and keep debugging the code; stop guessing at deployment.

### How Arc picks up plugin files (seen on Arc 6.1)

- **Find the folder Arc really reads.** The running Arc loads plugins from the
  `plugins` folder next to its own `.exe`, which is often not this repo. Check the
  running process's path (e.g. PowerShell `Get-CimInstance Win32_Process -Filter
  "Name like 'arc%'"`), then copy the plugin folder into that `plugins` folder and
  add it to that folder's `plugins.yml` (`<dir>: enabled: true`).
- **Copy, do not link.** Arc skips a junction or symlink in its `plugins` folder:
  the files are served, but the plugin is never registered.
- **A new plugin needs one Arc restart.** Arc builds its plugin list
  (`/_api/plugins/installed`) and the combined `__/plugins__v<hash>.js` bundle at
  startup. Clearing the browser cache does not add a new plugin.
- **After that, a refresh is enough.** Arc rebuilds the bundle (new hash) when a
  known plugin's files change. Templates and data files are fetched as they are.
- **The browser caches Arc's index page**, so a refresh can keep the old bundle
  hash. `/?anything` is refused (403); from the page's console run
  `await fetch('/', {cache: 'reload'}); location.reload()`, or clear the cache.
- **Check it loaded** from the console: `angular.element(document.body).injector().has('<id>Directive')`
  for a page, or look for the plugin in `/_api/plugins/installed`.
- A page plugin with `menu: "tools"` appears under an instance's **Tools** node,
  so sign in to an instance first.
- To inspect a page's state from the console: `angular.element(document.querySelector('.<root-class>')).isolateScope()`
  (`.scope()` returns the parent scope, because the directive has an isolate scope).

---

## Dialogs: $dialogs, Not ngDialog

Do not call `ngDialog.open(...)` from a plugin, and do not inject `ngDialog`.

### One message, error, confirmation or input

```js
// Shapes as used in rest-api-sanity-check and cheatsheet
$dialogs.error("Cube not found", "Pick a cube that exists on this instance.", "medium");
$dialogs.confirm("Delete the test dimension?", function () { /* on yes */ });
```

`$dialogs.alert`, `.errorDetail` and `.input` also exist; read their arguments in
Arc's `$dialogs` service before using them.

### A dialog with a body (a form, a list, results)

Register it once, give it a form directive, then open it with data. This is the
pattern in `bedrock-cube-data-export`, `randomise-data` and `process-feeders`:

```js
// 1. Register once
arc.run(["$dialogs", function ($dialogs) {
  $dialogs.registerDialog("myPluginExportDialog", {
    title: "Export data",
    directive: "myPluginExportForm",
    icon: "fa-download",
    size: "large",
    okButtonLabel: "OK",
    okButtonDisabled: function (data, options) {
      return !data.fileName;
    }
  });
}]);

// 2. The body: a directive with these three scope bindings
arc.directive("myPluginExportForm", function () {
  return {
    restrict: "EA",
    replace: true,
    scope: {
      data: "=arcModelData",
      options: "=arcOptions",
      dialog: "=arcDialog"
    },
    templateUrl: "__/plugins/my-plugin/m-export.html",
    controller: ["$scope", function ($scope) { /* $scope.data is the model */ }]
  };
});

// 3. Open it
$dialogs.showDialog("myPluginExportDialog", data, { title: "Export " + name },
  function okHandler(result) {
    run(result.data);
    // return true to keep the dialog open, e.g. to show results in it
  },
  function cancelHandler() { });
```

In the form template, bind through `data.x` (`ng-model="data.fileName"`), which
also satisfies the dot rule below.

### Button template requirements

Add `type="button"` to buttons inside a form, or the default submit swallows the click:

```html
<button type="button" class="btn btn-primary" ng-click="doAction()"
        ng-disabled="running || !data.requiredField">
    Go
</button>
```

### Loading data for a dialog

Open the dialog after the data it needs has arrived (as `bedrock-cube-data-export`
does), or set `data.loading = true`, open it, and fill `data` when the call
returns, so the form shows a spinner meanwhile.

---

## TM1 REST API via $tm1.async

Use one helper with one signature throughout a plugin:

```js
// OData string key: double any apostrophe in the name.
// Spaces and other characters are fine; do not URL-encode the name.
var odataKey = function (name) {
    return String(name).replace(/'/g, "''");
};

var api = function (instance, method, url, body) {
    return $tm1.async(
        instance,               // $scope.instance, or the `instance` arg from execute()
        method,                 // 'GET' | 'POST' | 'PATCH' | 'DELETE'
        url,                    // path relative to /api/v1/, e.g. "/Cubes('" + odataKey(cube) + "')"
        body !== undefined && body !== null ? JSON.stringify(body) : null
    );
};
```

The plugins in this repo pass the body as a string (`rest-api-query`,
`rest-api-sanity-check`). Whether `$tm1.async` also accepts an object is not
verified; stringify to be safe.

Key response facts:
- Arc's HTTP interceptor lets error statuses resolve into `.then`, so `.then` is
  not success. Check `r.status` before using `r.data`, and do not show a success
  message unconditionally.
- `POST /ExecuteMDX` returns **201** (Created), not 200: check `r.status === 200 || r.status === 201`.
- Arc runs these calls through TM1's async mode (`202`, then a poll of `_async(...)`),
  and the final status can differ from the direct call: `POST .../tm1.Compile`
  came back **201** in Arc 6.1. Accept 200 and 201 for actions that return a body.
- A `GET` of a missing object resolves with `r.status === 404`, so
  `r.status === 200` is a reliable existence check.
- `GET` resolves with `r.data.value` (OData collection) or `r.data` (single entity).
- Each call costs a round trip plus the async poll. Run independent calls together
  with `$q.all` (e.g. existence checks for several objects): in `academy` this cut
  page start from about 5.5 s to 1.5 s.

---

## Writes Don't Validate TI/Rule Syntax: Use tm1.Compile to Check

`PATCH`/`POST` to `/Processes('name')` (PrologProcedure, etc.) or a cube's `Rules`
**succeeds even if the text is syntactically broken**. TM1 only fails at
execution time. A plugin that writes generated or merged TI/rule text can
silently corrupt a process this way: it saves fine but won't run.

Check syntax without executing, on an object already saved on the server:

```js
api(instance, 'POST', "/Processes('" + odataKey(name) + "')/tm1.Compile", {})
    .then(function (r) {
        // r.data.value is an array of syntax errors; [] means it compiles cleanly.
        var errors = (r.status === 200 && r.data && r.data.value) || null;
    });
```

To validate text that hasn't been saved yet, POST the process body to
`/CompileProcess` (`{"Process": {...}}`), which returns the same shape.

If a plugin compares or migrates process or rule text between instances, run this
check on both sides first and block with a clear message if either side is already
broken.

---

## Diffing/Merging TI or Rule Text: Statements Span Multiple Lines

TI statements and TM1 rules end with `;`, not with the newline. One logical
statement routinely spans several physical lines:

```
nRetCode =
    ExecuteProcess('Some.Process');
```

In a line-level diff/merge tool, **never treat each physical line as an
independently selectable unit**: applying one line of a statement without its
continuation produces broken text, which (see above) still saves and only fails
at run time.

Group physical lines into logical units first: start a unit at any non-comment,
non-blank line, and extend it until a line ends with `;`. Diff, hunk and apply at
the unit level.

---

## MDX for Planning Analytics

Use **fully hierarchy-qualified** member references (`[Dim].[Hierarchy].[Member]`).
The short form `[Dim].[Member]` can fail on Planning Analytics, often without a
clear error.

```js
var mdx =
    'SELECT {[' + DIM_STATUS + '].[' + DIM_STATUS + '].[In Progress], ' +
          '[' + DIM_STATUS + '].[' + DIM_STATUS + '].[Owner]} ON COLUMNS, ' +
    'TM1SUBSETALL([' + DIM_OBJ + '].[' + DIM_OBJ + ']) ON ROWS ' +
    'FROM [' + CUBE + ']';
```

Escape names from user input with `$helper.escapeName` before embedding them.

`$expand` must drill through `Hierarchies`, otherwise `Members` is undefined:

```js
api(instance, 'POST', '/ExecuteMDX', {
    MDX: mdx,
    '$expand': 'Axes($expand=Hierarchies($expand=Members($select=Name))),Cells'
})
```

Extracting row/column members:

```js
var getAxisMembers = function (axis) {
    // PA nests under Hierarchies[0]; older TM1 exposes Members directly
    if (axis && axis.Hierarchies && axis.Hierarchies[0] && axis.Hierarchies[0].Members) {
        return axis.Hierarchies[0].Members;
    }
    return (axis && axis.Members) || [];
};
```

---

## TM1 Element Types

| API `Type` value | Meaning |
|---|---|
| 1 | Numeric (leaf) |
| 2 | String (leaf): use for cells that hold text |
| 3 | Consolidated (parent/rollup) |

These numbers are what this skill's author saw on their PA version. The REST API
can also return the type as a name (`"Numeric"`, `"String"`, `"Consolidated"`);
check what your instance returns before filtering on it.

Leaf elements only:

```js
"?$select=Name&$filter=Type ne 3"
```

Creating a dimension with a **string** element, required for any cube cell that stores text:

```js
Elements: [
    { Name: 'In Progress', Type: 1 },   // numeric
    { Name: 'Owner',       Type: 2 }    // string
]
```

---

## Cell Writes: When tm1.UpdateCells Fails, Use a TI Process

For single cells, `$tm1.cellUpdate(value, instance, cube, null, el1, el2, ...)` is
the simplest route (see `cheatsheet`).

`POST /Cubes(...)/tm1.UpdateCells` has been seen to return **400** ("Invalid key in
payload 'Cells'") on cubes that have a String element. `PATCH /Cellsets(...)` on an
ExecuteMDX cellset also returns 400: those cellsets are read-only.

Workaround: create a helper TI process once, then call it via `tm1.Execute`.
This creates a server object; name it as a control object and say so in the README.

```js
var PROCESS_NAME = '}MyPlugin.UpdateCells';

var createProcess = function (instance) {
    return api(instance, 'POST', '/Processes', {
        Name: PROCESS_NAME,
        Parameters: [
            { Name: 'pObject',   Prompt: 'Object', Type: 'String',  Value: '' },
            { Name: 'pNumValue', Prompt: 'Num',    Type: 'Numeric', Value: 0  },
            { Name: 'pStrValue', Prompt: 'Str',    Type: 'String',  Value: '' }
        ],
        PrologProcedure:
            "CellPutN( pNumValue, 'MyCube', pObject, 'NumericMember' );\r\n" +
            "CellPutS( pStrValue, 'MyCube', pObject, 'StringMember' );\r\n"
    });
};

var ensureProcess = function (instance) {
    return api(instance, 'GET', "/Processes('" + odataKey(PROCESS_NAME) + "')").then(function (r) {
        if (r.status === 200) { return; }
        return createProcess(instance);
    });
};

// Call during initialisation, before the user can interact.
```

Executing it:

```js
api(instance, 'POST', "/Processes('" + odataKey(PROCESS_NAME) + "')/tm1.Execute", {
    Parameters: [
        { Name: 'pObject',   Value: objectKey  },
        { Name: 'pNumValue', Value: 1          },
        { Name: 'pStrValue', Value: 'username' }
    ]
});
```

---

## Arc Async Promise Behaviour

For POST/PATCH, TM1 may answer `202 Accepted` with an async ticket that Arc polls.
If the ticket expires before Arc's first poll (fast writes), Arc **rejects** the
promise with `{}`, even though TM1 already committed the write.

So after a write, always read the true state back, whatever the write's promise
did. Use `['finally']` (bracket notation, because `finally` is reserved in older
JS engines):

```js
$scope.checkOut = function (obj) {
    if (obj.inProgress || obj.saving) { return; }
    obj.saving = true;
    updateCells(obj.objectKey, 1, currentUser)['finally'](function () {
        reloadData()['finally'](function () { obj.saving = false; });
    });
};

var reloadData = function () {
    $scope.rows = [];
    return loadData().then(parseData).catch(function (e) {
        _logger.error("Reload failed", e);
    });
};
```

---

## Using Native JS Functions in Templates

Templates can only call what is on `$scope`. To use a global such as
`encodeURIComponent` in a binding, put it on the scope:

```js
$scope.encodeURIComponent = encodeURIComponent;
```

---

## A "Disabled" Button May Be CSS, Not ng-disabled

If a button ignores clicks while its own `ng-disabled` is `false`, look for an
**ancestor** whose class is toggled by another condition and whose CSS sets
`pointer-events: none` (often with a dimmed `opacity`):

```html
<div ng-class="{'actions-not-ready': sections.length === 0}">
    <button ng-disabled="someOtherCondition">...</button>
</div>
```

```css
.actions-not-ready .btn { opacity: 0.5; pointer-events: none; }
```

Check the ancestor chain's `ng-class` conditions and CSS, not just the button.

The reverse also happens: in Arc's theme a **disabled** `btn-outline-*` button is
drawn solid grey, so a column of buttons disabled "until you pick something" looks
broken. Keep them enabled and ignore the click in the handler instead.

---

## Data Files Users Can Edit (content outside the code)

Keep content that customers should change (questions, settings, lists) in a JSON
file next to `plugin.js`, and load it at runtime, as `rest-api-sanity-check` does
with `requests.json`:

```js
// Read as text and parse here: Angular's own parse error gives no useful message.
// The query string stops the browser serving an old copy after the file is edited.
$http.get("__/plugins/my-plugin/data.json?t=" + Date.now(), {
    transformResponse: function (text) { return text; }
}).then(function (r) {
    if (r.status !== 200) { return $q.reject("data.json could not be read (HTTP " + r.status + ")."); }
    try {
        return JSON.parse(String(r.data).replace(/^﻿/, ""));   // tolerate a BOM
    } catch (e) {
        // e.message names the position, e.g. "... at position 73 (line 6 column 7)"
        return $q.reject("data.json is not valid JSON: " + e.message);
    }
});
```

Show that message on the page with a "Try again" button that loads the file again:
a fixed file then works without an Arc restart. Check each entry and skip (and
`_logger.warn`) the invalid ones, rather than failing the whole page.

---

## Keyboard Shortcuts on a Page

`ng-keydown` on the page's root element misses most keys: after a click, focus
often goes back to `<body>`, outside the plugin. Listen on the document, act only
while this tab is the one shown, and never while the user types in a field:

```js
// inject "$document" and "$element"
var onKey = function (event) {
    if (!$element[0].offsetParent) { return; }                 // tab hidden
    var t = event.target || {}, tag = (t.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select" || t.isContentEditable) { return; }
    if (event.ctrlKey || event.altKey || event.metaKey) { return; }
    var used = false;
    $scope.$apply(function () { used = handleKey(event); });  // returns true if it used the key
    if (used) { event.preventDefault(); }                      // stops Enter also clicking a focused button
};
$document.on("keydown", onKey);
$scope.$on("$destroy", function () { $document.off("keydown", onKey); });
```

---

## Storing Per-User Data in a Control Cube

For data that should follow the user or be shared (progress, a leaderboard), see
`academy`:

- Create the objects on first use if missing: a measure dimension, a `}Name` cube
  over `}Clients` x that dimension, and a `}Name.Something` TI process for writes.
  Creating them needs an administrator; say so in the README, with the rights other
  groups need (READ on the cube to read, READ on the process to run it; this
  was not yet tested with a non-admin user).
- In the process, write the row of `TM1User()`, not a user name passed as a
  parameter, so nobody can write someone else's row.
- Read every row with one MDX query (`NON EMPTY` on the `}Clients` rows).
- If the objects cannot be created or read (no rights), fall back to
  `localStorage` (wrap it in `try`/`catch`) and tell the user, rather than failing.

---

## `ng-model` Inside `ng-if` Silently Breaks: The "Dot Rule"

`ng-if` (and `ng-repeat`, etc.) creates a **child scope**. `ng-model="bareVar"`
inside one writes to the child scope, so the controller never sees the value. No
console error; it looks like "my dropdown selection isn't seen" or "my filter box
does nothing."

```html
<!-- Bad: selectedCube lives on ng-if's child scope -->
<div ng-if="showPanel">
    <select ng-model="selectedCube" ng-options="c for c in cubes"></select>
</div>

<!-- Good: bind through an object property -->
<div ng-if="showPanel">
    <select ng-model="mdx.selectedCube" ng-options="c for c in cubes"></select>
</div>
```

Always bind `ng-model` through an object property (`form.x`, `data.x`), never a bare variable.

---

## Loading Cube Dimensions and Elements

Fetch the dimension list, then elements in parallel (inject `$q`):

```js
api(instance, 'GET', "/Cubes('" + odataKey(cubeName) + "')/Dimensions?$select=Name")
    .then(function (r) {
        if (r.status !== 200) { return []; }
        var dims = (r.data.value || []).map(function (d) {
            return { name: d.Name, elements: [], selected: {}, loading: true };
        });

        return $q.all(dims.map(function (dim) {
            var key = odataKey(dim.name);
            var url = "/Dimensions('" + key + "')/Hierarchies('" + key + "')/Elements?$select=Name";
            return api(instance, 'GET', url).then(function (er) {
                dim.loading  = false;
                dim.elements = er.status === 200
                    ? (er.data.value || []).map(function (e) { return e.Name; })
                    : [];
            }, function () { dim.loading = false; });
        })).then(function () { return dims; });
    });
```

---

## Element Attributes / Aliases: `Attributes` Is a Complex Type

`$expand=Attributes` fails with:

```
Expecting '/' after property of complex type in expand path.
```

`Attributes` on `Element` is a **complex-type** property, not a navigation
property, so `$expand` is invalid. Put it in `$select`:

```js
var key = odataKey(dim);
var url = "/Dimensions('" + key + "')/Hierarchies('" + key + "')/Elements?$select=Name,Attributes";
api(instance, 'GET', url).then(function (r) {
    if (r.status !== 200) { return; }
    r.data.value.forEach(function (el) {
        var caption = el.Attributes && el.Attributes['Caption'];
    });
});
```

Which attributes are **aliases** (for an alias picker):

```js
var url = "/Dimensions('" + key + "')/Hierarchies('" + key + "')/ElementAttributes?$select=Name,Type";
api(instance, 'GET', url).then(function (r) {
    if (r.status !== 200) { return; }
    var aliasNames = r.data.value
        .filter(function (a) { return a.Type === 'Alias'; })
        .map(function (a) { return a.Name; });
});
```

---

## pFilter String Format (Bedrock processes)

```
Version¦Forecast&Year Month¦FY2026+FY2027
```

- `¦` (`¦`, broken bar) separates the dimension name from its elements
- `+` separates elements within a dimension
- `&` separates dimension clauses
- Omit a dimension with no elements selected

These are Bedrock's default delimiters. The process takes them as parameters
(`pDimensionDelim`, `pElementStartDelim`, `pElementDelim`), and
`bedrock-cube-data-export` passes its own (`&&`, `::`, `++`). Build the filter
with the same delimiters you pass.

```js
var buildFilter = function (dimensions) {
    return dimensions
        .map(function (dim) {
            var sel = dim.elements.filter(function (e) { return dim.selected[e]; });
            return sel.length ? dim.name + '¦' + sel.join('+') : null;
        })
        .filter(Boolean)
        .join('&');
};
```

---

## Useful Snippets

**Get active user:**
```js
api(instance, 'GET', '/ActiveUser').then(function (r) {
    currentUser = r.status === 200 && r.data && r.data.Name;
});
```

**Check if an object exists (cube, process, dimension):**
```js
api(instance, 'GET', "/Cubes('" + odataKey(CUBE) + "')").then(function (r) {
    if (r.status === 200) { /* exists */ }
});
```

**Add elements to a dimension:**
```js
var key = odataKey(DIM);
var url = "/Dimensions('" + key + "')/Hierarchies('" + key + "')/Elements";
return $q.all(elementsToAdd.map(function (e) { return api(instance, 'POST', url, e); }));
```

---

## Calling Pulse from a Plugin

Read [pulse-api.md](pulse-api.md) before writing any Pulse call. It lists every Pulse
API call Arc makes, and the Pulse data calls (monitoring, history, usage, alerts),
with exact parameters, expected status and answer shapes, verified on Arc 6.1 and
Pulse 8.0.1. The short version:

- Call Arc's proxy with a relative URL and `$http`: `$http.get("_pulse/api/state/after")`.
  Not `$tm1`, and not the Pulse URL directly.
- Get the instance's Pulse names from `$pulse.serviceFromInstance($scope.instance)`
  (`serverName`, `serviceName`).
- Send `x-login-no-prompt: true` and `x-non-interactive: true`, or a 401 opens Arc's
  Pulse sign-in dialog or signs the user out.
- Check `r.status`, then `r.data.Failed`: Pulse reports many errors as 200 with
  `{"Failed": true, "Message": ...}`.
- Parameter names differ between calls (`servername` / `server-name`, `service` /
  `service-name`): copy them from the reference.
- To check a Pulse after an upgrade, run the `pulse-api-sanity-check` plugin.

---

## Before Publishing

Run the `review-arc-plugin` skill on the plugin folder.

## Keep This Skill Up To Date

When you discover something new about how Arc plugins work (undocumented API
behaviour, gotchas, quirks) or a better way of working on them, suggest adding it
here. Keep it consistent with `review-arc-plugin`.
