---
name: review-arc-plugin
description: Review an Arc plugin (a folder with a plugin.js) against current Arc before it is published to the Plugins Manager. Use when the user asks to review, audit, check or clean up a plugin, before opening a PR that adds or changes a plugin, or before cutting a release of this repo. Checks the manifest registration, $tm1 call shapes against the current $tm1.js, ngDialog versus $dialogs, console versus _logger, the close-tab handler, HTTP error handling, strings and theming, and the README. Reports findings with file and line; does not change code unless asked.
---

# Review an Arc plugin

Plugins in this repo teach people, and LLMs, how to write Arc plugins, so a stale pattern here gets copied. This skill finds those patterns and anything that would stop a plugin installing from the Plugins Manager.

## Inputs

- The plugin folder to review (one directory under the repo root, containing `plugin.js`). If the user names none, ask which; do not review the whole repo unasked.
- An Arc checkout, ideally at `../arc`. Several checks compare the plugin with Arc's own source. If there is no checkout, say which checks you could not run and mark those findings **unverified**; never guess a signature from memory.

## Rules for the review

- Read every file in the plugin folder before reporting: `plugin.js`, the HTML templates, the README.
- Report what you can point at: file and line, the rule it breaks, and the fix. Suggest; do not assert. A call shape is wrong only after you have read the current signature in Arc's source.
- Do not edit the plugin during the review. Offer the fixes afterwards, one plugin per commit.
- A plugin can be fine and still old. Do not flag style differences that do not change behaviour.

## Checks

### 1. Registration and manifest (blocker if broken)

The release builder runs `plugin.js` against a stub and reads the `$rootScope.plugin(name, label, type, options)` call. Check:

- The directory name matches `^[A-Za-z0-9][A-Za-z0-9_-]*$`.
- `plugin.js` has a `$rootScope.plugin(...)` call that is not commented out. A commented-out registration (as in `template-page`) is skipped from releases.
- `options` has `description`, `author`, `version`, `icon`, `url`, and `menu` for a page. These feed the manifest and the Plugins Manager list; a missing field becomes an empty string in `plugins.json`.
- The registered name is unique across the repo, and does not collide with a plugin built into Arc.
- Asset paths are the literal `__/plugins/<dir>/...`. A path built by string concatenation is not rewritten if Arc installs the plugin under a different directory.
- If an Arc checkout exists, run the real builder and confirm the plugin appears:
  `node <arc>/tools/arc-plugins-release/build-release.js --src . --only <dir> --out <scratch dir>`

### 2. `$tm1` call shapes (blocker if wrong)

For every `$tm1.<method>(` call, open `<arc>/server/assets/app/services/$tm1.js`, find the method, and compare the argument count and order. Known drift: `cellUpdate` is `(value, instance, cube, sandbox, ...elements)`; samples used to pass the first element where `sandbox` now goes. Fix by passing `null` for the sandbox. Check every method, not just that one.

### 3. Dialogs (should fix)

- No `ngDialog.open(...)` called from the plugin. Dialogs with a body (a form, a list, results) are registered once in an `arc.run([...])` with `$dialogs.registerDialog('<name>Dialog', { title, directive, icon, size, okButtonLabel, ... })` and opened with `$dialogs.showDialog(name, data, options, okHandler, cancelHandler)`. The body is a directive (`<Name>Form` or `<Name>Page`) whose scope has `data: "=arcModelData"`, `options: "=arcOptions"`, `dialog: "=arcDialog"`.
- A message, an error or one input uses `$dialogs.alert`, `$dialogs.error`, `$dialogs.errorDetail` or `$dialogs.input` instead of a custom dialog.
- Returning a truthy value from the OK handler keeps the dialog open, for dialogs that show results.
- The plugin no longer injects `ngDialog` once nothing uses it.

### 4. Logging (should fix)

No `console.log`, `console.warn` or `console.error`. Use `var _logger = log.getLogger('<PluginName>');` and `_logger.info`, `.warn`, `.error` or `.debug`. Leftover commented-out `console.log` lines are dead code; delete them.

`log` is a global in Arc, not an Angular service. Do not add `"log"` to a controller's injection list: Angular fails with an unknown provider and the plugin does not load.

### 5. Page plugins need a `close-tab` handler (blocker for a page)

A plugin of type `page` must handle `close-tab`, or its tab cannot be closed:

```js
$scope.$on("close-tab", function (event, args) {
  if (args.page == "<registeredName>" && args.instance == $scope.instance) {
    $rootScope.close(args.page, args);
  }
});
```

Forward `args` unchanged. Check the registered name in the handler matches the one in the registration.

### 6. HTTP results (should fix)

Arc's HTTP interceptor lets error statuses resolve into `.then`, so `.then` does not mean success. Look at `result.status` before using `result.data`, and do not show a success message unconditionally.

### 7. Strings and theming (nice to have)

- Prefer Arc translation keys that already exist (`translate="DELETE"`, `translate="CANCEL"`) over hard-coded English for common words. Plugin-specific text may stay in plain English.
- No hard-coded colours or `style=` attributes where an Arc/Bootstrap theme class exists; hard-coded colours break dark mode.

### 8. Documentation (should fix)

The plugin has a `README.md` that says what it does, which Arc features or permissions it needs, and any settings. Check that it matches the plugin's current behaviour.

## Report

Reply with a short table, worst first:

| # | Severity | File:line | Rule | Fix |
|---|---|---|---|---|

Severity is **Blocker** (won't install, won't close, or wrong call), **Should fix** (stale pattern), or **Nice**. Then one line: pass, pass with fixes, or do not publish, and the list of checks you could not run. Offer to apply the fixes, one commit per plugin.
