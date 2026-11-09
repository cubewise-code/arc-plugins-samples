/* ============================================================================
 * Calculation Explorer — Arc for TM1 plugin
 *
 * Traces a cell from a cube view down through every rule, consolidation and
 * cross-cube hop. Every node is labelled with its cube + coordinates, rule
 * statements are matched back to the cube's rule file (line number + the
 * comment above it), and the whole trace can be exported as a single
 * self-contained interactive HTML file.
 * ==========================================================================*/

/* The address as it was when this file was parsed -- the earliest moment there
 * is, and the only one that still has the query string. Arc re-navigates every
 * page-plugin state with `{instance}` alone, so `$state.params` is empty by the
 * time a page could read it, and even a `run` block is too late if Arc's own run
 * block navigates first (§2.12, measured). A link into a cell is read from here.
 *
 * Top level on purpose, and prefixed: Arc concatenates every plugin's plugin.js
 * into one bundle, so this is a global and must not collide with anyone else's.
 * camelCase rather than CALCEXPLORER_*, because that shape means "translate key"
 * in this plugin and the key-coverage test reads it as one. */
var calcExplorerHashAtLoad = (function () {
   try { return String(window.location.hash || ""); } catch (e) { return ""; }
}());

/* One run block, three registrations: the page under Tools, and the same menu
 * service under two menu locations. A separate plugin id for the menu so the
 * two never collide — Arc keys menu dispatch off the plugin name and resolves
 * it as a service, while the page is resolved as a directive.
 *
 * One version, in one place. It used to be repeated in each registration, which
 * is three places to forget; it now comes from calcExplorerCore, because the
 * About block on the first tab needs the same string and a factory is the only
 * thing a run block and a page controller can both reach. */
arc.run(['$rootScope', 'calcExplorerCore', function ($rootScope, core) {

   var NAME = "Calculation Explorer";
   var VERSION = core.VERSION;
   var AUTHOR = "Cubewise";
   var ICON = "fa-sitemap";

   /* `path` and `params` are read straight into the state Arc registers for a
    * page plugin -- read out of `$rootScope.plugin` in the running app:
    *
    *    var url = plugin.path;
    *    if (!url) { url = '/' + _.kebabCase(name minus "cubewise") + '/:instance'; }
    *    register({ name: name, url: url, params: plugin.params, ... });
    *
    * So `path` *replaces* the generated URL rather than extending it, and the
    * base has to be repeated verbatim or every existing link breaks. The cell
    * travels as **query** parameters, which are optional by construction, so
    * `/calculation-explorer/GO_New_Stores` keeps working exactly as before.
    *
    * `dynamic: true` means changing them does not tear the page down and build
    * it again: the directive watches for the change instead, which is what lets
    * a second Trace Calculation land in an already-open tab without churn. */
   $rootScope.plugin("cubewiseCalculationExplorer", NAME, "page", {
      menu: "tools",
      icon: ICON,
      description: "Follow a cell's value through every rule, consolidation and cross-cube hop, " +
         "with rule-file line numbers and an interactive HTML export.",
      author: AUTHOR,
      version: VERSION,
      path: "/calculation-explorer/:instance?cube&view&elements&depth",
      params: {
         cube: { value: null, dynamic: true },
         view: { value: null, dynamic: true },
         elements: { value: null, dynamic: true },
         depth: { value: null, dynamic: true }
      }
   });

   $rootScope.plugin("cubewiseCalculationExplorerMenu", NAME, "menu/cube", {
      icon: ICON,
      description: "Open Calculation Explorer on this cube.",
      author: AUTHOR,
      version: VERSION
   });

   $rootScope.plugin("cubewiseCalculationExplorerMenu", NAME, "menu/views", {
      icon: ICON,
      description: "Open Calculation Explorer on this view, ready to trace a cell.",
      author: AUTHOR,
      version: VERSION
   });

}]);

/* Carries the cube/view a context-menu click asked for over to the page.
 *
 * Arc generates the page's ui-router state as /calculation-explorer/:instance and
 * silently drops any other state parameter, so the selection cannot travel in
 * the URL. Both paths are covered: `take` serves the case where the tab is
 * being opened for the first time (the directive asks on init), and the
 * broadcast serves the case where the tab is already open (no state
 * transition happens, so the directive is never re-created). */
arc.factory("calcExplorerRequest", ['$rootScope', function ($rootScope) {

   var pending = null;

   return {
      set: function (request) {
         pending = request;
         $rootScope.$broadcast("calculation-explorer-request", request);
      },
      take: function (instance) {
         if (pending && pending.instance === instance) {
            var request = pending;
            pending = null;
            return request;
         }
         return null;
      },
      clear: function () { pending = null; }
   };

}]);

arc.service("cubewiseCalculationExplorerMenu", ['$state', 'calcExplorerRequest',
   function ($state, calcExplorerRequest) {

      /* Arc calls this as execute(instance, name, branch). For menu/cube,
       * `name` is the cube and branch.label is the same cube. For menu/views,
       * `name` is still the cube and branch.label is the view — which is how
       * one handler serves both locations. */
      this.execute = function (instance, name, branch) {
         var request = { instance: instance, cube: name, view: null };
         if (branch && branch.label && branch.label !== name) {
            request.view = branch.label;
         }
         calcExplorerRequest.set(request);
         $state.go("cubewiseCalculationExplorer", { instance: instance });
      };

   }]);

/* Take over Arc's built-in **Trace Calculation** and **Trace Feeders** (both on
 * the cube viewer's cell menu).
 *
 * Arc's cell context menu takes no plugins, and both are *core* ui-router
 * states — `/trace-calculation/:instance/:cube/:elements/:cellstatus` and
 * `/trace-feeders/:instance/:cube/:elements` (read out of the running app's
 * state registry, Arc 5.3.2207, and both unchanged in 6.0.0 — 2.14) —
 * registered by the app itself, not through
 * `$rootScope.plugin()`. So `$rootScope.pluginUpgrades` cannot replace either:
 * that table only rewrites *plugin* registrations, matched by plugin name.
 *
 * What is available is that Arc runs **ui-router 1.x**, and `$transitions` is
 * injectable from a plugin. Arc's menu still navigates exactly as it always
 * did; the transition is intercepted and redirected here, carrying the cell.
 *
 * The cell travels in `:elements` as one part per dimension, each part
 * `<dimension>:<element>` (or `<dimension>:<hierarchy>:<element>`) with each
 * side run through `encodeURIComponent` on its own, so spaces arrive as a
 * literal %20 — ui-router has already undone one layer of encoding by the time
 * a hook sees the parameter. Both menu entries build it identically; captured
 * from the running cube viewer, Trace Feeders on a Store Cost cell:
 *
 *   Country%20and%20Region:Americas,Retailers:Direct%20Marketing,...,DATA:DATA
 *
 * so one decoder serves both. Which tab opens is the only difference.
 *
 * Reversible, and independently: the two checkboxes under *Open Arc's cell menu
 * here* on the first tab hand either built-in page straight back, with no
 * reload. Which setting governs which state is the `pref` argument below. */
arc.run(['$rootScope', '$transitions', '$translate', 'Notification', 'calcExplorerRequest',
   'calcExplorerCore',
   function ($rootScope, $transitions, $translate, Notification, calcExplorerRequest, core) {

      var announced = {};

      var announce = function (state, key, fallback) {
         if (announced[state]) { return; }
         announced[state] = true;
         var title = $translate.instant("CALCEXPLORER_TITLE");
         var message = $translate.instant(key);
         Notification.success({
            title: typeof title === "string" ? title : "Calculation Explorer",
            message: typeof message === "string" ? message : fallback
         });
      };

      /* One body for both states, since the handover is identical: `wantFeeders`
       * decides whether the cell lands on the trace tab or the feeders tab, and
       * `pref` names which of the two settings governs this state. Read live and
       * resolved by the core, never captured -- see the v1.3.0 bug in the
       * directive below. */
      var takeOver = function (state, wantFeeders, pref, messageKey, fallbackMessage) {
         $transitions.onBefore({ to: state }, function (transition) {
            if (!core.takeoverSettings($rootScope.uiPrefs)[pref]) { return; }

            var params = transition.params() || {};
            if (!params.instance || !params.cube || !params.elements) { return; }

            calcExplorerRequest.set({
               instance: params.instance,
               cube: params.cube,
               view: null,
               elementsRaw: String(params.elements),
               // trace-feeders carries no :cellstatus — only trace-calculation does.
               cellStatus: params.cellstatus,
               wantFeeders: wantFeeders,
               source: state
            });

            announce(state, messageKey, fallbackMessage);

            return transition.router.stateService.target("cubewiseCalculationExplorer",
               { instance: params.instance });
         });
      };

      takeOver("trace-calculation", false, "calculation", "CALCEXPLORER_TOOKOVER",
         "Opened here instead of Arc's built-in trace.");
      takeOver("trace-feeders", true, "feeders", "CALCEXPLORER_TOOKOVERFEEDERS",
         "Opened here instead of Arc's built-in feeder trace.");

      /* A link into a cell, read out of the address *now* -- this runs while Arc
       * is bootstrapping, which is the only moment the query string is still
       * there. Arc re-navigates every page-plugin state with `{instance}` alone
       * before the page is created, so by the time the directive could ask
       * ui-router, `$state.params` is empty (§2.12, measured both ways).
       *
       * It goes through the same channel a context-menu click uses, so there is
       * one way in for the page to handle rather than two. */
      /* One request shape for both ways in, so a cold start and a link pasted
       * into a running Arc cannot drift apart. */
      var requestFor = function (found) {
         return {
            instance: found.instance,
            cube: found.cube,
            view: found.view,
            elementsRaw: found.elementsRaw,
            depth: found.depth,
            source: "url"
         };
      };

      var link = core.parseDeepLink(calcExplorerHashAtLoad);
      if (link) {
         calcExplorerRequest.set(requestFor(link));
      }

      /* And the same again for a link pasted into an Arc that is *already*
       * running. That is only a hash change, so the read above -- which happens
       * once, at file-parse time -- never sees it.
       *
       * MEASURED, and it is simpler than it looks (§2.12a): Arc's strip is a
       * **second** navigation cycle about 40ms after the first, not something
       * inside the first one's digest. So the first cycle's
       * $locationChangeSuccess still carries the whole query -- $location.search()
       * reads {cube: ..., view: ...} at that point -- and a listener registered
       * here, in a run block, is early enough. It was designed twice before it
       * was measured: once as a file-scope hashchange listener with a global
       * callback slot, once as a $transitions hook. Neither is needed. A late
       * hashchange listener *would* have been too late, which is what made the
       * file-scope version look necessary -- Angular's own hashchange handler
       * runs the digest that leads to the strip.
       *
       * The strip cycle fires this listener a second time with the query gone.
       * parseDeepLink declines anything without a cube, so that pass returns
       * null -- and forgetting appliedHash there is deliberate: it is what lets
       * the same link be pasted again later and still work, while the equality
       * check stops one address being applied twice in a row. */
      var appliedHash = calcExplorerHashAtLoad;
      $rootScope.$on("$locationChangeSuccess", function () {
         var hash = String(window.location.hash || "");
         var pasted = core.parseDeepLink(hash);
         if (!pasted) {
            appliedHash = null;
            return;
         }
         if (hash === appliedHash) { return; }
         appliedHash = hash;
         calcExplorerRequest.set(requestFor(pasted));
      });

   }]);

/* ----------------------------------------------------------------------------
 * calcExplorerCore — pure logic. No $http, no DOM, no Angular services, so it
 * can be unit tested under plain node (see tests/run-tests.js).
 * --------------------------------------------------------------------------*/
arc.factory("calcExplorerCore", [function () {

   var MAX_EXPAND_DEPTH = 12;

   /* How many rows the *Values used* list shows before it says how many more
    * there are. A rule has a handful of operands; a **consolidation** has one
    * per child, which is up to MAX_CHILDREN of them -- 250 rows at ~20px is
    * 5,000px of list above a tree box that is ~600px tall. The rest is not
    * lost: the tree directly below is those same children, with shares. */
   var VALUES_SHOWN = 12;

   /* The build, stated once. It lives here rather than in the run block that
    * registers the page because two things need it now -- those registrations
    * and the About block on the first tab -- and this factory is the only thing
    * they share. It cannot live at file scope: Arc concatenates every plugin's
    * plugin.js into one bundle, so a top-level `var VERSION` would be a global
    * with an obviously collidable name (README, "A page plugin can own its URL").
    *
    * ARC_BUILD is the Arc this release was verified against, not the Arc it is
    * running on. It is the half of a bug report that says whether the
    * measurements in PROJECT-PLAN.md 2 still apply, which is why it is worth
    * showing beside the version. Bump it when the verification is redone --
    * 5.3.2207 -> 6.0.0 on 2026-09-09, when it was (2.14 and 4p; the version
    * itself deliberately did not move, since v1.9.0 had not shipped yet).
    *
    * The Arc it is *running* on turns out to be readable, contrary to what this
    * comment claimed until that retest: Arc serves the running version in its
    * own index, as `<script src="__/plugins__v6.0.0.js">`, so
    * `document.querySelector('script[src*="plugins__v"]').src` yields it -- the
    * same fact the hard-reload snippet in README now relies on. Nothing here
    * compares the two on purpose: warning when the running Arc differs from
    * ARC_BUILD is 5 item 17, and it is a feature with a wording decision in it,
    * not something to bolt on while passing. */
   var VERSION = "1.19.1";
   var ARC_BUILD = "6.0.0";

   // ---------------------------------------------------------------
   // Small helpers
   // ---------------------------------------------------------------

   var repeat = function (text, times) {
      var out = "";
      for (var i = 0; i < times; i++) { out += text; }
      return out;
   };

   // Single quotes are doubled for OData string literals. Element names are
   // sent raw otherwise — that is what the server accepts inside a
   // Tuple@odata.bind path (verified live), unlike URL path segments which go
   // through Arc's $helper.encodeName.
   var odataQuote = function (name) {
      return String(name === null || name === undefined ? "" : name).replace(/'/g, "''");
   };

   var escapeHtml = function (text) {
      return String(text === null || text === undefined ? "" : text)
         .replace(/&/g, "&amp;")
         .replace(/</g, "&lt;")
         .replace(/>/g, "&gt;")
         .replace(/"/g, "&quot;")
         .replace(/'/g, "&#39;");
   };

   var formatNumber = function (value) {
      if (typeof value !== "number" || !isFinite(value)) { return String(value); }
      if (value === 0) { return "0"; }
      var abs = Math.abs(value);
      var decimals = abs >= 1000 ? 0 : (abs >= 1 ? 2 : 6);
      var rounded = Number(value.toFixed(decimals));
      var parts = String(rounded).split(".");
      parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
      return parts.join(".");
   };

   var formatValue = function (value) {
      if (value === null || value === undefined) { return "(empty)"; }
      if (typeof value === "number") { return formatNumber(value); }
      return String(value);
   };

   // ---------------------------------------------------------------
   // Member unique names:  [Dim].[Hier].[Element], ] escaped as ]]
   // ---------------------------------------------------------------

   var parseUniqueName = function (uniqueName) {
      var text = String(uniqueName || "");
      var parts = [];
      var i = 0;
      while (i < text.length) {
         if (text.charAt(i) !== "[") { i++; continue; }
         i++;
         var current = "";
         while (i < text.length) {
            if (text.charAt(i) === "]") {
               if (text.charAt(i + 1) === "]") { current += "]"; i += 2; continue; }
               i++;
               break;
            }
            current += text.charAt(i);
            i++;
         }
         parts.push(current);
      }
      if (!parts.length) { return null; }
      if (parts.length === 1) {
         return { dimension: parts[0], hierarchy: parts[0], element: parts[0] };
      }
      return {
         dimension: parts[0],
         hierarchy: parts.length > 2 ? parts[1] : parts[0],
         element: parts[parts.length - 1]
      };
   };

   // ---------------------------------------------------------------
   // Cellset coordinate maths. Axis 0 varies fastest:
   //   ordinal = i0 + card0 * (i1 + card1 * i2 ...)
   // ---------------------------------------------------------------

   var cellIndices = function (cardinalities, ordinal) {
      var indices = [];
      var rest = ordinal;
      for (var i = 0; i < cardinalities.length; i++) {
         var card = cardinalities[i] || 1;
         indices.push(rest % card);
         rest = Math.floor(rest / card);
      }
      return indices;
   };

   var cellOrdinal = function (cardinalities, indices) {
      var ordinal = 0;
      var stride = 1;
      for (var i = 0; i < cardinalities.length; i++) {
         ordinal += (indices[i] || 0) * stride;
         stride *= (cardinalities[i] || 1);
      }
      return ordinal;
   };

   // members: flat list of {dimension, hierarchy, element} gathered off every
   // axis. Returns them ordered the way the cube expects them.
   var orderCoordinates = function (cubeDimensions, members) {
      var byDimension = {};
      var i;
      for (i = 0; i < members.length; i++) {
         if (members[i]) { byDimension[String(members[i].dimension).toUpperCase()] = members[i]; }
      }
      var coordinates = [];
      var missing = [];
      for (i = 0; i < cubeDimensions.length; i++) {
         var name = cubeDimensions[i];
         var found = byDimension[String(name).toUpperCase()];
         if (found) {
            coordinates.push({
               dimension: name,
               hierarchy: found.hierarchy || name,
               element: found.element
            });
         } else {
            missing.push(name);
         }
      }
      return { ok: missing.length === 0, coordinates: coordinates, missing: missing };
   };

   // ---------------------------------------------------------------
   // Trace request building
   // ---------------------------------------------------------------

   var buildTupleBind = function (coordinates) {
      var binds = [];
      for (var i = 0; i < coordinates.length; i++) {
         var c = coordinates[i];
         binds.push("Dimensions('" + odataQuote(c.dimension) +
            "')/Hierarchies('" + odataQuote(c.hierarchy || c.dimension) +
            "')/Elements('" + odataQuote(c.element) + "')");
      }
      return binds;
   };

   // Tuple/Cube are navigation properties on CalculationComponent and are not
   // returned unless expanded. An $expand path may not END on Components
   // (a complex type), so every level is requested as Components/.../Tuple.
   //
   // Hierarchy/Dimension are expanded off each member as well: a trace can
   // land on an alternate hierarchy (an element only reachable through, say,
   // a YTD hierarchy), and re-tracing from that node needs the hierarchy it
   // actually used, not the dimension's primary one.
   var MEMBER_EXPAND = "Tuple($select=Name;$expand=Hierarchy($select=Name;$expand=Dimension($select=Name)))";

   var buildTraceExpand = function (depth) {
      var levels = Math.max(0, Math.min(MAX_EXPAND_DEPTH, depth || 0));
      var parts = [];
      var prefix = "";
      for (var d = 0; d <= levels; d++) {
         parts.push(prefix + MEMBER_EXPAND);
         parts.push(prefix + "Cube($select=Name)");
         prefix += "Components/";
      }
      return parts.join(",");
   };

   /* **The bound §5a.4 recorded as non-existent, and §5a.11 measured.**
    * `Components` is a *structural* property of a complex type, so the default
    * projection includes it -- recursively, all the way down the closure. That
    * is why a request with **no query options at all** cost the same 133 MB and
    * 18 s as the plugin's four-level expand (§5a.7 run 3), and why the
    * conclusion drawn from it -- that any caller pays the same price -- was
    * wrong: "no options" is the MAXIMUM projection, not the minimum.
    *
    * A top-level `$select` naming `Components/...` **paths** bounds the walk to
    * exactly the depth named. `$top`, `$levels` and a nested `$select` inside
    * `$expand` are all still HTTP 400 (§5a.7); those were the wrong spelling,
    * and the 400's own message -- "Expecting '/' after property of complex type
    * in expand path" -- was pointing at this one the whole time. Arc's own
    * built-in Trace Calculation has been sending it all along, which is why
    * that page costs +0.7 MB where this one cost +437 MB.
    *
    * Measured on the §2.7 cell, same session, minutes apart:
    *
    *    without this   19,183 ms   132,926,596 bytes   +437 MB resident
    *    with it         1,043 ms        83,191 bytes      0 MB
    *
    * -- same root value, same labels, and the same 115 nodes the page actually
    * draws at depth 3.
    *
    * **The two depths must match, and that is the invariant here.** Cut the
    * `$select` deeper than the `$expand` and the frontier arrives with no
    * `Tuple`/`Cube`, so `node.resolved` is false, `hasDeeperLevel` is false,
    * and the frontier silently loses the `+` that would fetch the next level.
    * Cut it shallower and the label levels are paid for and thrown away. At
    * equal depths, measured: every node at every depth carried `Tuple` and
    * `Cube`, `unresolvedCount` came out 0, and all 96 frontier nodes reported
    * `hasDeeperLevel`. So one argument feeds both halves, and a test pins it.
    *
    * `Status` is asked for only at the top level, deliberately: it is stored
    * and never read anywhere in this plugin, so paying for it per level would
    * be lengthening a query string for nothing. */
   var buildTraceSelect = function (depth) {
      var levels = Math.max(0, Math.min(MAX_EXPAND_DEPTH, depth || 0));
      var parts = ["Value", "Statements", "Type", "Status"];
      var prefix = "";
      for (var d = 1; d <= levels; d++) {
         prefix += "Components/";
         parts.push(prefix + "Value");
         parts.push(prefix + "Statements");
         parts.push(prefix + "Type");
      }
      return parts.join(",");
   };

   var buildTraceQuery = function (depth) {
      return "$select=" + buildTraceSelect(depth) +
         "&$expand=" + buildTraceExpand(depth);
   };
   /* **The cheap half of a trace, and the reason Stage 2 exists.** §5a.7
    * measured it: the server does not build the component closure unless the
    * closure is asked for. `$select=Value` on the cell whose full walk costs
    * 18.4 s, 133 MB of payload and 416 MB of server memory came back in
    * **14 ms and 97 bytes**; adding the statements, the type, the status, the
    * coordinate and the cube keeps it **under 1 KB and under 60 ms**.
    *
    * So this asks the same action about the same cell and gets the value
    * *and the rule* -- everything a reader needs in order to decide whether
    * the tree is worth paying for -- without paying for it. The tree is then
    * the second, explicit step (`buildTree`).
    *
    * **`Components` must never appear in this query.** Naming it is what
    * makes the server walk, and §5a.7 measured that asking for it with *no
    * query options at all* costs the same as the full four-level expand -- so
    * there is no cheap way to ask for a little of it. A test pins the absence
    * of that word, because the failure would be silent: the preview would
    * still render perfectly, having quietly cost 416 MB. */
   var buildPreviewQuery = function () {
      return "$select=Value,Statements,Type,Status&$expand=" +
         MEMBER_EXPAND + ",Cube($select=Name)";
   };

   // ---------------------------------------------------------------
   // Rule statements
   // ---------------------------------------------------------------

   /* Collapse runs of whitespace to a single space -- **outside string literals
    * only**, which is the half a blanket collapse got wrong (§5d item 36).
    *
    * TM1 permits consecutive spaces in an element name and the demo model has
    * one: `Effect of  Single Retailer Promotions`, two spaces after "of". A
    * blanket collapse rewrote that name inside the rule text, so the operand
    * label came out a space short of the element it names, `findChild`'s exact
    * compare could never bind it, and the panel printed `?` for a component TM1
    * had reported at **29** -- while its own *Values used* row four lines below
    * printed that 29. HTML collapses the double space too, so nothing on screen
    * could show the difference: the label was right and the compare was wrong.
    *
    * Whitespace *between* tokens still collapses. The API returns statements
    * with the newlines stripped and the indentation left in, and that is noise.
    *
    * An unterminated literal keeps the rest of the text verbatim rather than
    * collapsing it, which is the same direction `ownStatements` chose: the worst
    * case on a malformed statement is today's output, not a worse one. */
   var collapseOutsideStrings = function (raw) {
      var text = String(raw === null || raw === undefined ? "" : raw);
      var out = "";
      var inString = false;
      var pending = false;
      for (var i = 0; i < text.length; i++) {
         var c = text.charAt(i);
         if (inString) {
            out += c;
            if (c === "'") {
               // '' inside a name is an escaped quote, not the end of the name.
               if (text.charAt(i + 1) === "'") { out += "'"; i++; continue; }
               inString = false;
            }
            continue;
         }
         if (/\s/.test(c)) {
            /* Held rather than written, so a leading run never opens the string
             * and a trailing one never closes it -- the result needs no trim(). */
            pending = out.length > 0;
            continue;
         }
         if (pending) { out += " "; pending = false; }
         if (c === "'") { inString = true; }
         out += c;
      }
      return out;
   };

   // The API returns statements with all newlines stripped, which is close to
   // unreadable for anything with nested IF()s. Re-indent on parens/commas,
   // leaving string literals alone -- which as of §5d item 36 is true of the
   // collapse on the first line as well as of the loop below it.
   var formatStatement = function (raw) {
      var text = collapseOutsideStrings(raw);
      if (text.length <= 90) { return text; }
      var out = "";
      var depth = 0;
      var inString = false;
      var indent = function (level) { return "\n" + repeat("   ", Math.max(0, level)); };
      for (var i = 0; i < text.length; i++) {
         var c = text.charAt(i);
         if (inString) {
            out += c;
            if (c === "'") {
               if (text.charAt(i + 1) === "'") { out += "'"; i++; } else { inString = false; }
            }
            continue;
         }
         if (c === "'") { inString = true; out += c; continue; }
         if (c === "(") { depth++; out += c + indent(depth); continue; }
         if (c === ")") { depth--; out += indent(depth) + c; continue; }
         if (c === ",") { out += c + indent(depth); continue; }
         if (c === ";") { out += c; continue; }
         if (c === " " && /[\s]$/.test(out)) { continue; }
         out += c;
      }
      return out.replace(/[ \t]+\n/g, "\n").replace(/\n{2,}/g, "\n").trim();
   };

   // Case-folded one character at a time, because a whole-string toUpperCase()
   // can change length (e.g. "ß" -> "SS") and that would desync the offset map
   // the statement locator depends on.
   var upperChar = function (character) {
      var upper = character.toUpperCase();
      return upper.length === 1 ? upper : character;
   };

   // Index a cube's rule text so a statement returned by the trace API can be
   // located in it. All whitespace and comments are dropped; `map` keeps the
   // original offset of every retained character.
   var buildRuleIndex = function (rulesText) {
      var text = String(rulesText || "");
      var stripped = "";
      var map = [];
      var inString = false;
      for (var i = 0; i < text.length; i++) {
         var c = text.charAt(i);
         if (inString) {
            if (c === "'") {
               if (text.charAt(i + 1) === "'") { stripped += "''"; map.push(i); map.push(i + 1); i++; continue; }
               inString = false;
            }
            if (!/\s/.test(c)) { stripped += upperChar(c); map.push(i); }
            continue;
         }
         if (c === "'") { inString = true; stripped += c; map.push(i); continue; }
         if (c === "#") {
            while (i < text.length && text.charAt(i) !== "\n") { i++; }
            continue;
         }
         if (/\s/.test(c)) { continue; }
         stripped += upperChar(c);
         map.push(i);
      }
      return { text: text, stripped: stripped, map: map };
   };

   var normalizeStatement = function (statement) {
      var text = String(statement || "");
      var stripped = "";
      var inString = false;
      for (var i = 0; i < text.length; i++) {
         var c = text.charAt(i);
         if (inString) {
            if (c === "'") {
               if (text.charAt(i + 1) === "'") { stripped += "''"; i++; continue; }
               inString = false;
            }
            if (!/\s/.test(c)) { stripped += upperChar(c); }
            continue;
         }
         if (c === "'") { inString = true; stripped += c; continue; }
         if (c === "#") {
            while (i < text.length && text.charAt(i) !== "\n") { i++; }
            continue;
         }
         if (/\s/.test(c)) { continue; }
         stripped += upperChar(c);
      }
      return stripped;
   };

   var lineNumberAt = function (text, offset) {
      var line = 1;
      for (var i = 0; i < offset && i < text.length; i++) {
         if (text.charAt(i) === "\n") { line++; }
      }
      return line;
   };

   // Contiguous run of comment lines immediately above `line` (1 based).
   var commentAbove = function (text, line) {
      var lines = text.split(/\r?\n/);
      var collected = [];
      for (var i = line - 2; i >= 0; i--) {
         var trimmed = String(lines[i] || "").trim();
         if (trimmed.charAt(0) === "#") {
            var cleaned = trimmed.replace(/^#+\s?/, "").trim();
            if (cleaned && !/^[#=~\-]+$/.test(cleaned)) { collected.unshift(cleaned); }
            continue;
         }
         break;
      }
      return collected.join(" / ");
   };

   // -> {line, matches, comment, source} or null
   var locateStatement = function (ruleIndex, statement) {
      if (!ruleIndex || !ruleIndex.stripped) { return null; }
      var needle = normalizeStatement(statement);
      if (needle.length < 8) { return null; }
      var first = ruleIndex.stripped.indexOf(needle);
      if (first < 0) { return null; }
      var matches = 0;
      var at = first;
      while (at >= 0) { matches++; at = ruleIndex.stripped.indexOf(needle, at + 1); }
      var startOffset = ruleIndex.map[first];
      var endOffset = ruleIndex.map[first + needle.length - 1];
      var line = lineNumberAt(ruleIndex.text, startOffset);
      return {
         line: line,
         matches: matches,
         comment: commentAbove(ruleIndex.text, line),
         source: ruleIndex.text.substring(startOffset, endOffset + 1)
      };
   };

   // ---------------------------------------------------------------
   // Trace tree
   // ---------------------------------------------------------------

   /* `Simple` is TM1's word for a cell that holds a value of its own — a leaf
    * that was typed in or loaded, with no rule and no children under it. That
    * is where a trace stops, and "the number came from here" is the single most
    * useful thing a reader can be told, so it is labelled rather than left to
    * an icon: `input` on the row, and a sentence in the detail panel. */
   var TYPE_META = {
      "Rule": { label: "Rule", icon: "fa-code", css: "ce-rule", chip: null },
      "Consolidation": { label: "Consolidation", icon: "fa-sitemap", css: "ce-cons", chip: null },
      "Simple": { label: "Stored input", icon: "fa-keyboard-o", css: "ce-simple", chip: "input", input: true }
   };

   var typeMeta = function (type) {
      return TYPE_META[type] ||
         { label: type || "Unknown", icon: "fa-question-circle", css: "ce-other", chip: null };
   };

   /* Could there be another level under this node? Two things have to be true:
    * the node carries a cube and a tuple (without them there is nothing to ask
    * TM1 about -- an unresolved node is offered the re-trace button instead),
    * and it is not a **stored input**.
    *
    * The second half is why this is a named predicate rather than an inline
    * test. A `Simple` cell holds its own value: the trace stops there by
    * definition, which is exactly what the `input` chip and the detail panel
    * say in words. The business tree used to draw a `+` on those rows anyway
    * -- "there may be more below" -- and clicking it fetched nothing. Every
    * affordance that offers to go deeper reads this, so the row cannot promise
    * what the fetch will not deliver. */
   var hasDeeperLevel = function (node) {
      return !!(node && node.resolved && !(node.typeMeta && node.typeMeta.input));
   };

   // Raw components in a list of subtrees, without building anything. Used to
   // report honestly how much was left out when the node budget runs out.
   var countRawNodes = function (rawNodes) {
      var total = 0;
      var stack = (rawNodes || []).slice();
      while (stack.length) {
         var current = stack.pop();
         total++;
         var kids = current.Components || [];
         for (var i = 0; i < kids.length; i++) { stack.push(kids[i]); }
      }
      return total;
   };

   /* Tuple is the cell's coordinate as TM1 resolved it, and it is now read in
    * two places: every node of a walked tree, and a preview that asked about
    * the cell without its component closure. One reader, so the two cannot
    * drift -- a preview whose members parsed differently from a tree's would
    * hand the walk a coordinate naming a different cell. */
   var tupleNames = function (rawTuple) {
      if (!rawTuple) { return null; }
      var names = [];
      for (var i = 0; i < rawTuple.length; i++) { names.push(rawTuple[i].Name); }
      return names;
   };

   var parseTuple = function (rawTuple) {
      if (!rawTuple) { return null; }
      var parsed = [];
      for (var i = 0; i < rawTuple.length; i++) {
         var hierarchy = rawTuple[i].Hierarchy;
         parsed.push({
            name: rawTuple[i].Name,
            hierarchy: hierarchy ? hierarchy.Name : null,
            dimension: hierarchy && hierarchy.Dimension ? hierarchy.Dimension.Name : null
         });
      }
      return parsed;
   };

   /* A previewed cell, from the response `buildPreviewQuery` asks for.
    *
    * Shaped to be **substitutable for a `trace` wherever the page only needs
    * the cell** -- the same `cube`, `coordinates` and `coordinateLabel` -- so
    * the coordinate bar, both clipboard copies, the link button and the feeder
    * check all work off a preview with no tree ever walked. The feeder check
    * only ever needed a coordinate (v1.3.0), and now it can have one for the
    * price of 40 ms.
    *
    * `coordinates` come back in **`buildTupleBind`'s** shape rather than
    * `parseTuple`'s, because their job is to be handed to the walk, and these
    * are the coordinates **TM1 itself resolved** -- a better starting point
    * than the ones a grid click assembled. A member whose hierarchy did not
    * come back falls back to its dimension, which is what buildTupleBind does
    * with a null anyway. */
   var normalizePreview = function (raw) {
      var body = raw || {};
      var members = parseTuple(body.Tuple) || [];
      var value = body.Value === undefined ? null : body.Value;
      var coordinates = [];
      for (var i = 0; i < members.length; i++) {
         coordinates.push({
            dimension: members[i].dimension || members[i].hierarchy,
            hierarchy: members[i].hierarchy || members[i].dimension,
            element: members[i].name
         });
      }
      return {
         value: value,
         numeric: typeof value === "number",
         zero: value === null || value === 0,
         type: body.Type || "Unknown",
         typeMeta: typeMeta(body.Type),
         status: body.Status || "",
         cube: body.Cube ? body.Cube.Name : null,
         tuple: tupleNames(body.Tuple),
         members: members,
         coordinates: coordinates,
         statements: body.Statements || [],
         statementInfo: []
      };
   };

   /* Turn the raw CalculationComponent tree into something renderable:
    * ids, depth, contribution shares, resolved/unresolved flags and stats.
    * opts: {expandDepth, maxChildren, maxNodes}
    *
    * maxNodes is a hard budget, and it is not theoretical: tracing
    * GROSS MARGIN % on a consolidated cell of GO_New_Stores at depth 3 came
    * back with 241,689 components. The API returns `Components` in full
    * whatever the $expand depth, so the tree has to be capped here or every
    * pass over it (flatten, visitTree, the HTML export) pays for all of them.
    * What is dropped is counted and reported rather than silently missing. */
   var normalizeTree = function (raw, opts) {
      var options = opts || {};
      var expandDepth = options.expandDepth === undefined ? 2 : options.expandDepth;
      var maxChildren = options.maxChildren || 250;
      var maxNodes = options.maxNodes === undefined ? 20000 : options.maxNodes;
      /* The depth the REQUEST was bounded at, so the frontier can be told from
       * a genuine leaf. It has to be passed in, because the response cannot say
       * it: a bounded node and a real leaf arrive byte-for-byte identical --
       * `Type, Status, Value, Statements`, no `Components` key, no annotation
       * (§5a.11 leg 5). And `Type` cannot stand in for it, which was §5a.11's
       * mistake: a rule whose formula is a constant is a childless `Rule`
       * (`tests/run-tests.js` carries one), so `Rule` does not imply children.
       * The client knows what it asked for, so it does not need to be told.
       * `null` means "unbounded" and reproduces the old behaviour exactly. */
      var boundDepth = options.boundDepth === undefined ? null : options.boundDepth;

      var stats = {
         nodeCount: 0,
         maxDepth: 0,
         leafCount: 0,
         ruleCount: 0,
         unresolvedCount: 0,
         truncatedCount: 0,
         nodeBudget: maxNodes,
         budgetHit: false,
         droppedCount: 0,
         boundaryCount: 0,
         /* **`boundaryCount` counts the bound; this counts the affordance**,
          * and the difference is the whole of 5d item 26's review.
          * `boundaryCount` is set on depth alone, so on the commonest shape in
          * TM1 -- a consolidation whose children are stored inputs, traced at
          * depth 1 -- every child is `belowBound` and none of them can be
          * fetched: `hasDeeperLevel` is false for a `Simple` cell, which is why
          * the `⊞` twisty (template.html) reads
          * `!node.hasChildren && node.belowBound && hasDeeperLevel(node)` and
          * not `belowBound` alone. A card reading "FRONTIER 6" and a banner
          * saying "open one with ⊞" over six rows that draw no ⊞ is a label the
          * data does not support, inside the feature built to remove one. So
          * the two new surfaces count THIS, on exactly the predicate the twisty
          * uses, and `boundaryCount` keeps its meaning and its consumers. */
         fetchableCount: 0,
         boundDepth: boundDepth,
         cubes: {},
         statements: {}
      };

      /* A share of the parent only means something when the children add up
       * to it. A consolidation always does. A rule sometimes does
       * (['Cost'] = N: ['Material'] + ['Resource']) and sometimes does not
       * ((['ASPWA']*100) \ ['GROSS REVENUE']) — so it is decided by checking,
       * not by assuming. Getting this wrong printed "1317220763%". */
      var addsUp = function (total, value) {
         if (typeof value !== "number" || typeof total !== "number") { return false; }
         if (value === 0) { return total === 0; }
         return Math.abs(total - value) <= Math.max(1e-6, Math.abs(value) * 0.005);
      };

      /* One node, children not filled in yet. */
      var makeNode = function (rawNode, id, depth, parentValue, siblingAbsTotal, parentSums) {
         var value = rawNode.Value === undefined ? null : rawNode.Value;
         var numeric = typeof value === "number";
         var rawChildren = rawNode.Components || [];
         var truncated = Math.max(0, rawChildren.length - maxChildren);
         var statements = rawNode.Statements || [];

         var node = {
            id: id,
            depth: depth,
            type: rawNode.Type || "Unknown",
            typeMeta: typeMeta(rawNode.Type),
            status: rawNode.Status || "",
            value: value,
            numeric: numeric,
            zero: value === null || value === 0,
            cube: rawNode.Cube ? rawNode.Cube.Name : null,
            tuple: tupleNames(rawNode.Tuple),
            members: parseTuple(rawNode.Tuple),
            statements: statements,
            statementInfo: [],
            children: [],
            childTruncated: truncated,
            expanded: depth < expandDepth,
            share: null,
            absShare: null,
            hasChildren: rawChildren.length > 0,
            /* Stamped here and never recomputed from `depth` afterwards:
             * `reassignIds` rewrites `depth` on a spliced subtree when a node is
             * deepened (§5a.12), so a flag derived from depth later would move
             * off the real frontier and mark the wrong rows. */
            belowBound: boundDepth !== null && depth >= boundDepth,
            deepened: false
         };
         node.resolved = !!(node.cube && node.tuple);

         if (parentSums && numeric && typeof parentValue === "number" && parentValue !== 0) {
            node.share = value / parentValue;
         }
         if (parentSums && numeric && siblingAbsTotal > 0) {
            node.absShare = Math.abs(value) / siblingAbsTotal;
         }

         stats.nodeCount++;
         stats.maxDepth = Math.max(stats.maxDepth, depth);
         if (node.belowBound) { stats.boundaryCount++; }
         /* Counted here rather than in a second pass because `typeMeta`,
          * `hasChildren` and `resolved` are all on the node by this line --
          * `resolved` is assigned immediately above -- which is everything
          * `hasDeeperLevel` reads. */
         if (node.belowBound && !node.hasChildren && hasDeeperLevel(node)) {
            stats.fetchableCount++;
         }
         /* A node at the bound has no children **because we did not ask**, so
          * counting it as a leaf is the one outright lie a bounded response
          * would otherwise put on screen -- and "Leaves" is on the export card. */
         if (!rawChildren.length && !node.belowBound) { stats.leafCount++; }
         if (statements.length) { stats.ruleCount++; }
         if (!node.resolved) { stats.unresolvedCount++; }
         stats.truncatedCount += truncated;
         if (node.cube) { stats.cubes[node.cube] = (stats.cubes[node.cube] || 0) + 1; }
         for (var s = 0; s < statements.length; s++) {
            stats.statements[statements[s]] = (stats.statements[statements[s]] || 0) + 1;
         }
         return node;
      };

      /* Filled **breadth first**, which is not a detail — it is what makes a
       * budgeted trace readable.
       *
       * Depth first spends the whole budget on the first branch: tracing
       * `(['ASPWA']*100) \ ['GROSS REVENUE']` built 20,000 nodes inside ASPWA
       * and never created GROSS REVENUE at all, so the formula rendered
       * "GROSS REVENUE ?" as if TM1 had not returned it. It had — it was the
       * root's second component.
       *
       * Level by level, every shallow level is complete before anything deeper
       * is built, so a rule always shows all of its operands and what runs out
       * is detail at the frontier — which is also where "trace deeper from
       * here" picks up. */
      var fill = function (rawRoot) {
         var root = makeNode(rawRoot, "0", 0, null, 0, false);
         var queue = [{ raw: rawRoot, node: root }];
         var head = 0;

         while (head < queue.length) {
            var entry = queue[head++];
            var rawChildren = entry.raw.Components || [];
            if (!rawChildren.length) { continue; }
            var node = entry.node;
            var kept = rawChildren.slice(0, maxChildren);
            var i;

            var absTotal = 0;
            var signedTotal = 0;
            for (i = 0; i < kept.length; i++) {
               if (typeof kept[i].Value === "number") {
                  absTotal += Math.abs(kept[i].Value);
                  signedTotal += kept[i].Value;
               }
            }
            // Truncated children would make the sum look wrong, so no shares then.
            var childrenSum = node.childTruncated === 0 &&
               (node.type === "Consolidation" || addsUp(signedTotal, node.value));
            node.childrenSum = childrenSum;

            for (i = 0; i < kept.length; i++) {
               if (stats.nodeCount >= maxNodes) {
                  var dropped = countRawNodes(kept.slice(i));
                  stats.budgetHit = true;
                  stats.droppedCount += dropped;
                  node.budgetDropped = (node.budgetDropped || 0) + dropped;
                  // Part of the sum is missing, so no share on this level is safe.
                  node.childrenSum = false;
                  for (var d = 0; d < node.children.length; d++) {
                     node.children[d].share = null;
                     node.children[d].absShare = null;
                  }
                  break;
               }
               var child = makeNode(kept[i], node.id + "." + i, node.depth + 1,
                  node.value, absTotal, childrenSum);
               node.children.push(child);
               queue.push({ raw: kept[i], node: child });
            }
            /* Nothing built under it: the caret must not promise children that
             * are not there. `hasChildren` false is also what makes the business
             * view offer "trace deeper from here", the way past the budget. */
            node.hasChildren = node.children.length > 0;
         }
         return root;
      };

      var root = fill(raw || {});
      root.expanded = true;
      return { root: root, stats: stats };
   };

   var visitTree = function (node, callback) {
      callback(node);
      for (var i = 0; i < node.children.length; i++) { visitTree(node.children[i], callback); }
   };

   var findNode = function (root, id) {
      var found = null;
      visitTree(root, function (node) { if (node.id === id) { found = node; } });
      return found;
   };

   // Re-id a spliced-in subtree so ids stay unique and path-like.
   var reassignIds = function (node, id, depth) {
      node.id = id;
      node.depth = depth;
      for (var i = 0; i < node.children.length; i++) {
         reassignIds(node.children[i], id + "." + i, depth + 1);
      }
   };

   var matchesFilters = function (node, filters) {
      if (filters.rulesOnly && !node.statements.length) { return false; }
      if (filters.hideZero && node.zero) { return false; }
      if (filters.cube && node.cube !== filters.cube) { return false; }
      if (filters.text) {
         var needle = filters.text.toLowerCase();
         var haystack = [
            node.cube || "",
            (node.tuple || []).join(" "),
            node.type,
            node.statements.join(" ")
         ].join(" ").toLowerCase();
         if (haystack.indexOf(needle) === -1) { return false; }
      }
      return true;
   };

   /* Flatten to the rows the template renders. A node is kept when it matches
    * the filters or has a descendant that does, so filtering never orphans
    * a match.
    *
    * filters.maxRows caps how many rows are handed to the DOM. It matters
    * because "expand all" on a 20,000 node trace would otherwise ask Angular
    * for 20,000 rows, each with its own detail block — the tree is flattened
    * rather than recursive precisely to stay fast, and this is the other half
    * of that. The count that did not fit is reported on the array as
    * `truncatedRows`. */
   var flatten = function (root, filters) {
      var active = !!(filters && (filters.text || filters.hideZero || filters.rulesOnly || filters.cube));
      var keep = {};
      if (active) {
         var mark = function (node) {
            var self = matchesFilters(node, filters);
            var child = false;
            for (var i = 0; i < node.children.length; i++) {
               if (mark(node.children[i])) { child = true; }
            }
            keep[node.id] = self || child;
            return keep[node.id];
         };
         mark(root);
      }

      var byContribution = function (a, b) {
         var left = typeof a.value === "number" ? Math.abs(a.value) : -1;
         var right = typeof b.value === "number" ? Math.abs(b.value) : -1;
         return right - left;
      };

      var maxRows = (filters && filters.maxRows) || 0;
      var rows = [];
      var skipped = 0;
      var push = function (node, parent, ancestors) {
         if (active && !keep[node.id]) { return; }
         if (maxRows && rows.length >= maxRows) {
            // Still walked, so the count is honest, but nothing is prepared
            // for a row that will not be rendered.
            skipped++;
         } else {
            node.indent = ancestors.length;
            node.lastChild = ancestors.length ? ancestors[ancestors.length - 1] : false;
            // Stored as a plain value, not a parent reference: a back-pointer
            // would make the tree cyclic and Angular deep-compares these.
            node.business = businessLabel(node, parent);
            rows.push(node);
         }
         if (!node.expanded) { return; }
         var visible = [];
         var hiddenZeros = 0;
         for (var i = 0; i < node.children.length; i++) {
            var child = node.children[i];
            if (active && !keep[child.id]) {
               if (child.zero) { hiddenZeros++; }
               continue;
            }
            visible.push(child);
         }
         // Reported as "+N with no value" rather than silently dropped.
         node.hiddenZeroCount = hiddenZeros;
         if (filters && filters.sortByContribution) {
            // Copy: node.children order is what the ids encode, so it must stand.
            visible = visible.slice().sort(byContribution);
         }
         for (var j = 0; j < visible.length; j++) {
            push(visible[j], node, ancestors.concat([j === visible.length - 1]));
         }
      };
      push(root, null, []);
      rows.truncatedRows = skipped;
      return rows;
   };

   // Chain of nodes from the root down to `id`.
   var pathTo = function (root, id) {
      var parts = String(id).split(".");
      var chain = [root];
      var current = root;
      for (var i = 1; i < parts.length; i++) {
         current = current.children[parseInt(parts[i], 10)];
         if (!current) { break; }
         chain.push(current);
      }
      return chain;
   };

   // Child with the largest absolute value — the "what drives this" step.
   var biggestChild = function (node) {
      var best = null;
      for (var i = 0; i < node.children.length; i++) {
         var child = node.children[i];
         if (typeof child.value !== "number") { continue; }
         if (!best || Math.abs(child.value) > Math.abs(best.value)) { best = child; }
      }
      return best;
   };

   // Members know their own dimension once Hierarchy is expanded. An alternate
   // hierarchy is called out as "dimension:hierarchy" because it changes how
   // the number was reached and is easy to miss otherwise.
   var memberLabel = function (member) {
      if (!member.dimension) { return member.name; }
      var qualifier = (member.hierarchy && member.hierarchy !== member.dimension)
         ? member.dimension + ":" + member.hierarchy
         : member.dimension;
      return qualifier + " = " + member.name;
   };

   var hasMemberDetail = function (node) {
      if (!node.members || !node.members.length) { return false; }
      for (var i = 0; i < node.members.length; i++) {
         if (!node.members[i].dimension) { return false; }
      }
      return true;
   };

   var coordinateLabel = function (node, dimensionsByCube, separator) {
      if (!node.tuple) { return null; }
      var glue = separator || ", ";
      var parts = [];
      var i;
      if (hasMemberDetail(node)) {
         for (i = 0; i < node.members.length; i++) { parts.push(memberLabel(node.members[i])); }
         return parts.join(glue);
      }
      var dims = (dimensionsByCube || {})[node.cube];
      if (!dims || dims.length !== node.tuple.length) { return node.tuple.join(" | "); }
      for (i = 0; i < node.tuple.length; i++) {
         parts.push(dims[i] + " = " + node.tuple[i]);
      }
      return parts.join(glue);
   };

   /* Coordinates for re-tracing this node. Prefers the hierarchy the trace
    * actually used; falls back to the cube's dimension list (primary
    * hierarchies) when the server did not expand the members. */
   var coordinatesOf = function (node, dimensionsByCube) {
      if (!node.tuple) { return null; }
      var coordinates = [];
      var i;
      if (hasMemberDetail(node)) {
         for (i = 0; i < node.members.length; i++) {
            coordinates.push({
               dimension: node.members[i].dimension,
               hierarchy: node.members[i].hierarchy || node.members[i].dimension,
               element: node.members[i].name
            });
         }
         return coordinates;
      }
      var dims = (dimensionsByCube || {})[node.cube];
      if (!dims || dims.length !== node.tuple.length) { return null; }
      for (i = 0; i < dims.length; i++) {
         coordinates.push({ dimension: dims[i], hierarchy: dims[i], element: node.tuple[i] });
      }
      return coordinates;
   };

   /* ---------------------------------------------------------------
    * Fed cells
    * ---------------------------------------------------------------
    *
    * `tm1.TraceFeeders` answers a `FedCellDescriptor` for every cell the
    * traced cell feeds, and each one carries a **`Fed` boolean** -- the
    * server's own tick, and the only place either feeder call says whether a
    * named cell is actually reached. It arrives **by default**, because the
    * request carries no top-level `$select` (the structural-property behaviour
    * §5a.11 turned on its head for `Components`): measured on
    * `Store Cost :: Americas | Department Store | Average Monthly Revenue |
    * Full Size Store | Franchise Store | DATA`, two entries, both `Fed: true`.
    *
    * **Three states, not two.** `true` is fed, `false` is a cell a feeder
    * statement names that nothing actually reaches -- the thing worth seeing,
    * because a rule value there reads as zero -- and **anything else is
    * `null`, "not reported", never "not fed"**. That distinction is item 36's
    * lesson: a mark the reader takes for a data fact may only be shown where
    * the datum was actually read.
    *
    * The fallback path is why `labelled` exists. When the expanded request is
    * refused the plugin re-asks without it, and a fed cell then arrives as
    * **`{ "Fed": true }` and nothing else** -- measured, same cell. The old
    * `feederLabel` dumped that object through `angular.toJson`, so every row
    * on the fallback path read `{"Fed":true}`. An unlabelled row now says so
    * in words and keeps its tick, which is the half the server did send.
    *
    * `members` pairs the tuple with the cube's dimension names the way
    * `coordinateLabel` does, and for the same reason: the names are what make
    * a six-member row readable. A tuple that does not match the dimension list
    * (a fed cell in another cube whose dimensions were never read) keeps its
    * elements in server order with no dimension claimed against them.
    */
   var normalizeFedCell = function (item, dimensionsByCube) {
      var row = { cube: "", tuple: [], members: [], label: "", fed: null, labelled: false };
      if (!item || typeof item !== "object") { return row; }
      row.fed = item.Fed === true ? true : (item.Fed === false ? false : null);
      if (item.Cube && typeof item.Cube.Name === "string") { row.cube = item.Cube.Name; }
      var i;
      if (item.Tuple && typeof item.Tuple.length === "number") {
         for (i = 0; i < item.Tuple.length; i++) {
            var member = item.Tuple[i];
            row.tuple.push(member && typeof member.Name === "string" ? member.Name : "");
         }
      }
      row.labelled = !!(row.cube || row.tuple.length);
      row.label = row.tuple.length
         ? (row.cube ? row.cube + " :: " : "") + row.tuple.join(" | ")
         : row.cube;
      var dims = (dimensionsByCube || {})[row.cube];
      var named = !!(dims && dims.length === row.tuple.length);
      for (i = 0; i < row.tuple.length; i++) {
         row.members.push({ dimension: named ? dims[i] : "", element: row.tuple[i] });
      }
      return row;
   };

   /* What the list as a whole says, so the page can lead with it rather than
    * leaving the reader to scan for a missing tick. `unknown` is counted
    * separately and deliberately: a server that stops sending `Fed` must read
    * as "not reported here", not as a clean bill of health. */
   var fedCellSummary = function (rows) {
      var summary = { total: 0, fed: 0, unfed: 0, unknown: 0 };
      if (!rows || typeof rows.length !== "number") { return summary; }
      for (var i = 0; i < rows.length; i++) {
         var row = rows[i] || {};
         summary.total++;
         if (row.fed === true) { summary.fed++; }
         else if (row.fed === false) { summary.unfed++; }
         else { summary.unknown++; }
      }
      return summary;
   };

   // ---------------------------------------------------------------
   // Rule statement -> a readable calculation
   //
   // A statement like
   //   ['Gross Sales Margin':{'Effect of All Store Promotions'}]
   //      = C:(['Gross Sales Margin':'ASPWA']*100)\['Gross Sales Margin':'GROSS REVENUE'];
   // becomes
   //   Effect of All Store Promotions = (ASPWA[4,168] * 100) \ GROSS REVENUE[124,431,529]
   // by dropping the dimension qualifiers and substituting each operand's value
   // from the component that supplied it.
   // ---------------------------------------------------------------

   // Commas at the top level only — not inside quotes, braces, parens or an
   // area reference, so a DB( … ) argument that is itself a call or a [ … ]
   // survives as one argument.
   var splitTop = function (text) {
      var parts = [];
      var current = "";
      var inString = false;
      var depth = 0;
      for (var i = 0; i < text.length; i++) {
         var c = text.charAt(i);
         if (inString) {
            current += c;
            if (c === "'") {
               if (text.charAt(i + 1) === "'") { current += "'"; i++; } else { inString = false; }
            }
            continue;
         }
         if (c === "'") { inString = true; current += c; continue; }
         if (c === "{" || c === "(" || c === "[") { depth++; current += c; continue; }
         if (c === "}" || c === ")" || c === "]") { depth--; current += c; continue; }
         if (c === "," && depth === 0) { parts.push(current); current = ""; continue; }
         current += c;
      }
      parts.push(current);
      return parts;
   };

   var quotedStrings = function (text) {
      var found = [];
      var current = "";
      var inString = false;
      for (var i = 0; i < text.length; i++) {
         var c = text.charAt(i);
         if (inString) {
            if (c === "'") {
               if (text.charAt(i + 1) === "'") { current += "'"; i++; continue; }
               inString = false;
               found.push(current);
               current = "";
               continue;
            }
            current += c;
            continue;
         }
         if (c === "'") { inString = true; current = ""; }
      }
      return found;
   };

   /* ['Dim':'El'] -> "El" ;  ['a','b'] -> "a · b" ;  ['D':{'E'}] -> "E".
    * The dimension qualifier in front of the element is noise to a reader.
    *
    * `prefer` is the set of element names the cell being labelled actually has,
    * uppercased, and it exists because a **{set} area** has no single element
    * to name. `['Retailers':{eight retailers}, 'Gross Sales Margin':'Effect of
    * All Store Promotions']` used to label a `Department Store` cell
    * "Equipment Rental Store · …" — the last member of the set, printed where a
    * reader expects this cell's own coordinate, which reads as the wrong cell
    * being traced. Measured on the running model, v1.8.1.
    *
    * With `prefer` the member the cell actually has wins. Without it — an
    * unresolved node has no coordinates to offer — a multi-member set says so
    * (`first +N more`) rather than picking one and looking definite. A single
    * name is unchanged either way, which is every case but this one. */
   var bracketLabel = function (inner, prefer) {
      var parts = splitTop(inner);
      var labels = [];
      for (var i = 0; i < parts.length; i++) {
         var names = quotedStrings(parts[i]);
         if (!names.length) { continue; }
         // names[0] is the dimension qualifier whenever there is more than one.
         var candidates = names.length > 1 ? names.slice(1) : names;
         var picked = null;
         if (prefer) {
            for (var c = 0; c < candidates.length && !picked; c++) {
               if (prefer[String(candidates[c]).toUpperCase()]) { picked = candidates[c]; }
            }
         }
         if (picked) { labels.push(picked); }
         else if (candidates.length > 1) { labels.push(candidates[0] + " +" + (candidates.length - 1) + " more"); }
         else { labels.push(candidates[candidates.length - 1]); }
      }
      return labels.join("  ·  ");
   };

   /* The dimension/element pairs a `[ … ]` operand names, or **null** when the
    * text does not name them all.
    *
    * `bracketLabel` answers "what should this read on screen" and drops the
    * dimension qualifier to do it; this answers "which cell is it", which needs
    * exactly the part that was dropped. Both halves have to be there for every
    * part: `['Gross Sales Margin':'X']` names a cell, `['X']` names an element in
    * an unstated dimension and this plugin will not guess which — the operand
    * stays inert rather than offering a trace of a cell it inferred. A `{set}`
    * part (three or more names) is not one cell either. */
   var referencePairs = function (inner) {
      var parts = splitTop(inner);
      var pairs = [];
      for (var i = 0; i < parts.length; i++) {
         var names = quotedStrings(parts[i]);
         if (names.length !== 2) { return null; }
         pairs.push({ dimension: names[0], element: names[1] });
      }
      return pairs.length ? pairs : null;
   };

   /* This node's coordinate with the operand's own members substituted in — the
    * cell a `[ … ]` operand refers to, and so the cell "resolve this operand"
    * has to ask the server about (§5d item 36 step 4).
    *
    * Read off the **node**, never off the trace root: a rule reference is
    * relative to the cell whose rule it is. Null unless every pair names a
    * dimension this node has, so a reference reaching another cube cannot
    * produce a coordinate that looks right and names the wrong cell — the §4l
    * mistake, in the one direction that would also spend a request on it.
    *
    * The **hierarchy stays the node's own**, which is the same rule `deepen`
    * follows: a rule writes dimension names, and re-tracing has to use the
    * hierarchy the trace itself reported. Where that hierarchy does not hold the
    * substituted element the server says so, which is the honest failure — the
    * alternative is guessing at a primary hierarchy the rule never named. */
   var operandCoordinates = function (node, pairs) {
      if (!node || !pairs || !pairs.length) { return null; }
      var members = node.members || [];
      if (!members.length) { return null; }
      var coordinates = [];
      var byDimension = {};
      var i;
      for (i = 0; i < members.length; i++) {
         if (!members[i].dimension || !members[i].name) { return null; }
         byDimension[String(members[i].dimension).toUpperCase()] = i;
         coordinates.push({
            dimension: members[i].dimension,
            hierarchy: members[i].hierarchy || members[i].dimension,
            element: members[i].name
         });
      }
      for (i = 0; i < pairs.length; i++) {
         var at = byDimension[String(pairs[i].dimension).toUpperCase()];
         if (at === undefined) { return null; }
         coordinates[at].element = pairs[i].element;
      }
      return coordinates;
   };

   // The cell's own element names, as bracketLabel's `prefer` wants them.
   var preferredNames = function (node) {
      if (!node) { return null; }
      var names = memberNames(node);
      if (!names.length) { return null; }
      var set = {};
      for (var i = 0; i < names.length; i++) { set[String(names[i]).toUpperCase()] = true; }
      return set;
   };

   // Top-level [...] groups, with their offsets, ignoring anything in quotes.
   var bracketGroups = function (text) {
      var groups = [];
      var inString = false;
      var depth = 0;
      var start = -1;
      for (var i = 0; i < text.length; i++) {
         var c = text.charAt(i);
         if (inString) {
            if (c === "'") {
               if (text.charAt(i + 1) === "'") { i++; } else { inString = false; }
            }
            continue;
         }
         if (c === "'") { inString = true; continue; }
         if (c === "[") { if (depth === 0) { start = i; } depth++; continue; }
         if (c === "]") {
            depth--;
            if (depth === 0 && start >= 0) {
               groups.push({ start: start, end: i + 1, inner: text.substring(start + 1, i) });
               start = -1;
            }
         }
      }
      return groups;
   };

   // -> {area, kind, expression} or null when it does not look like a rule
   // `prefer` (optional) labels a {set} area with the element the cell has.
   var parseRuleStatement = function (raw, prefer) {
      /* Quote-aware: `findChild` matches an operand label against a component's
       * element name **exactly**, so a name holding consecutive spaces has to
       * survive this line intact. See `collapseOutsideStrings` (§5d item 36). */
      var text = collapseOutsideStrings(raw);
      if (!text) { return null; }
      var groups = bracketGroups(text);
      if (!groups.length || groups[0].start !== 0) { return null; }
      var rest = text.substring(groups[0].end).replace(/^\s*=\s*/, "");
      var kind = null;
      var kindMatch = rest.match(/^([NCS])\s*:\s*/i);
      if (kindMatch) {
         kind = kindMatch[1].toUpperCase();
         rest = rest.substring(kindMatch[0].length);
      }
      return {
         area: bracketLabel(groups[0].inner, prefer),
         kind: kind,
         expression: rest.replace(/;\s*$/, "").trim()
      };
   };

   var memberNames = function (node) {
      if (node.members && node.members.length) {
         var names = [];
         for (var i = 0; i < node.members.length; i++) { names.push(node.members[i].name); }
         return names;
      }
      return node.tuple || [];
   };

   /* ---- DB( … ) lookups ------------------------------------------------
    *
    * A rule reads another cube with `DB('Cube', coord, coord, …)`, and those
    * coordinates are usually `!dimension` references or `ATTRS( … )` calls —
    * so the text says *where to look*, never *what was looked at*. TM1 returns
    * a component for the lookup, and §2.1/§4l is what ties the two together:
    * **a DB call's arguments are in the target cube's dimension order, and so
    * is a component's `Tuple`**. So a literal argument can be checked against
    * the component's element at the same position, with no dimension list in
    * hand, and the remaining positions are then read off the component that
    * matched.
    *
    * Note the direction of that. The arguments shown are the ones TM1
    * reported; this cell's own coordinates are never substituted into the
    * text. §4l is explicit that `statements[0]` is not reliably the node's own
    * rule, so substituting our coordinates into a statement can produce a
    * confidently wrong lookup — reading them off the component cannot.
    */

   // A quoted argument names an element; anything else (!dim, 12, ATTRS( … ))
   // is an expression and names nothing here. Same test parseCellReference uses.
   var literalArgument = function (part) {
      var text = String(part).trim();
      var quoted = quotedStrings(text);
      return (quoted.length === 1 && text.charAt(0) === "'" && text.charAt(text.length - 1) === "'")
         ? quoted[0]
         : null;
   };

   // Index of the ")" closing the "(" at `open`, ignoring parens inside quotes.
   var closingParen = function (text, open) {
      var depth = 0;
      var inString = false;
      for (var i = open; i < text.length; i++) {
         var c = text.charAt(i);
         if (inString) {
            if (c === "'") {
               if (text.charAt(i + 1) === "'") { i++; } else { inString = false; }
            }
            continue;
         }
         if (c === "'") { inString = true; continue; }
         if (c === "(") { depth++; continue; }
         if (c === ")") { depth--; if (depth === 0) { return i; } }
      }
      return -1;
   };

   /* Every DB( … ) in an expression, with its arguments and where it sits.
    * Scanned rather than matched with a regular expression: an argument can be
    * a call of its own, can carry a quoted comma, and the text around the call
    * has to survive verbatim. A DB nested inside another call's arguments is
    * not reported separately — only the outer call has a component of its own.
    *
    * -> [{ start, end, cube, args: [{ source, literal }] }], args[0] the cube */
   var dbCalls = function (expression) {
      var text = String(expression || "");
      var calls = [];
      var inString = false;
      for (var i = 0; i < text.length; i++) {
         var c = text.charAt(i);
         if (inString) {
            if (c === "'") {
               if (text.charAt(i + 1) === "'") { i++; } else { inString = false; }
            }
            continue;
         }
         if (c === "'") { inString = true; continue; }
         if (c !== "D" && c !== "d") { continue; }
         var head = /^db\s*\(/i.exec(text.substring(i, i + 24));
         if (!head) { continue; }
         // …and DB is a word here, not the tail of one: SUBDB( is not a lookup.
         if (i > 0 && /[A-Za-z0-9_]/.test(text.charAt(i - 1))) { continue; }
         var open = i + head[0].length - 1;
         var close = closingParen(text, open);
         if (close < 0) { continue; }
         var args = [];
         var parts = splitTop(text.substring(open + 1, close));
         for (var p = 0; p < parts.length; p++) {
            args.push({ source: parts[p].trim(), literal: literalArgument(parts[p]) });
         }
         calls.push({
            start: i,
            end: close + 1,
            cube: args.length ? args[0].literal : null,
            args: args
         });
         i = close;
      }
      return calls;
   };

   /* The component TM1 returned for one lookup, or null to leave it alone.
    *
    * A component qualifies when it is in the target cube, carries one element
    * per coordinate argument, and agrees with every argument the text spells
    * out. It binds only when **exactly one** unused component qualifies: the
    * ten `'1'`…`'10'` lookups of the promotions rule each name their own,
    * while the two same-cube lookups of the New Stores rule are told apart
    * only by the literal one of them carries — so the other binds afterwards,
    * on what is left, or not at all. Two lookups the text cannot tell apart
    * are left verbatim rather than guessed at, which is the safety property
    * this whole feature rests on. */
   var matchDbComponent = function (call, kids, used) {
      if (!call.cube || call.args.length < 2) { return null; }
      var wantCube = call.cube.toUpperCase();
      var coords = call.args.slice(1);
      var found = -1;
      for (var i = 0; i < kids.length; i++) {
         if (used[i]) { continue; }
         var kid = kids[i];
         if (!kid.cube || String(kid.cube).toUpperCase() !== wantCube) { continue; }
         var names = memberNames(kid);
         /* No coordinates at all means the component sits below the expand
          * depth — nothing to check against — and a different count is a
          * different cube's tuple. Either way there is no positional match. */
         if (!names.length || names.length !== coords.length) { continue; }
         var agrees = true;
         for (var a = 0; a < coords.length; a++) {
            if (coords[a].literal === null) { continue; }
            if (String(names[a]).toUpperCase() !== coords[a].literal.toUpperCase()) {
               agrees = false;
               break;
            }
         }
         if (!agrees) { continue; }
         if (found > -1) { return null; }
         found = i;
      }
      if (found < 0) { return null; }
      used[found] = true;
      return kids[found];
   };

   /* The lookup rewritten with the component's own coordinates in it. An
    * argument the rule spells out is left exactly as written — `'1'` says more
    * than `1` substituted back over itself — so what is highlighted is
    * precisely the part a reader could not otherwise know. Each substituted
    * part keeps the text it replaced, for the tooltip. */
   var dbTokenParts = function (call, node) {
      var names = memberNames(node);
      var members = node.members || [];
      /* An alternate hierarchy is written back in, in TM1's own `Hierarchy:El`
       * form. §2.1: a step can land in one (the sample model's `Europe` is in
       * `Country and Region 2025`, not the primary), and an element name on its
       * own would quietly say the primary. */
      var coordinate = function (i) {
         var member = members[i];
         return (member && member.hierarchy && member.dimension && member.hierarchy !== member.dimension)
            ? member.hierarchy + ":" + names[i]
            : names[i];
      };

      var parts = [{ text: "DB(" + call.args[0].source }];
      for (var a = 1; a < call.args.length; a++) {
         parts.push({ text: ", " });
         if (call.args[a].literal !== null) {
            parts.push({ text: call.args[a].source });
         } else {
            parts.push({ sub: coordinate(a - 1), from: call.args[a].source });
         }
      }
      parts.push({ text: ")" });
      return parts;
   };

   var partsText = function (parts) {
      var out = "";
      for (var i = 0; i < parts.length; i++) { out += (parts[i].sub || parts[i].text); }
      return out;
   };

   /* Split the right-hand side into plain text and operand tokens, matching
    * each operand to the component that supplied its value. Each component is
    * consumed at most once, so a formula referencing the same element twice
    * lines up with the two components the server returned.
    *
    * Two passes, and the specific matcher goes first: a DB lookup identifies
    * its component by cube *and* position, while a [ … ] operand identifies it
    * by element name alone and would happily consume a cross-cube component
    * that merely shares a name. Binding the lookups first keeps the loose
    * matcher off components that are already spoken for. */
   var calculationTokens = function (parsed, children) {
      if (!parsed) { return []; }
      var expression = parsed.expression;
      var kids = children || [];
      var used = {};
      var marks = [];
      var i;

      var calls = dbCalls(expression);
      for (i = 0; i < calls.length; i++) {
         marks.push({
            start: calls[i].start,
            end: calls[i].end,
            call: calls[i],
            child: matchDbComponent(calls[i], kids, used)
         });
      }

      var insideCall = function (group) {
         for (var c = 0; c < calls.length; c++) {
            if (group.start >= calls[c].start && group.end <= calls[c].end) { return true; }
         }
         return false;
      };

      var findChild = function (label) {
         var wanted = String(label).toUpperCase();
         for (var k = 0; k < kids.length; k++) {
            if (used[k]) { continue; }
            var names = memberNames(kids[k]);
            for (var n = 0; n < names.length; n++) {
               if (String(names[n]).toUpperCase() === wanted) { used[k] = true; return kids[k]; }
            }
         }
         return null;
      };

      var groups = bracketGroups(expression);
      for (i = 0; i < groups.length; i++) {
         if (insideCall(groups[i])) { continue; }
         marks.push({ start: groups[i].start, end: groups[i].end, inner: groups[i].inner });
      }
      marks.sort(function (a, b) { return a.start - b.start; });

      // Resolved in reading order, so a repeated operand still lines up with
      // the components in the order the server returned them.
      for (i = 0; i < marks.length; i++) {
         if (marks[i].call) { continue; }
         marks[i].label = bracketLabel(marks[i].inner);
         marks[i].child = findChild(marks[i].label);
      }

      var tokens = [];
      var at = 0;
      for (i = 0; i < marks.length; i++) {
         var mark = marks[i];
         if (mark.start > at) { tokens.push({ text: expression.substring(at, mark.start) }); }
         at = mark.end;
         if (mark.call) {
            /* An unmatched lookup stays exactly as the rule wrote it. "?" is
             * reserved for an operand TM1 was asked for and did not report;
             * a lookup nothing was asked about would be a claim of absence
             * this cannot support. */
            if (!mark.child) {
               tokens.push({ text: expression.substring(mark.start, mark.end) });
               continue;
            }
            var parts = dbTokenParts(mark.call, mark.child);
            tokens.push({
               db: true,
               parts: parts,
               ref: partsText(parts),
               value: mark.child.value,
               matched: true,
               nodeId: mark.child.id
            });
            continue;
         }
         tokens.push({
            ref: mark.label,
            value: mark.child ? mark.child.value : null,
            matched: !!mark.child,
            nodeId: mark.child ? mark.child.id : null,
            /* Which cell this operand is, as opposed to what it reads as —
             * the panel needs both to make the chip lead somewhere (§5d item
             * 36 step 4), and only the reference text knows the dimensions. */
            refPairs: referencePairs(mark.inner)
         });
      }
      if (at < expression.length) { tokens.push({ text: expression.substring(at) }); }
      return tokens;
   };

   /* ---- which returned statement is this node's own -------------------
    *
    * §4l: a node can come back carrying its *components'* statements as well as
    * its own, and its own is not reliably first — one cell of the demo model
    * (`Gross Margin Calculation`, New Store Opening (hide)) answers with **ten**,
    * nine of them the link cube's rule and the node's own last. Reading
    * `statements[0]` therefore shows a foreign formula as if it were the cell's,
    * which is the sharpest hazard §4l records and the reason backlog 2 was
    * called delicate.
    *
    * The discriminator is exact rather than heuristic: a `!dimension` reference
    * inside a rule always names a dimension of the **rule's own cube**, even
    * where it sits inside a DB( ) reading another one. A statement naming a
    * dimension this node's cube does not have cannot be this node's rule.
    *
    * It is written as a *keep* test and not a *drop* test, deliberately. A
    * dimension name holding a character the reference scanner stops at would be
    * read short; dropping on that would hide the right statement, while keeping
    * on it merely fails to promote it and the whole set falls back to what was
    * shown before. The worst case is therefore today's behaviour, not a worse
    * one. */
   var DIMENSION_REFERENCE = /![A-Za-z0-9_ ]+/g;

   var statementFits = function (statement, dimensions) {
      // A quoted name can hold a "!" that is text, not a reference.
      var found = String(statement || "").replace(/'(?:''|[^'])*'/g, "''").match(DIMENSION_REFERENCE);
      if (!found) { return true; }
      for (var i = 0; i < found.length; i++) {
         var name = found[i].substring(1).trim().toUpperCase();
         if (name && !dimensions[name]) { return false; }
      }
      return true;
   };

   var ownStatements = function (node) {
      var statements = node.statements || [];
      var members = node.members || [];
      if (statements.length < 2 || !members.length) { return statements; }
      var dimensions = {};
      for (var i = 0; i < members.length; i++) {
         // No dimension names means nothing to test against — §2.1, a node
         // below the expand depth arrives with no coordinates at all.
         if (!members[i].dimension) { return statements; }
         dimensions[String(members[i].dimension).toUpperCase()] = true;
      }
      var kept = [];
      for (var s = 0; s < statements.length; s++) {
         if (statementFits(statements[s], dimensions)) { kept.push(statements[s]); }
      }
      return kept.length ? kept : statements;
   };

   /* Everything the "Calculation" section needs for one node.
    * A consolidation has no statement — its calculation is the sum of its
    * children, which is stated rather than parsed. */
   var calculationView = function (node) {
      var operands = [];
      var kids = node.children || [];

      /* Which children the cut keeps. A rule's operands are listed in the
       * order the formula reads them, so that order is the meaning and is left
       * alone. A **consolidation**'s children arrive in whatever order TM1
       * returned them, which means nothing to a reader -- so when the list is
       * about to be cut, keep the biggest contributors rather than whichever
       * ones came back first, and in the same biggest-first order the tree
       * below uses by default. */
      var listed = kids;
      if (node.type === "Consolidation" && kids.length > VALUES_SHOWN) {
         listed = kids.slice().sort(function (a, b) {
            var left = typeof a.value === "number" ? Math.abs(a.value) : -1;
            var right = typeof b.value === "number" ? Math.abs(b.value) : -1;
            return right - left;
         });
      }

      var shown = Math.min(listed.length, VALUES_SHOWN);
      for (var i = 0; i < shown; i++) {
         operands.push({
            nodeId: listed[i].id,
            label: businessLabel(listed[i], node).text,
            value: listed[i].value,
            cube: listed[i].cube !== node.cube ? listed[i].cube : null
         });
      }
      /* Counted separately from the list, because "sum of N components" is a
       * statement about the cell and must stay true when the list is cut. */
      var operandCount = kids.length;
      var operandsHidden = operandCount - operands.length;

      if (node.type === "Consolidation") {
         return {
            kind: "consolidation",
            area: null,
            tokens: [],
            operands: operands,
            operandCount: operandCount,
            operandsHidden: operandsHidden,
            statementCount: 0
         };
      }

      var statements = ownStatements(node);
      var elsewhere = (node.statements || []).length - statements.length;
      var parsed = statements.length ? parseRuleStatement(statements[0], preferredNames(node)) : null;
      if (!parsed) {
         if (!operandCount && node.type === "Simple") {
            return {
               kind: "input",
               area: null,
               tokens: [],
               operands: [],
               operandCount: 0,
               operandsHidden: 0,
               statementCount: 0
            };
         }
         return operandCount
            ? {
               kind: "unknown",
               area: null,
               tokens: [],
               operands: operands,
               operandCount: operandCount,
               operandsHidden: operandsHidden,
               statementCount: statements.length,
               statementsElsewhere: elsewhere
            }
            : null;
      }
      var tokens = calculationTokens(parsed, kids);
      /* An operand with no value means one of two very different things, and
       * "?" alone made them look the same: TM1 did not return that component,
       * or this node's children were cut off at the node budget. The second is
       * fixable by the reader — trace deeper from here — so it is named. */
      var missingWasDropped = !!node.budgetDropped;
      var dbResolved = 0;
      for (var t = 0; t < tokens.length; t++) {
         if (tokens[t].db) { dbResolved++; }
         if (tokens[t].ref && !tokens[t].matched) { tokens[t].dropped = missingWasDropped; }
      }
      return {
         kind: "rule",
         area: parsed.area,
         ruleKind: parsed.kind,
         tokens: tokens,
         operands: operands,
         operandCount: operandCount,
         operandsHidden: operandsHidden,
         /* Candidates for *this* cell — statements that belong to components
          * are counted separately, because "10 candidates" would otherwise be
          * said about a cell that has exactly one. */
         statementCount: statements.length,
         statementsElsewhere: elsewhere,
         /* Only counted so the page can explain the highlight when there is one
          * to explain — a legend for a thing not on screen is noise. */
         dbResolved: dbResolved,
         droppedChildren: node.budgetDropped || 0
      };
   };

   /* Arc's cube viewer has no plugin hook on its cell context menu, so the
    * bridge is its own "Cell Reference" entry and the clipboard.
    *
    * Three shapes are accepted. The table is the one that matters, and this is
    * exactly what Arc 5.3's dialog puts on the clipboard — three tab separated
    * columns with a header row, and the cell's value on its own line:
    *
    *      Value: 426951.0784250001
    *      Dimension           Hierarchy           Element
    *      Country and Region  Country and Region  Americas
    *      Retailers           Retailers           ALL RETAILERS
    *      ...
    *
    *   1. that table       Dimension [Hierarchy] Element per line, separated by
    *                       tabs, a colon, an equals sign or a column of spaces
    *   2. a plain list     E1, E2, E3   (tabs, pipes, commas or newlines)
    *   3. DB('Cube','E1','E2')          a rule / TI formula
    *
    * -> {cube, elements}
    *  | {cube, pairs:[{dimension, hierarchy, element}]}
    *  | null
    *
    * The element is the *last* column, not the second: a two column paste is
    * dimension + element, a three column one is dimension + hierarchy +
    * element. Reading the second column as the element is what made a pasted
    * reference trace "Country and Region = Country and Region" and fail.
    *
    * The reported hierarchy is kept and used for the trace, which is the whole
    * point of it being there — an alternate hierarchy is a coordinate the
    * primary one cannot express.
    *
    * Arc's dialog does *not* name the cube, so the cube comes from the picker;
    * a "Cube <tab> Name" line is still honoured if one ever appears. */
   var CELLREF_HEADINGS = {
      "dimension": true, "dimensions": true, "element": true, "elements": true,
      "elementname": true, "name": true, "member": true, "hierarchy": true,
      "hierarchies": true, "cell": true, "type": true, "index": true
   };

   var allHeadings = function (fields) {
      for (var i = 0; i < fields.length; i++) {
         if (!CELLREF_HEADINGS[String(fields[i]).toLowerCase()]) { return false; }
      }
      return true;
   };

   var parseCellReferenceTable = function (raw) {
      var lines = String(raw).split(/\r?\n/);
      var pairs = [];
      var cube = null;
      var unusable = 0;
      for (var i = 0; i < lines.length; i++) {
         var line = lines[i].trim();
         if (!line) { continue; }
         // Tab first (a copied table), then a colon or equals, then 2+ spaces.
         var fields = line.indexOf("\t") > -1
            ? line.split("\t")
            : (/[:=]/.test(line) ? line.split(/\s*[:=]\s*/) : line.split(/\s{2,}/));
         var cleaned = [];
         for (var f = 0; f < fields.length; f++) {
            var field = fields[f].trim().replace(/^'|'$/g, "").trim();
            if (field) { cleaned.push(field); }
         }
         if (cleaned.length < 2) { unusable++; continue; }
         if (allHeadings(cleaned)) { continue; }              // the header row
         var label = cleaned[0].toLowerCase();
         if (label === "cube") { cube = cleaned[cleaned.length - 1]; continue; }
         /* "Value: 426951.0784250001" is the cell's own value, printed above
          * the table — not a coordinate. A dimension actually named Value
          * would be collateral, which is why only a numeric right side counts. */
         if (label === "value" && cleaned.length === 2 &&
               /^-?[\d,.eE+]+$/.test(cleaned[1])) {
            continue;
         }
         pairs.push({
            dimension: cleaned[0],
            hierarchy: cleaned.length > 2 ? cleaned[1] : null,
            element: cleaned[cleaned.length - 1]
         });
      }
      // One stray line is a heading or a value row; mostly stray is not a table.
      if (pairs.length < 2 || unusable > pairs.length) { return null; }
      return { cube: cube, pairs: pairs };
   };

   var parseCellReference = function (text) {
      var raw = String(text || "").trim();
      if (!raw) { return null; }

      var dbMatch = raw.match(/^=?\s*DB\s*\(([\s\S]*)\)\s*;?$/i);
      if (dbMatch) {
         var parts = splitTop(dbMatch[1]);
         var values = [];
         for (var i = 0; i < parts.length; i++) {
            var part = parts[i].trim();
            var quoted = quotedStrings(part);
            // An unquoted argument is an expression (!dim, a variable, ATTRS...)
            // and cannot be resolved to an element here.
            if (quoted.length === 1 && part.charAt(0) === "'") {
               values.push(quoted[0]);
            } else {
               values.push(null);
            }
         }
         if (values.length < 2 || !values[0]) { return null; }
         return { cube: values[0], elements: values.slice(1) };
      }

      if (/[\r\n]/.test(raw)) {
         var table = parseCellReferenceTable(raw);
         if (table) { return table; }
      }

      // A plain list: tabs, pipes, commas or newlines. Quotes are optional.
      var listed = raw.split(/\t|\||,|\r?\n/);
      var elements = [];
      for (var j = 0; j < listed.length; j++) {
         var item = listed[j].trim().replace(/^'|'$/g, "").trim();
         if (item) { elements.push(item); }
      }
      return elements.length ? { cube: null, elements: elements } : null;
   };

   /* Arc's own trace states carry the cell in `:elements`. The real shape, taken
    * from two cells that Arc's cube viewer actually produced:
    *
    *   Country%20and%20Region:Asia%20Pacific,ID%20numbers:1,Budget%20version:Budget%20version%201,
    *   Promotions:%25%20Planned%20Promotion%20Value
    *
    * One part per dimension, each `<dimension>:<element>`, with **each side put
    * through encodeURIComponent on its own** and the parts joined by a literal
    * separator. ui-router removes one layer of percent-encoding before a hook
    * sees the value, which is why `%20` and `%25` are still in it.
    *
    * That makes the parse exact rather than a guess, and the reason is worth
    * writing down: `encodeURIComponent` escapes `,` `|` and `:` (to `%2C`,
    * `%7C`, `%3A` — checked in the running app, not assumed). So **every literal
    * comma, pipe or colon in the parameter is a delimiter** and can never be
    * part of a dimension or element name. `% Planned Promotion Value` arriving
    * as `%25%20Planned%20Promotion%20Value` is the same rule at work.
    *
    * Both `,` and `|` are accepted as the part separator: the first cell seen
    * this way was read as pipe separated and the second is comma separated, and
    * since both characters are escaped inside names, accepting either costs
    * nothing.
    *
    * Two earlier versions of this got it wrong in instructive ways. Reading the
    * parts as bare element names sent TM1 an element called
    * `Retailers:Department Store`. Splitting only on `|` made a comma separated
    * handover unreadable — which at least *declined* instead of tracing the
    * wrong cell, and put the raw string in the paste box where it could be read.
    *
    * A bare positional list (`El1|El2|El3` in cube dimension order, no colons)
    * is still accepted, since a hand-written URL can carry one.
    *
    * -> {coordinates:[{dimension, hierarchy, element}], qualified} | null
    * Null when it cannot be read with confidence, in which case Arc's own page
    * keeps the transition. */
   var decodeUriPart = function (text) {
      try { return decodeURIComponent(text); } catch (error) { return text; }
   };

   var decodeElementList = function (raw, dimensions) {
      var text = String(raw === null || raw === undefined ? "" : raw).trim();
      var dims = dimensions || [];
      if (!text || !dims.length) { return null; }

      var byName = {};
      var i;
      for (i = 0; i < dims.length; i++) { byName[String(dims[i]).toUpperCase()] = dims[i]; }

      var parts = text.split(/[,|]/);

      // --- the qualified form: every part names its own dimension ------------
      if (parts.length === dims.length) {
         var found = {};
         var qualified = true;
         for (i = 0; i < parts.length; i++) {
            var pieces = parts[i].split(":");
            // 2 is dimension + element, 3 is dimension + hierarchy + element.
            // Anything else is not this shape — a colon inside a name would
            // have arrived as %3A.
            if (pieces.length < 2 || pieces.length > 3) { qualified = false; break; }
            var dimension = decodeUriPart(pieces[0]).trim();
            var key = dimension.toUpperCase();
            if (!byName.hasOwnProperty(key) || found.hasOwnProperty(key)) { qualified = false; break; }
            var hierarchy = pieces.length === 3 ? decodeUriPart(pieces[1]).trim() : null;
            var element = decodeUriPart(pieces[pieces.length - 1]).trim();
            if (!element) { qualified = false; break; }
            found[key] = {
               dimension: byName[key],
               hierarchy: hierarchy || byName[key],
               element: element
            };
         }
         if (qualified) {
            var coordinates = [];
            for (i = 0; i < dims.length; i++) {
               var entry = found[String(dims[i]).toUpperCase()];
               if (!entry) { coordinates = null; break; }
               coordinates.push(entry);
            }
            if (coordinates) { return { coordinates: coordinates, qualified: true }; }
         }
      }

      // --- the positional fallback: bare element names, in cube order --------
      if (parts.length === dims.length) {
         var positional = [];
         var complete = true;
         for (i = 0; i < parts.length; i++) {
            var name = decodeUriPart(parts[i]).trim();
            if (!name || name.indexOf(":") > -1) { complete = false; break; }
            positional.push({ dimension: dims[i], hierarchy: dims[i], element: name });
         }
         if (complete) { return { coordinates: positional, qualified: false }; }
      }

      // A one dimensional cube: the whole string is the element name.
      if (dims.length === 1 && !/[,|:]/.test(text)) {
         return {
            coordinates: [{ dimension: dims[0], hierarchy: dims[0], element: decodeUriPart(text) }],
            qualified: false
         };
      }
      return null;
   };

   /* Read a cell out of this page's own address.
    *
    * Needed because Arc **strips a page plugin's state parameters before the page
    * is created** (§2.12, measured): the deep link routes to the right state, and
    * `$state.params` is empty by the time the controller runs. The address itself
    * is still intact while the plugin file is being loaded, so it is parsed there
    * -- from the raw hash, not from ui-router.
    *
    * `#/calculation-explorer/<instance>?cube=..&view=..&elements=..&depth=..`
    * Values are `decodeURIComponent`d once, which is exactly right: ui-router
    * wrote them with one layer of encoding over a handover string that already
    * contains its own `%20`s, so one layer comes off and the decoder gets what
    * Arc's cell menu would have given it (§2.11). */
   var parseDeepLink = function (hash, slug) {
      var text = String(hash === null || hash === undefined ? "" : hash);
      var base = "/" + (slug || "calculation-explorer") + "/";
      var at = text.indexOf(base);
      var query = text.indexOf("?");
      if (at < 0 || query < 0 || query < at) { return null; }

      var instance = text.substring(at + base.length, query);
      if (!instance) { return null; }

      var found = {};
      var pairs = text.substring(query + 1).split("&");
      for (var i = 0; i < pairs.length; i++) {
         var eq = pairs[i].indexOf("=");
         if (eq < 1) { continue; }
         var key = pairs[i].substring(0, eq);
         var value = pairs[i].substring(eq + 1);
         if (value) { found[key] = decodeUriPart(value); }
      }
      // A cube is the least a request can be: without one there is nothing to open.
      if (!found.cube) { return null; }

      var depth = parseInt(found.depth, 10);
      return {
         instance: decodeUriPart(instance),
         cube: found.cube,
         view: found.view || null,
         elementsRaw: found.elements || null,
         depth: depth > 0 ? depth : null
      };
   };

   /* The inverse of `decodeElementList`: a coordinate written the way Arc's own
    * cell menu writes one, so a link this plugin builds is read back by exactly
    * the decoder that reads Arc's handovers. Each side is encoded on its own and
    * the parts joined with a literal ",", which is safe precisely because
    * `encodeURIComponent` escapes "," "|" and ":" inside names (§2.11). */
   var encodeElementList = function (coordinates) {
      // No lodash in here: this factory is pure so the node tests can run it.
      var out = [];
      var list = coordinates || [];
      for (var i = 0; i < list.length; i++) {
         var parts = [encodeURIComponent(list[i].dimension)];
         if (list[i].hierarchy && list[i].hierarchy !== list[i].dimension) {
            parts.push(encodeURIComponent(list[i].hierarchy));
         }
         parts.push(encodeURIComponent(list[i].element));
         out.push(parts.join(":"));
      }
      return out.join(",");
   };

   /* Which of Arc's two built-in cell-menu pages this plugin takes over.
    *
    * `undefined` means "not decided yet" and the plugin exists to be used, so
    * the default is on. The feeders setting falls back to the calculation one
    * rather than to `true`, which is the whole migration story: an install from
    * before the split (v1.3.1 and earlier) has only `calcExplorerTakeover`, and
    * someone who had turned the single switch *off* means both off -- upgrading
    * must not quietly hand them a takeover they had refused.
    *
    * Anything other than an explicit `false` counts as on, because that is what
    * a checkbox writes and what an absent key means. */
   var takeoverSettings = function (prefs) {
      var p = prefs || {};
      var calculation = p.calcExplorerTakeover !== false;
      return {
         calculation: calculation,
         feeders: p.calcExplorerTakeoverFeeders === undefined
            ? calculation
            : p.calcExplorerTakeoverFeeders !== false
      };
   };

   /* Two coordinates naming the same cell. Used to decide whether a feeder
    * result still applies: those belong to a *cell*, so re-tracing the same one
    * must not throw them away. An absent hierarchy means the dimension's own. */
   var sameCoordinates = function (left, right) {
      if (!left || !right || left.length !== right.length) { return false; }
      for (var i = 0; i < left.length; i++) {
         if (left[i].dimension !== right[i].dimension) { return false; }
         if ((left[i].hierarchy || left[i].dimension) !==
             (right[i].hierarchy || right[i].dimension)) { return false; }
         if (left[i].element !== right[i].element) { return false; }
      }
      return true;
   };

   /* A component below the requested depth has no coordinates, but its rule
    * area still names the target element — far better than "(no coordinates)". */
   var unresolvedLabel = function (node) {
      var statements = node.statements || [];
      for (var i = 0; i < statements.length; i++) {
         var parsed = parseRuleStatement(statements[i]);
         if (parsed && parsed.area) { return parsed.area; }
      }
      return null;
   };

   // ---------------------------------------------------------------
   // Business view
   //
   // Same tree, plainer rendering. Three things do the work: only the part of
   // the coordinate that *changed* is shown, one branch is open at a time, and
   // the technical detail moves behind a toggle.
   // ---------------------------------------------------------------

   var namesOnly = function (node) {
      if (node.members && node.members.length) {
         var names = [];
         for (var i = 0; i < node.members.length; i++) { names.push(node.members[i].name); }
         return names.join("  ·  ");
      }
      if (node.tuple) { return node.tuple.join("  ·  "); }
      return null;
   };

   /* The members that differ from the parent — "Feb", not
    * "Asia Pacific, 1, Budget version 1, Base Monthly Sales". Null when it
    * cannot be worked out (different cube, different arity, or nothing
    * changed).
    *
    * A step can also change *hierarchy* while keeping the element name, which
    * used to read as "nothing changed" and fall back to the whole coordinate.
    * That step is real — it is how a rule reaches a YTD or alternate rollup —
    * so it is labelled as a hierarchy switch. */
   var deltaLabel = function (node, parent) {
      if (!parent || !node.members || !parent.members) { return null; }
      if (node.cube !== parent.cube) { return null; }
      if (node.members.length !== parent.members.length) { return null; }
      var changed = [];
      for (var i = 0; i < node.members.length; i++) {
         var mine = node.members[i];
         var theirs = parent.members[i];
         var sameName = mine.name === theirs.name;
         var sameHierarchy = (mine.hierarchy || null) === (theirs.hierarchy || null);
         if (sameName && sameHierarchy) { continue; }
         changed.push({ member: mine, hierarchyOnly: sameName });
      }
      if (!changed.length) { return null; }
      var parts = [];
      for (var c = 0; c < changed.length; c++) {
         var member = changed[c].member;
         var alternate = member.hierarchy && member.dimension && member.hierarchy !== member.dimension;
         if (changed[c].hierarchyOnly) {
            parts.push(member.name + " (" + (member.hierarchy || "primary") + " hierarchy)");
         } else {
            parts.push(alternate ? member.name + " (" + member.hierarchy + ")" : member.name);
         }
      }
      return parts.join("  ·  ");
   };

   /* {text, cubeNote, whole} — `whole` marks a label that is the full
    * coordinate rather than a delta, so the UI can style it differently. */
   var businessLabel = function (node, parent) {
      var delta = deltaLabel(node, parent);
      if (delta) { return { text: delta, cubeNote: null, whole: false }; }
      var cubeNote = (parent && node.cube && parent.cube && node.cube !== parent.cube)
         ? node.cube
         : null;
      var plain = namesOnly(node);
      if (plain) { return { text: plain, cubeNote: cubeNote, whole: true }; }
      // No coordinates came back for this level. Fall back to what the rule
      // itself says it writes to, and mark the label as approximate.
      var fromRule = unresolvedLabel(node);
      return {
         text: fromRule || "one level deeper",
         cubeNote: cubeNote,
         whole: true,
         approximate: true
      };
   };

   // "0.1.2" -> ["0", "0.1", "0.1.2"]
   var openPathIds = function (id) {
      var parts = String(id === null || id === undefined ? "0" : id).split(".");
      var ids = [];
      var accumulated = null;
      for (var i = 0; i < parts.length; i++) {
         accumulated = accumulated === null ? parts[0] : accumulated + "." + parts[i];
         ids.push(accumulated);
      }
      return ids;
   };

   // Accordion: exactly the nodes on `ids` are open, everything else shuts.
   var applyOpenPath = function (root, ids) {
      var open = { "0": true };
      for (var i = 0; i < (ids || []).length; i++) { open[ids[i]] = true; }
      visitTree(root, function (node) { node.expanded = !!open[node.id]; });
   };

   // ---------------------------------------------------------------
   // Text / markdown report
   // ---------------------------------------------------------------

   var buildTextReport = function (payload) {
      var lines = [];
      lines.push("Calculation trace — " + payload.cube);
      lines.push(repeat("=", ("Calculation trace — " + payload.cube).length));
      lines.push("Instance : " + payload.instance);
      lines.push("Cell     : " + payload.coordinateLabel);
      lines.push("Value    : " + formatValue(payload.root.value));
      lines.push("Depth    : " + payload.depth + "   Nodes: " + payload.stats.nodeCount +
         "   Max depth reached: " + payload.stats.maxDepth);
      lines.push("Traced   : " + payload.generatedAt);
      lines.push("");

      var write = function (node, prefix, isLast, isRoot) {
         var branch = isRoot ? "" : (prefix + (isLast ? "\\-- " : "|-- "));
         var label = node.resolved
            ? (node.cube + " :: " + (node.coordinateLabel || (node.tuple || []).join(" | ")))
            : "(coordinates not resolved — trace deeper to label)";
         var share = node.share === null || node.share === undefined
            ? ""
            : "  [" + (node.share * 100).toFixed(1) + "% of parent]";
         lines.push(branch + "[" + node.typeMeta.label + "] " + label +
            " = " + formatValue(node.value) + share);

         var childPrefix = isRoot ? "" : prefix + (isLast ? "    " : "|   ");
         var i;
         for (i = 0; i < node.statementInfo.length; i++) {
            var info = node.statementInfo[i];
            var where = info.location
               ? ("rules line " + info.location.line + (info.location.comment ? " — " + info.location.comment : ""))
               : "rule statement";
            lines.push(childPrefix + "    . " + where);
            var body = (info.location && info.location.source ? info.location.source : info.formatted).split(/\r?\n/);
            for (var b = 0; b < body.length; b++) {
               lines.push(childPrefix + "      " + body[b]);
            }
         }
         if (node.childTruncated) {
            lines.push(childPrefix + "    . (" + node.childTruncated + " more components not shown)");
         }
         for (i = 0; i < node.children.length; i++) {
            write(node.children[i], childPrefix, i === node.children.length - 1, false);
         }
      };

      write(payload.root, "", true, true);
      return lines.join("\n");
   };

   // ---------------------------------------------------------------
   // Interactive HTML report — one self-contained file, no CDN, no server
   // ---------------------------------------------------------------

   var HTML_STYLE = [
      ":root{--bg:#f7f8fa;--panel:#fff;--ink:#1f2933;--muted:#6b7785;--line:#dfe3e8;",
      "--rule:#7b4fbf;--cons:#1d7fbf;--simple:#3f8f4f;--other:#8a8f98;--accent:#0b6bcb;--bar:#cfe2f7;--zero:#a3a9b3}",
      "@media (prefers-color-scheme:dark){:root{--bg:#14171c;--panel:#1c2027;--ink:#e6e9ee;--muted:#9aa4b1;",
      "--line:#2c323b;--rule:#b28ce8;--cons:#68b6ef;--simple:#79c98a;--other:#98a0ab;--accent:#5aa9f7;--bar:#24405e;--zero:#6f7783}}",
      "*{box-sizing:border-box}",
      "body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif}",
      ".wrap{max-width:1400px;margin:0 auto;padding:24px 20px 64px}",
      "h1{font-size:20px;margin:0 0 4px}",
      ".sub{color:var(--muted);font-size:13px;margin-bottom:18px}",
      ".meta{display:flex;flex-wrap:wrap;gap:8px 28px;background:var(--panel);border:1px solid var(--line);",
      "border-radius:8px;padding:14px 16px;margin-bottom:16px}",
      ".meta div{font-size:13px}.meta b{display:block;color:var(--muted);font-weight:600;font-size:11px;",
      "text-transform:uppercase;letter-spacing:.04em}",
      ".cards{display:flex;flex-wrap:wrap;gap:12px;margin-bottom:16px}",
      ".card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:10px 14px;min-width:110px}",
      ".card span{display:block;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.04em}",
      ".card strong{font-size:19px;font-weight:600}",
      ".tools{display:flex;flex-wrap:wrap;gap:8px;align-items:center;background:var(--panel);border:1px solid var(--line);",
      "border-radius:8px;padding:10px 12px;margin-bottom:8px;position:sticky;top:0;z-index:5}",
      "input[type=text],select{background:var(--bg);color:var(--ink);border:1px solid var(--line);border-radius:5px;",
      "padding:6px 9px;font:inherit;font-size:13px}",
      "input[type=text]{min-width:230px}",
      "button{background:var(--panel);color:var(--ink);border:1px solid var(--line);border-radius:5px;padding:6px 11px;",
      "font:inherit;font-size:13px;cursor:pointer}button:hover{border-color:var(--accent);color:var(--accent)}",
      "label.chk{font-size:13px;color:var(--muted);display:flex;align-items:center;gap:5px;cursor:pointer}",
      ".chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px}",
      ".chip{background:var(--panel);border:1px solid var(--line);border-radius:20px;padding:3px 11px;font-size:12px;cursor:pointer}",
      ".chip.on{border-color:var(--accent);color:var(--accent)}",
      ".tree{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:8px 6px}",
      ".n{margin-left:16px}.tree>.n{margin-left:0}",
      ".hd{display:flex;align-items:baseline;gap:8px;padding:4px 6px;border-radius:5px;cursor:default}",
      ".hd:hover{background:rgba(127,127,127,.09)}",
      ".n.hit>.hd{box-shadow:inset 2px 0 0 var(--accent)}",
      ".tw{width:14px;flex:0 0 14px;color:var(--muted);cursor:pointer;user-select:none;font-size:11px;text-align:center}",
      ".n.leaf>.hd>.tw{visibility:hidden}",
      ".bdg{flex:0 0 auto;font-size:10.5px;font-weight:700;letter-spacing:.03em;text-transform:uppercase;",
      "border:1px solid currentColor;border-radius:4px;padding:0 5px;line-height:16px}",
      ".t-Rule{color:var(--rule)}.t-Consolidation{color:var(--cons)}.t-Simple{color:var(--simple)}.t-Unknown{color:var(--other)}",
      ".loc{flex:1 1 auto;min-width:0;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12.5px;",
      "overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".loc em{color:var(--muted);font-style:normal}",
      ".cubehop{color:var(--accent);font-weight:600}",
      ".val{flex:0 0 auto;font-variant-numeric:tabular-nums;font-weight:600;min-width:110px;text-align:right}",
      ".val.z{color:var(--zero);font-weight:400}",
      ".shr{flex:0 0 62px;text-align:right;color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums}",
      ".bar{height:3px;background:var(--bar);border-radius:2px;margin:0 6px 3px 28px;max-width:420px}",
      ".bar i{display:block;height:3px;background:var(--accent);border-radius:2px}",
      ".det{margin:2px 6px 8px 28px;font-size:12.5px}",
      ".coords{color:var(--muted);margin-bottom:6px}",
      ".stmt{border:1px solid var(--line);border-left:3px solid var(--rule);border-radius:5px;margin:6px 0;overflow:hidden}",
      ".stmt .where{background:rgba(127,127,127,.08);padding:4px 9px;font-size:11.5px;color:var(--muted)}",
      ".stmt .where b{color:var(--ink)}",
      ".stmt pre{margin:0;padding:9px;overflow-x:auto;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;",
      "font-size:12px;line-height:1.55;white-space:pre}",
      ".kids{border-left:1px dotted var(--line);margin-left:7px}",
      ".n.col>.kids,.n.col>.det,.n.col>.bar{display:none}",
      ".hidden{display:none!important}",
      ".unres{color:var(--muted);font-style:italic}",
      ".tk-str{color:var(--simple)}.tk-cmt{color:var(--muted);font-style:italic}.tk-fn{color:var(--cons);font-weight:600}",
      ".tk-ref{color:var(--rule)}.tk-num{color:var(--accent)}.tk-area{color:var(--rule);font-weight:600}",
      "footer{color:var(--muted);font-size:12px;margin-top:22px}",
      "@media print{.tools,.chips{display:none}.n.col>.kids{display:block}body{background:#fff}}",
      ".modes{display:inline-flex;border:1px solid var(--line);border-radius:5px;overflow:hidden}",
      ".modes button{border:0;border-radius:0;background:var(--panel);padding:6px 12px}",
      ".modes button.on{background:var(--accent);color:#fff}",
      ".crumbs{padding:9px 12px;background:var(--panel);border:1px solid var(--line);border-bottom:0;",
      "border-radius:8px 8px 0 0;font-size:13px}",
      ".crumbs a{color:var(--accent);text-decoration:none;cursor:pointer}",
      ".crumbs .cv{color:var(--muted);font-variant-numeric:tabular-nums;margin-left:5px}",
      ".crumbs .sep{color:var(--muted);margin:0 7px}",
      "body.bus .tree{border-radius:0 0 8px 8px}",
      "body.bus .n{margin-left:0}",
      ".brow{display:flex;align-items:center;gap:12px;padding:9px 14px;border-radius:5px;cursor:pointer}",
      ".brow:hover{background:rgba(127,127,127,.09)}",
      ".brow.open{background:rgba(11,107,203,.09);font-weight:600}",
      ".brow .bc{flex:0 0 14px;color:var(--muted);font-size:11px;text-align:center}",
      ".brow .bl{flex:1 1 auto;min-width:0;font-size:14.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".brow .bl small{color:var(--muted);font-weight:400;font-size:11.5px}",
      ".brow .bb{flex:0 0 140px;height:9px;background:var(--bar);border-radius:5px;overflow:hidden}",
      ".brow .bb i{display:block;height:9px;background:var(--accent);border-radius:5px}",
      ".brow .bs{flex:0 0 46px;text-align:right;color:var(--muted);font-size:12.5px;font-variant-numeric:tabular-nums}",
      ".brow .bv{flex:0 0 130px;text-align:right;font-size:14.5px;font-variant-numeric:tabular-nums}",
      ".brow .bv.z{color:var(--zero)}",
      ".bwhy{flex:0 0 auto;font-size:11.5px;font-weight:600;color:var(--accent);cursor:pointer;user-select:none;",
      "background:rgba(11,107,203,.10);border:1px solid rgba(11,107,203,.38);border-radius:11px;padding:1px 10px}",
      ".bwhy:hover{background:rgba(11,107,203,.20)}",
      ".bwhy.on{background:var(--accent);border-color:var(--accent);color:#fff}",
      ".bdet{margin:4px 0 10px 40px;padding:9px 11px;background:rgba(127,127,127,.06);",
      "border:1px solid var(--line);border-radius:5px;font-size:12px}",
      ".bzero{margin-left:40px;font-size:11.5px;color:var(--zero);font-style:italic}",
      ".sec{margin-bottom:10px}",
      ".sec h6{margin:0 0 5px;font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}",
      ".sec h6 a{font-weight:400;letter-spacing:0;text-transform:none;color:var(--accent);cursor:pointer}",
      ".cgrid{display:flex;flex-wrap:wrap;gap:4px 6px}",
      ".cg{background:var(--panel);border:1px solid var(--line);border-radius:4px;padding:1px 8px;font-size:11.5px}",
      ".cg b{color:var(--muted);font-weight:500}",
      ".fx{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12.5px;line-height:2.1;word-break:break-word}",
      ".fx .tgt{font-weight:700;color:var(--rule)}",
      ".rf{display:inline-block;border:1px solid var(--line);background:rgba(11,107,203,.07);border-radius:4px;padding:0 2px 0 6px;white-space:nowrap}",
      ".rf.miss{background:rgba(217,164,65,.14)}",
      // one argument per dimension of the cube being read — too wide to hold on one line
      ".rf.db{white-space:normal}",
      ".sb{padding:0 3px;border-radius:2px;background:rgba(47,125,67,.12);color:#2f7d43;font-weight:600}",
      ".rv{display:inline-block;margin-left:5px;padding:0 5px;border-radius:3px;background:var(--accent);color:#fff;font-weight:600}",
      ".rf.miss .rv{background:#d9a441}",
      ".vr{display:flex;gap:10px;font-size:12px;padding:2px 0;border-bottom:1px dotted var(--line)}",
      ".vr span:first-child{flex:1 1 auto;min-width:0}",
      ".vr span:last-child{flex:0 0 130px;text-align:right;font-variant-numeric:tabular-nums}",
      ".vr em{color:var(--muted);font-style:normal;font-size:11px}",
      ".note{font-size:11px;color:var(--muted)}",
      ".approx{font-style:italic;color:#a3813f}",
      ".inp{display:inline-block;margin-left:6px;padding:0 6px;border:1px solid var(--simple);",
      "border-radius:9px;font-size:10px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--simple)}",
      ".note.stored{color:var(--simple)}.note.cut{color:#a3813f}"
   ].join("");

   var HTML_SCRIPT = [
      "(function(){",
      "var D=window.TRACE,root=document.getElementById('tree');",
      "var esc=function(t){return String(t==null?'':t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');};",
      "var hi=function(s){var re=/('(?:''|[^'])*')|(#[^\\n]*)|(![A-Za-z0-9_ ]+)|(\\[[^\\]]*\\])|(\\b\\d+(?:\\.\\d+)?\\b)|([A-Za-z_][A-Za-z0-9_]*)(?=\\s*\\()/g;",
      "var out='',last=0,m;while((m=re.exec(s))!==null){out+=esc(s.slice(last,m.index));",
      "var cls=m[1]?'tk-str':m[2]?'tk-cmt':m[3]?'tk-ref':m[4]?'tk-area':m[5]?'tk-num':'tk-fn';",
      "out+='<span class=\"'+cls+'\">'+esc(m[0])+'</span>';last=re.lastIndex;}",
      "return out+esc(s.slice(last));};",
      "var fmt=function(v){if(v===null||v===undefined)return '(empty)';if(typeof v!=='number')return esc(v);",
      "if(v===0)return '0';var a=Math.abs(v),d=a>=1000?0:(a>=1?2:6),p=String(Number(v.toFixed(d))).split('.');",
      "p[0]=p[0].replace(/\\B(?=(\\d{3})+(?!\\d))/g,',');return p.join('.');};",
      "var detail=function(n){var h='';",
      "h+='<div class=\"sec\"><h6>Cell'+(n.cube?' &middot; '+esc(n.cube):'')+",
      "(n.input?'<span class=\"inp\" title=\"Typed in or loaded, not calculated\">input</span>':'')+'</h6>';",
      "if(n.members&&n.members.length){h+='<div class=\"cgrid\">';",
      "for(var m=0;m<n.members.length;m++){var mm=n.members[m];",
      "h+='<span class=\"cg\"><b>'+esc(mm.dimension||'?')+(mm.hierarchy&&mm.hierarchy!==mm.dimension?':'+esc(mm.hierarchy):'')+' =</b> '+esc(mm.name)+'</span>';}",
      "h+='</div>';}",
      "else{h+='<div class=\"approx\">named from the rule, not from returned coordinates</div>';}",
      "h+='</div>';",
      "if(n.calc){h+='<div class=\"sec\"><h6>Calculation</h6><div class=\"fx\">';",
      "if(n.calc.kind==='consolidation'){h+='Sum of <b>'+(n.calc.operandCount||n.calc.operands.length)+'</b> components';}",
      "else if(n.calc.kind==='rule'){h+='<span class=\"tgt\">'+esc(n.calc.area||'')+'</span> = ';",
      "for(var t2=0;t2<n.calc.tokens.length;t2++){var tk=n.calc.tokens[t2];",
      "if(tk.ref===undefined){h+=esc(tk.text);}",
      /* A lookup's arguments are rendered part by part so the substituted ones
       * can be marked: the reader has to be able to see which coordinates came
       * out of the component and which the rule spelled out. */
      "else{var inner='';if(tk.parts){for(var p2=0;p2<tk.parts.length;p2++){var pt=tk.parts[p2];",
      "inner+=pt.sub===undefined?esc(pt.text):('<span class=\"sb\" title=\"'+esc(pt.from||'')+'\">'+esc(pt.sub)+'</span>');}}",
      "else{inner=esc(tk.ref);}",
      "h+='<span class=\"rf'+(tk.matched?'':' miss')+(tk.db?' db':'')+'\">'+inner+'<span class=\"rv\">'+(tk.matched?fmt(tk.value):'?')+'</span></span>';}}}",
      "else if(n.calc.kind==='input'){h+='<span class=\"note stored\">A stored input cell &mdash; the value was typed in or loaded, not calculated. The trace stops here.</span>';}",
      "else{h+='No rule statement was returned for this cell &mdash; its value is stored.';}",
      "h+='</div>';",
      "if(n.calc.kind==='rule'){h+='<div class=\"note\">the backslash is TM1\u2019s zero-safe divide</div>';}",
      "if(n.calc.dbResolved){h+='<div class=\"note\">a highlighted coordinate inside a DB( ) lookup is the element TM1 reported for it, standing where the rule wrote a !dimension or a call \u2014 hover it to see what it replaced</div>';}",
      "if(n.calc.statementCount>1){h+='<div class=\"note\">TM1 returned '+n.calc.statementCount+' candidate statements for this cell and does not say which one fired \u2014 the first is shown</div>';}",
      "if(n.calc.statementsElsewhere){h+='<div class=\"note\">'+n.calc.statementsElsewhere+' more statements came back with this cell, each naming a dimension this cube does not have \u2014 they belong to components of this cell rather than to the cell, so they are not read as its formula. They are still listed under Rule below.</div>';}",
      "if(n.calc.droppedChildren){h+='<div class=\"note cut\">An operand shown as ? was left out at the size limit, not missing from TM1 \u2014 re-trace this node in Arc to fetch it</div>';}",
      "h+='</div>';",
      "if(n.calc.operands.length){h+='<div class=\"sec\"><h6>Values used</h6>';",
      "for(var o=0;o<n.calc.operands.length;o++){var op=n.calc.operands[o];",
      "h+='<div class=\"vr\"><span>'+esc(op.label)+(op.cube?' <em>&mdash; from '+esc(op.cube)+'</em>':'')+'</span><span>'+fmt(op.value)+'</span></div>';}",
      "if(n.calc.operandsHidden){h+='<div class=\"note\">'+n.calc.operandsHidden.toLocaleString()+' smaller components are not listed here — drill into this row to see them</div>';}",
      "h+='</div>';}}",
      "if((n.stmts||[]).length){h+='<div class=\"sec\"><h6>Rule <a data-rule=\"'+n.id+'\">show / hide</a></h6>';",
      "h+='<div data-rulebody=\"'+n.id+'\" style=\"display:none\">';",
      "for(var s3=0;s3<n.stmts.length;s3++){h+='<div class=\"stmt\"><div class=\"where\">'+n.stmts[s3].where+'</div><pre>'+hi(n.stmts[s3].body)+'</pre></div>';}",
      "h+='</div></div>';}",
      "return h;};",
      "var nodeHtml=function(n,parentCube){",
      "var kids=n.children||[],leaf=!kids.length&&!n.bound;",
      "var h='<div class=\"n'+(leaf?' leaf':'')+(n.collapsed?' col':'')+'\" data-id=\"'+n.id+'\" data-cube=\"'+esc(n.cube||'')+'\"'+",
      "' data-zero=\"'+(n.zero?1:0)+'\" data-rule=\"'+(n.statements&&n.statements.length?1:0)+'\">';",
      "var loc=n.resolved?((n.cube!==parentCube?'<span class=\"cubehop\">'+esc(n.cube)+'</span>':esc(n.cube))+' <em>::</em> '+esc(n.label||''))",
      ":'<span class=\"unres\">coordinates not resolved &mdash; re-trace from the parent to label this level</span>';",
      "h+='<div class=\"hd\"><span class=\"tw\">'+(leaf?'':(n.collapsed?'\\u25B8':'\\u25BE'))+'</span>'+",
      "'<span class=\"bdg t-'+esc(n.type)+'\">'+esc(n.typeLabel)+'</span>'+",
      "'<span class=\"loc\">'+loc+'</span>'+",
      "'<span class=\"val'+(n.zero?' z':'')+'\">'+fmt(n.value)+'</span>'+",
      "'<span class=\"shr\">'+(n.share==null?'':(n.share*100).toFixed(1)+'%')+'</span></div>';",
      "if(n.absShare!=null){h+='<div class=\"bar\"><i style=\"width:'+Math.max(1,Math.round(n.absShare*100))+'%\"></i></div>';}",
      "var det=detail(n);",
      "if(n.truncated){det+='<div class=\"coords\">'+n.truncated+' more components not shown (capped for size)</div>';}",
      "if(n.dropped){det+='<div class=\"coords\">'+n.dropped.toLocaleString()+' components below this point were left out at the size limit</div>';}",
      "if(n.bound){det+='<div class=\"coords\">This is as deep as the trace went &mdash; the components below were not fetched, so they are not missing from TM1.</div>';}",
      "if(det){h+='<div class=\"det\">'+det+'</div>';}",
      "if(!leaf&&kids.length){h+='<div class=\"kids\">';for(var i=0;i<kids.length;i++){h+=nodeHtml(kids[i],n.cube);}h+='</div>';}",
      "return h+'</div>';};",
      "root.innerHTML=nodeHtml(D.tree,D.tree.cube);",
      "root.addEventListener('click',function(e){var t=e.target;",
      "if(t.className==='tw'){var n=t.closest('.n');if(n&&!/(^| )leaf( |$)/.test(n.className)){n.classList.toggle('col');",
      "t.textContent=n.classList.contains('col')?'\\u25B8':'\\u25BE';}}});",
      "var all=function(){return Array.prototype.slice.call(root.querySelectorAll('.n'));};",
      "var setCol=function(v){all().forEach(function(n){if(/(^| )leaf( |$)/.test(n.className))return;",
      "n.classList.toggle('col',v);var tw=n.querySelector('.tw');if(tw)tw.textContent=v?'\\u25B8':'\\u25BE';});};",
      "document.getElementById('expand').onclick=function(){setCol(false);};",
      "document.getElementById('collapse').onclick=function(){setCol(true);};",
      "var apply=function(){var q=document.getElementById('q').value.toLowerCase();",
      "var hz=document.getElementById('hz').checked,ro=document.getElementById('ro').checked;",
      "var cube=document.getElementById('cf').value;",
      "var keep={};var nodes=all();",
      "nodes.forEach(function(n){n.classList.remove('hit');});",
      "for(var i=nodes.length-1;i>=0;i--){var n=nodes[i];",
      "var ok=true;",
      "if(hz&&n.getAttribute('data-zero')==='1')ok=false;",
      "if(ro&&n.getAttribute('data-rule')!=='1')ok=false;",
      "if(cube&&n.getAttribute('data-cube')!==cube)ok=false;",
      "if(q&&(n.querySelector('.hd').textContent+' '+(n.querySelector('.det')?n.querySelector('.det').textContent:'')).toLowerCase().indexOf(q)===-1)ok=false;",
      "if(ok&&q)n.classList.add('hit');",
      "var kid=false,ks=n.querySelector(':scope>.kids');",
      "if(ks){Array.prototype.slice.call(ks.children).forEach(function(c){if(keep[c.getAttribute('data-id')])kid=true;});}",
      "keep[n.getAttribute('data-id')]=ok||kid;",
      "n.classList.toggle('hidden',!(ok||kid));",
      "if(kid&&(q||hz||ro||cube))n.classList.remove('col');}",
      "};",
      "['q','hz','ro','cf'].forEach(function(id){var el=document.getElementById(id);",
      "el.addEventListener(el.tagName==='INPUT'&&el.type==='text'?'input':'change',apply);});",
      "document.getElementById('copy').onclick=function(){var ta=document.createElement('textarea');",
      "ta.value=D.text;document.body.appendChild(ta);ta.select();try{document.execCommand('copy');",
      "this.textContent='Copied';}catch(err){this.textContent='Copy failed';}document.body.removeChild(ta);",
      "var b=this;setTimeout(function(){b.textContent='Copy as text';},1600);};",
      "document.addEventListener('keydown',function(e){if(e.key==='/'&&e.target.tagName!=='INPUT'){",
      "e.preventDefault();document.getElementById('q').focus();}});",
      "var openPath=['0'];",
"/* Which Why? panels are open, seeded on the root -- the traced cell is the",
"   one the reader came for. Kept as state rather than written into the row,",
"   because renderBusiness() rebuilds every row on each drill and a reader who",
"   closed the root's panel must not have it reopened under them. */",
"var whyOpen={'0':true};",
"var byId={};(function idx(n){byId[n.id]=n;(n.children||[]).forEach(idx);})(D.tree);",
"var pathIds=function(id){var p=String(id).split('.'),a=null,o=[];",
"for(var i=0;i<p.length;i++){a=a===null?p[0]:a+'.'+p[i];o.push(a);}return o;};",
"var sortKids=function(k){return k.slice().sort(function(a,b){",
"var av=typeof a.value==='number'?Math.abs(a.value):-1,bv=typeof b.value==='number'?Math.abs(b.value):-1;",
"return bv-av;});};",
"var brow=function(n,depth,open){",
"var kids=n.children||[],deeper=kids.length>0;",
"var caret=deeper?(open?'\\u25BE':'\\u25B8'):'\\u25CB';",
"var h='<div class=\"brow'+(open?' open':'')+'\" data-id=\"'+n.id+'\" style=\"margin-left:'+(depth*22)+'px\">';",
"h+='<span class=\"bc\">'+caret+'</span><span class=\"bl\">'+esc(n.btext||'')+",
"(n.input?'<span class=\"inp\" title=\"Typed in or loaded, not calculated\">input</span>':'')+",
"(n.bcube?' <small>&mdash; from '+esc(n.bcube)+'</small>':'')+'</span>';",
"h+=(n.absShare!=null?'<span class=\"bb\"><i style=\"width:'+Math.max(1,Math.round(n.absShare*100))+'%\"></i></span>':'<span class=\"bb\"></span>');",
"h+='<span class=\"bs\">'+(n.share==null?'':Math.round(n.share*100)+'%')+'</span>';",
"h+='<span class=\"bv'+(n.zero?' z':'')+'\">'+fmt(n.value)+'</span>';",
"var wo=!!whyOpen[n.id];",
"h+='<span class=\"bwhy'+(wo?' on':'')+'\" data-why=\"'+n.id+'\" title=\"Show how this number was worked out\">'+(wo?'Hide':'Why?')+'</span></div>';",
"h+='<div class=\"bdet\" data-det=\"'+n.id+'\" style=\"display:'+(wo?'block':'none')+';margin-left:'+(depth*22+40)+'px\">'+detail(n)+'</div>';",
"if(open&&deeper){var vis=sortKids(kids).filter(function(c){return !c.zero;});",
"var hidden=kids.length-vis.length;var nextId=null;",
"var chain=pathIds(openPath[openPath.length-1]);",
"var pos=chain.indexOf(n.id);if(pos>-1&&pos+1<chain.length){nextId=chain[pos+1];}",
"for(var v=0;v<vis.length;v++){h+=brow(vis[v],depth+1,vis[v].id===nextId);}",
"if(hidden){h+='<div class=\"bzero\" style=\"margin-left:'+((depth+1)*22+40)+'px\">+ '+hidden+' with no value</div>';}}",
"return h;};",
"var renderBusiness=function(){",
"var chain=pathIds(openPath[openPath.length-1]);",
"var cr=[];for(var i=0;i<chain.length;i++){var nd=byId[chain[i]];if(!nd)continue;",
"cr.push('<a data-jump=\"'+nd.id+'\">'+esc(i===0?(D.rootLabel||nd.btext):nd.btext)+'</a><span class=\"cv\">'+fmt(nd.value)+'</span>');}",
"document.getElementById('crumbs').innerHTML=cr.join('<span class=\"sep\">&rsaquo;</span>');",
"root.innerHTML=brow(D.tree,0,true);};",
"var renderTechnical=function(){document.getElementById('crumbs').innerHTML='';",
"root.innerHTML=nodeHtml(D.tree,D.tree.cube);};",
"var mode='business';",
"var setMode=function(m){mode=m;document.body.classList.toggle('bus',m==='business');",
"document.getElementById('mbus').classList.toggle('on',m==='business');",
"document.getElementById('mtec').classList.toggle('on',m==='technical');",
"['q','cf'].forEach(function(id){document.getElementById(id).style.display=m==='business'?'none':'';});",
"document.getElementById('hz').parentNode.style.display=m==='business'?'none':'';",
"document.getElementById('ro').parentNode.style.display=m==='business'?'none':'';",
"document.getElementById('expand').style.display=m==='business'?'none':'';",
"document.getElementById('collapse').style.display=m==='business'?'none':'';",
"if(m==='business'){renderBusiness();}else{renderTechnical();}};",
"document.getElementById('mbus').onclick=function(){setMode('business');};",
"document.getElementById('mtec').onclick=function(){setMode('technical');};",
      "root.addEventListener('click',function(e){",
      "var rule=e.target.closest?e.target.closest('[data-rule]'):null;",
      "if(rule){var rb=root.querySelector('[data-rulebody=\"'+rule.getAttribute('data-rule')+'\"]');",
      "if(rb){rb.style.display=rb.style.display==='none'?'block':'none';}return;}",
      "if(mode!=='business')return;",
"var why=e.target.closest?e.target.closest('[data-why]'):null;",
"if(why){var wid=why.getAttribute('data-why');var d=root.querySelector('[data-det=\"'+wid+'\"]');",
"if(d){var shown=d.style.display==='none';d.style.display=shown?'block':'none';",
"whyOpen[wid]=shown;",
"why.classList.toggle('on',shown);why.textContent=shown?'Hide':'Why?';}return;}",
"var row=e.target.closest?e.target.closest('.brow'):null;if(!row)return;",
"var id=row.getAttribute('data-id');var chain=pathIds(openPath[openPath.length-1]);",
"if(chain.indexOf(id)>-1&&(byId[id].children||[]).length){var p=pathIds(id);p.pop();",
"openPath=[p.length?p[p.length-1]:'0'];}else{openPath=[id];}renderBusiness();});",
"document.getElementById('crumbs').addEventListener('click',function(e){",
"var a=e.target.closest?e.target.closest('[data-jump]'):null;if(!a)return;",
"openPath=[a.getAttribute('data-jump')];renderBusiness();});",
"setMode('business');",
"})();"
   ].join("");

   // Strip the tree down to what the export page needs, pre-rendering labels.
   var exportNode = function (node, dimensionsByCube, parent) {
      var statements = [];
      for (var i = 0; i < node.statementInfo.length; i++) {
         var info = node.statementInfo[i];
         var where = "rule statement";
         if (info.location) {
            where = "rules line <b>" + info.location.line + "</b>";
            if (info.location.comment) { where += " &mdash; " + escapeHtml(info.location.comment); }
            if (info.location.matches > 1) { where += " (" + info.location.matches + " identical statements in the rule file)"; }
         }
         statements.push({
            where: where,
            body: info.location && info.location.source ? info.location.source : info.formatted
         });
      }
      // Wide separator: the header line ellipsises, this one wraps.
      var coordRows = node.resolved ? coordinateLabel(node, dimensionsByCube, "   |   ") : null;
      var business = businessLabel(node, parent);
      var calculation = calculationView(node);
      var zeroChildren = 0;
      for (var z = 0; z < node.children.length; z++) {
         if (node.children[z].zero) { zeroChildren++; }
      }

      var out = {
         id: node.id,
         btext: business.text,
         bcube: business.cubeNote,
         bapprox: !!business.approximate,
         calc: calculation ? {
            kind: calculation.kind,
            area: calculation.area || null,
            tokens: calculation.tokens,
            // The list, and the size of the thing it was cut from.
            operands: calculation.operands,
            operandCount: calculation.operandCount || 0,
            operandsHidden: calculation.operandsHidden || 0,
            statementCount: calculation.statementCount || 0,
            statementsElsewhere: calculation.statementsElsewhere || 0,
            dbResolved: calculation.dbResolved || 0,
            droppedChildren: calculation.droppedChildren || 0
         } : null,
         members: node.members || null,
         zeroChildren: zeroChildren,
         type: node.type,
         typeLabel: node.typeMeta.label,
         input: !!node.typeMeta.input,
         value: node.value,
         zero: node.zero,
         cube: node.cube,
         label: node.coordinateLabel || (node.tuple || []).join(" | "),
         resolved: node.resolved,
         share: node.share,
         absShare: node.absShare,
         statements: node.statements,
         stmts: statements,
         coordRows: coordRows,
         truncated: node.childTruncated,
         dropped: node.budgetDropped || 0,
         /* The exported page draws its own tree, so it needs the frontier flag
          * too -- otherwise a saved export shows a bounded node as a finished
          * leaf, with no twisty and no note, which is the one lie the in-app
          * views were fixed not to tell (4u). */
         bound: !!node.belowBound,
         collapsed: node.depth >= 2 && node.children.length > 0,
         children: []
      };
      for (var c = 0; c < node.children.length; c++) {
         out.children.push(exportNode(node.children[c], dimensionsByCube, node));
      }
      return out;
   };

   var jsonForScript = function (value) {
      return JSON.stringify(value)
         .replace(/</g, "\\u003c")
         .replace(/>/g, "\\u003e")
         .replace(/&/g, "\\u0026")
         .replace(/\u2028/g, "\\u2028")
         .replace(/\u2029/g, "\\u2029");
   };

   var buildHtmlReport = function (payload) {
      var cubeNames = [];
      for (var name in payload.stats.cubes) {
         if (payload.stats.cubes.hasOwnProperty(name)) { cubeNames.push(name); }
      }
      cubeNames.sort();

      var data = {
         tree: exportNode(payload.root, payload.dimensionsByCube, null),
         rootLabel: payload.cube,
         text: buildTextReport(payload)
      };

      var title = "Calculation trace — " + payload.cube + " :: " + payload.coordinateLabel;
      var html = [];
      html.push("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">");
      html.push("<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">");
      html.push("<title>" + escapeHtml(title) + "</title><style>" + HTML_STYLE + "</style></head><body><div class=\"wrap\">");
      html.push("<h1>Calculation trace</h1>");
      html.push("<div class=\"sub\">Generated by the Arc <b>Calculation Explorer</b> plugin &middot; " +
         escapeHtml(payload.generatedAt) + "</div>");

      html.push("<div class=\"meta\">");
      html.push("<div><b>Instance</b>" + escapeHtml(payload.instance) + "</div>");
      html.push("<div><b>Cube</b>" + escapeHtml(payload.cube) + "</div>");
      html.push("<div><b>Cell</b>" + escapeHtml(payload.coordinateLabel) + "</div>");
      html.push("<div><b>Value</b>" + escapeHtml(formatValue(payload.root.value)) + "</div>");
      if (payload.viewName) {
         html.push("<div><b>Source</b>" + escapeHtml(payload.viewName) + "</div>");
      }
      html.push("</div>");

      html.push("<div class=\"cards\">");
      html.push("<div class=\"card\"><span>Nodes</span><strong>" + payload.stats.nodeCount + "</strong></div>");
      html.push("<div class=\"card\"><span>Max depth</span><strong>" + payload.stats.maxDepth + "</strong></div>");
      html.push("<div class=\"card\"><span>Rule nodes</span><strong>" + payload.stats.ruleCount + "</strong></div>");
      html.push("<div class=\"card\"><span>Leaves</span><strong>" + payload.stats.leafCount + "</strong></div>");
      html.push("<div class=\"card\"><span>Cubes touched</span><strong>" + cubeNames.length + "</strong></div>");
      html.push("<div class=\"card\"><span>Requested depth</span><strong>" + payload.depth + "</strong></div>");
      if (payload.stats.droppedCount) {
         html.push("<div class=\"card\"><span>Left out (size limit)</span><strong>" +
            formatNumber(payload.stats.droppedCount) + "</strong></div>");
      }
      html.push("</div>");

      html.push("<div class=\"tools\">");
      html.push("<span class=\"modes\"><button id=\"mbus\" class=\"on\">Business view</button>" +
         "<button id=\"mtec\">Technical view</button></span>");
      html.push("<input type=\"text\" id=\"q\" placeholder=\"Filter cells, rules, cubes&hellip;  ( / )\">");
      html.push("<select id=\"cf\"><option value=\"\">All cubes</option>");
      for (var c = 0; c < cubeNames.length; c++) {
         html.push("<option value=\"" + escapeHtml(cubeNames[c]) + "\">" + escapeHtml(cubeNames[c]) +
            " (" + payload.stats.cubes[cubeNames[c]] + ")</option>");
      }
      html.push("</select>");
      html.push("<label class=\"chk\"><input type=\"checkbox\" id=\"hz\"> hide zero / empty</label>");
      html.push("<label class=\"chk\"><input type=\"checkbox\" id=\"ro\"> rule nodes only</label>");
      html.push("<button id=\"expand\">Expand all</button><button id=\"collapse\">Collapse all</button>");
      html.push("<button id=\"copy\">Copy as text</button>");
      html.push("</div>");

      html.push("<div class=\"crumbs\" id=\"crumbs\"></div>");
      html.push("<div class=\"tree\" id=\"tree\"></div>");
      html.push("<footer>Values are as at trace time. Percentages are each node's share of its parent. " +
         "Click <b>Why?</b> on any row to see the cell, its formula and the values that went into it. " +
         "Nodes marked <i>coordinates not resolved</i> sit below the depth that was requested — " +
         "re-trace from their parent in Arc to label them." +
         (payload.stats.droppedCount
            ? " This trace was larger than the plugin renders: " + formatNumber(payload.stats.droppedCount) +
              " components were left out at the size limit, so the deepest branches are incomplete."
            : "") +
         "</footer>");
      html.push("</div><script>window.TRACE=" + jsonForScript(data) + ";</script>");
      html.push("<script>" + HTML_SCRIPT + "</" + "script></body></html>");
      return html.join("");
   };

   /* ---- What the server says it is already doing (§5a.8, backlog 18) ----
    *
    * `GET /<instance>/Threads` answers a walking calculation trace as one
    * thread, measured against GO_New_Stores on Arc 6.0.0:
    *
    *    Function    POST /api/v1/Cubes('<cube>')/tm1.TraceCellCalculation
    *    State       Run
    *    Name        the TM1 user on the thread
    *    Context     Arc/6.0.0
    *    ElapsedTime P0DT00H00M13S
    *
    * `ElapsedTime` tracks wall-clock at about a second's granularity (1s at
    * 1,081 ms, 3s at 3,078 ms, … 16s at 16,143 ms), which is why the page
    * shows the server's clock rather than one of its own: a client timer keeps
    * counting after the connection drops, and §5a.8 measured exactly that
    * divergence -- the client gave up at 2.2 s while the walk ran to ~14 s.
    *
    * The classification lives here, as pure functions over a payload, because
    * the test harness has no Angular and no DOM (§4k). The controller keeps
    * only the request plumbing, so the part worth testing hard is testable. */

   var TRACE_ACTION = "tm1.TraceCellCalculation";

   /* ISO-8601 duration -> whole seconds, or **null** when it cannot be read.
    *
    * Null rather than 0 on purpose: 0 is a real reading -- a walk in its first
    * second -- and "no idea" is not, and everything above treats the two
    * differently. */
   var parseIsoDuration = function (text) {
      if (typeof text !== "string") { return null; }
      var match = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/
         .exec(text.trim());
      if (!match) { return null; }
      // "P" and "PT" are well-formed and say nothing, so they are not a
      // reading either. Only `undefined` is falsy here -- "0" is a real group.
      if (!match[1] && !match[2] && !match[3] && !match[4]) { return null; }
      var seconds = (parseFloat(match[1]) || 0) * 86400 +
         (parseFloat(match[2]) || 0) * 3600 +
         (parseFloat(match[3]) || 0) * 60 +
         (parseFloat(match[4]) || 0);
      if (!isFinite(seconds) || seconds < 0) { return null; }
      return Math.floor(seconds);
   };

   /* The cube out of the thread's own `Function` string. Positional rather
    * than clever: TM1 writes the OData resource path, and a cube name may
    * contain anything except a quote. */
   var traceThreadCube = function (fn) {
      if (typeof fn !== "string") { return null; }
      var open = fn.indexOf("Cubes('");
      if (open < 0) { return null; }
      var close = fn.indexOf("')", open);
      if (close < 0) { return null; }
      return fn.slice(open + "Cubes('".length, close) || null;
   };

   /* Every in-flight calculation trace the server was willing to show, split
    * by whose it is:
    *
    *    inFlightTraces(payload, "Admin")
    *       -> { mine: [{ id, user, cube, seconds }], others: [ … ] }
    *
    * **It never throws, for anything.** A body that is not an object, a
    * `value` that is missing or is not an array, a thread with no `Function`,
    * a `Function` naming some other action, a `State` that is not `Run`, an
    * `ElapsedTime` nobody can parse: every one of those reads as "nothing
    * seen", which leaves tracing exactly as it was. This is a guard in front
    * of the most expensive call this plugin makes, and a guard that turns a
    * permissions difference into "you cannot trace" is worse than the hole it
    * closes.
    *
    * There is one code path and no permission handling, deliberately (§5a.8):
    * an administrator sees every thread and a non-admin only their own, and
    * the same request simply returns fewer rows. The consequence, which is
    * easy to get backwards: for a non-admin the absence of another user's walk
    * is **not** evidence there isn't one, so nothing built on this may ever
    * state the negative.
    *
    * Three deliberate silences, each of them a case where saying something
    * would mean guessing:
    *
    *  - **no current user name** (an unreadable /ActiveUser) -> nothing is
    *    reported at all, rather than every walk being reported as somebody
    *    else's. The reload case (§5a.8) is the user's *own* walk and is the
    *    common one, so guessing "another user" would be a lie in the case
    *    that happens most.
    *  - **a thread with no readable `Name`** -> skipped, for the same reason:
    *    own and other are not interchangeable messages, and without a name
    *    neither of them can be told honestly.
    *  - **an `ElapsedTime` that cannot be read** -> skipped. Both messages are
    *    built around "started Ns ago", and a walk the page cannot describe is
    *    not one to interrupt somebody over. `state.tracing` still covers the
    *    common case inside one page. The cost of this choice is stated plainly
    *    because it is real: if a TM1 build ever answered a duration in another
    *    form, this feature would quietly do nothing -- which is the direction
    *    that fails open.
    *
    * `mine` matches case-insensitively: TM1 user names are, and treating
    * `admin` as a different person from `Admin` would produce precisely the
    * lie above. Two people signed in as the same TM1 user are
    * indistinguishable here -- /Threads names the user, not the human -- and
    * that is accepted rather than worked around. */
   var inFlightTraces = function (payload, userName) {
      var result = { mine: [], others: [] };
      var me = typeof userName === "string" && userName.trim()
         ? userName.trim().toUpperCase()
         : null;
      if (!me) { return result; }
      var threads = payload && typeof payload === "object" ? payload.value : null;
      if (Object.prototype.toString.call(threads) !== "[object Array]") { return result; }
      for (var i = 0; i < threads.length; i++) {
         var thread = threads[i];
         if (!thread || typeof thread !== "object") { continue; }
         if (typeof thread.Function !== "string" ||
               thread.Function.indexOf(TRACE_ACTION) < 0) { continue; }
         if (String(thread.State).toUpperCase() !== "RUN") { continue; }
         var seconds = parseIsoDuration(thread.ElapsedTime);
         if (seconds === null) { continue; }
         var user = typeof thread.Name === "string" ? thread.Name.trim() : "";
         if (!user) { continue; }
         var entry = {
            id: thread.ID === undefined ? null : thread.ID,
            user: user,
            cube: traceThreadCube(thread.Function),
            seconds: seconds
         };
         if (user.toUpperCase() === me) {
            result.mine.push(entry);
         } else {
            result.others.push(entry);
         }
      }
      return result;
   };

   /* ---- Cancelling a walk (§5e) -----------------------------------
    *
    * Three pure functions, for the three decisions the controller must not be
    * trusted with: who may cancel, what may be cancelled, and whether an error
    * that came back is a failure at all.
    *
    * All of it is measured. `POST /Threads(<id>)/tm1.CancelOperation` answered
    * **204 in 1,022 ms** on a depth-6 walk, the thread left `/Threads`, and the
    * waiting client came back 500 ms later with `TM1UserException: Cancel`
    * through the plugin's own error path (§5e.1).
    */

   /* `/ActiveUser?$select=Name,Type&$expand=Groups($select=Name)`, measured on
    * this session: `Type: "Admin"`, `Groups: [ADMIN, }tp_Everyone]`.
    *
    * **Fails closed, and deliberately narrow.** Only `Type: "Admin"` and
    * membership of `ADMIN` are treated as admin, because those are the two this
    * repo has seen answer a successful cancel. TM1 has other administrative
    * types -- `SecurityAdmin`, `DataAdmin`, `OperationsAdmin` -- and whether any
    * of them may cancel a thread is **not established here**, so they read as
    * not-admin: a control that is missing costs its owner a question, while a
    * control that is offered and then refused by the server costs them trust in
    * everything else the page says. §5e.2 is the note; widening this needs one
    * measurement per type, not an assumption.
    *
    * The same narrowness applies to the unreadable case: no payload, no name,
    * no admin. */
   var activeUserInfo = function (payload) {
      var info = { name: null, isAdmin: false };
      if (!payload || typeof payload !== "object") { return info; }
      if (typeof payload.Name === "string" && payload.Name.trim()) {
         info.name = payload.Name.trim();
      }
      if (typeof payload.Type === "string" && payload.Type.trim().toUpperCase() === "ADMIN") {
         info.isAdmin = true;
      }
      var groups = payload.Groups;
      if (Object.prototype.toString.call(groups) === "[object Array]") {
         for (var i = 0; i < groups.length; i++) {
            var group = groups[i];
            var name = group && typeof group.Name === "string" ? group.Name.trim().toUpperCase() : "";
            if (name === "ADMIN") { info.isAdmin = true; }
         }
      }
      return info;
   };

   /* May *this* thread be cancelled, right now, by this user?
    *
    * Asked of a **fresh** `/Threads` payload at the moment of the cancel, never
    * of the id the page has been carrying. §5e.3's first refusal is that this
    * plugin must not become a general thread killer, and the second is that it
    * must never guess -- so every reason to decline is named rather than
    * collapsed into false:
    *
    *    ok         cancel it
    *    unreadable /Threads did not answer, so nothing is known and nothing is done
    *    gone       no thread with that id -- it finished (a late cancel 404s in 8 ms)
    *    finished   the thread is there but no longer running
    *    nottrace   the thread is not a calculation trace: NOT ours to cancel
    *    notmine    somebody else's walk, and this user is not an admin
    *
    * `gone` and `finished` are separate because they are separate facts, even
    * though today they say the same thing to the reader. */
   var cancelTarget = function (payload, threadId, userName, isAdmin) {
      var verdict = { ok: false, reason: "unreadable", entry: null };
      var threads = payload && typeof payload === "object" ? payload.value : null;
      if (Object.prototype.toString.call(threads) !== "[object Array]") { return verdict; }
      if (threadId === null || threadId === undefined || threadId === "") { return verdict; }
      var wanted = String(threadId);
      var thread = null;
      for (var i = 0; i < threads.length; i++) {
         var candidate = threads[i];
         if (!candidate || typeof candidate !== "object") { continue; }
         if (candidate.ID === undefined || candidate.ID === null) { continue; }
         if (String(candidate.ID) === wanted) { thread = candidate; break; }
      }
      if (!thread) { verdict.reason = "gone"; return verdict; }
      if (typeof thread.Function !== "string" ||
            thread.Function.indexOf(TRACE_ACTION) < 0) {
         verdict.reason = "nottrace";
         return verdict;
      }
      if (String(thread.State).toUpperCase() !== "RUN") {
         verdict.reason = "finished";
         return verdict;
      }
      var user = typeof thread.Name === "string" ? thread.Name.trim() : "";
      var me = typeof userName === "string" && userName.trim()
         ? userName.trim().toUpperCase() : null;
      var mine = !!(me && user && user.toUpperCase() === me);
      if (!mine && !isAdmin) { verdict.reason = "notmine"; return verdict; }
      verdict.ok = true;
      verdict.reason = "ok";
      verdict.entry = {
         id: thread.ID,
         user: user,
         cube: traceThreadCube(thread.Function),
         seconds: parseIsoDuration(thread.ElapsedTime),
         mine: mine
      };
      return verdict;
   };

   /* **Nothing failed.** A cancelled walk comes back through the same path a
    * broken one does, carrying TM1's own `TM1UserException: Cancel`, and §5d
    * item 22 is what this repo thinks of a red box that says something failed
    * when nothing did.
    *
    * The page's own flag covers the cancel this page asked for. This covers the
    * other one, and it is the case that matters most: an admin stops somebody
    * else's runaway walk, and it is *that* person's page which has to explain
    * itself with no flag set anywhere in it. */
   var isCancelledError = function (error) {
      var text = typeof error === "string" ? error : (error && error.message);
      if (typeof text !== "string") { return false; }
      return /TM1UserException:\s*Cancel/i.test(text);
   };

   // ---------------------------------------------------------------

   return {
      VERSION: VERSION,
      ARC_BUILD: ARC_BUILD,
      MAX_EXPAND_DEPTH: MAX_EXPAND_DEPTH,
      odataQuote: odataQuote,
      escapeHtml: escapeHtml,
      formatNumber: formatNumber,
      formatValue: formatValue,
      parseUniqueName: parseUniqueName,
      cellIndices: cellIndices,
      cellOrdinal: cellOrdinal,
      orderCoordinates: orderCoordinates,
      buildTupleBind: buildTupleBind,
      buildTraceExpand: buildTraceExpand,
      buildTraceSelect: buildTraceSelect,
      buildTraceQuery: buildTraceQuery,
      /* Exported because the **controller** needs it too, and until Stage 2
       * it did not: `runTrace` spelled the action out as a literal while
       * `inFlightTraces` used this constant, so the name lived in two places
       * that could drift. `previewCoordinates` reaching for the bare name is
       * what exposed that -- it threw `TRACE_ACTION is not defined` in the
       * running page, and no node test could have seen it (§4k: the
       * controller is never executed there). */
      TRACE_ACTION: TRACE_ACTION,
      buildPreviewQuery: buildPreviewQuery,
      normalizePreview: normalizePreview,
      formatStatement: formatStatement,
      buildRuleIndex: buildRuleIndex,
      normalizeStatement: normalizeStatement,
      locateStatement: locateStatement,
      typeMeta: typeMeta,
      hasDeeperLevel: hasDeeperLevel,
      normalizeTree: normalizeTree,
      visitTree: visitTree,
      findNode: findNode,
      reassignIds: reassignIds,
      flatten: flatten,
      pathTo: pathTo,
      biggestChild: biggestChild,
      coordinateLabel: coordinateLabel,
      coordinatesOf: coordinatesOf,
      normalizeFedCell: normalizeFedCell,
      fedCellSummary: fedCellSummary,
      memberLabel: memberLabel,
      namesOnly: namesOnly,
      splitTop: splitTop,
      bracketLabel: bracketLabel,
      preferredNames: preferredNames,
      bracketGroups: bracketGroups,
      dbCalls: dbCalls,
      literalArgument: literalArgument,
      collapseOutsideStrings: collapseOutsideStrings,
      referencePairs: referencePairs,
      operandCoordinates: operandCoordinates,
      parseRuleStatement: parseRuleStatement,
      parseCellReference: parseCellReference,
      parseCellReferenceTable: parseCellReferenceTable,
      decodeElementList: decodeElementList,
      encodeElementList: encodeElementList,
      parseDeepLink: parseDeepLink,
      takeoverSettings: takeoverSettings,
      sameCoordinates: sameCoordinates,
      calculationTokens: calculationTokens,
      ownStatements: ownStatements,
      calculationView: calculationView,
      unresolvedLabel: unresolvedLabel,
      deltaLabel: deltaLabel,
      businessLabel: businessLabel,
      openPathIds: openPathIds,
      applyOpenPath: applyOpenPath,
      buildTextReport: buildTextReport,
      buildHtmlReport: buildHtmlReport,
      parseIsoDuration: parseIsoDuration,
      inFlightTraces: inFlightTraces,
      activeUserInfo: activeUserInfo,
      cancelTarget: cancelTarget,
      isCancelledError: isCancelledError
   };

}]);

/* Arc's tab content area *clips* a plugin's own tall content instead of
 * scrolling it — measured live: .lm_content is overflow:hidden with a
 * clientHeight of 818 against a scrollHeight of 923 — so a long trace simply
 * ran off the bottom with no way to reach the rest of it. This gives an element
 * its own scroll box, sized from where it actually sits inside that clipping
 * box rather than from a guess at how tall Arc's chrome is:
 *
 *    <div class="ce-btree" ce-fill="rows.length" ce-fill-pad="26" ce-fill-min="220">
 *
 * ce-fill is an expression to re-measure on — anything that changes the height
 * of what sits above it — and ce-fill-pad the gap to leave underneath. The CSS
 * carries a calc() fallback so the box is still bounded if this never runs. */
arc.directive("ceFill", ['$window', '$timeout', function ($window, $timeout) {
   return {
      restrict: "A",
      link: function ($scope, element, attrs) {
         var pad = parseInt(attrs.ceFillPad, 10) || 24;
         var min = parseInt(attrs.ceFillMin, 10) || 200;
         /* **A ceiling, added for §5d item 31, and the pickers are why it has
          * to exist.** This directive's job until now was to grow a box into
          * spare room, which is right for the grid and both trees -- they are
          * the main content and every spare pixel is a row. It is wrong for a
          * box that sits ABOVE the main content: the picker CSS records the
          * decision as "150, not 240: the pickers sit above the grid on a page
          * Arc clips, so every pixel they keep is a row of data the grid cannot
          * show". Those two boxes need the SHRINKING half of ce-fill without
          * the growing half, and there was no way to ask for that -- which is
          * why they were left with a hard max-height and ended up the only tall
          * boxes on the page that neither grow nor shrink.
          *
          * 0 means no ceiling, so every existing caller is unchanged. */
         var max = parseInt(attrs.ceFillMax, 10) || 0;
         var node = element[0];

         /* The floor is whichever comes first: the window, or the bottom of the
          * nearest ancestor that clips. Arc's layout clips well above the
          * window bottom, and sizing to the window alone left rows cut off. */
         var floorOf = function () {
            var limit = $window.innerHeight || 900;
            var parent = node.parentNode;
            while (parent && parent.nodeType === 1) {
               var style = $window.getComputedStyle(parent);
               var overflow = style.overflowY;
               if (overflow === "hidden" || overflow === "auto" || overflow === "scroll") {
                  var bottom = parent.getBoundingClientRect().bottom;
                  if (bottom > 0) { limit = Math.min(limit, bottom); }
                  break;
               }
               parent = parent.parentNode;
            }
            return limit;
         };

         var apply = function () {
            // Hidden (another tab): leave the last size alone rather than
            // computing a nonsense one from a zero rect.
            if (!node.offsetParent) { return; }
            var top = node.getBoundingClientRect().top;
            var available = floorOf() - top - pad;
            if (max) { available = Math.min(available, max); }
            element.css("max-height", Math.max(min, Math.round(available)) + "px");
         };

         // Coalesced: several watches and a resize can all fire in one turn.
         var queued = false;
         var later = function () {
            if (queued) { return; }
            queued = true;
            $timeout(function () { queued = false; apply(); }, 0);
         };

         var win = angular.element($window);
         win.on("resize", later);
         $scope.$on("$destroy", function () { win.off("resize", later); });
         if (attrs.ceFill) { $scope.$watch(attrs.ceFill, later); }
         later();
      }
   };
}]);

arc.directive("cubewiseCalculationExplorer", function () {
   return {
      restrict: "EA",
      replace: true,
      scope: {
         instance: "=tm1Instance"
      },
      templateUrl: "__/plugins/calculation-explorer/template.html",
      link: function ($scope, element, attrs) {

      },
      controller: ["$scope", "$rootScope", "$state", "$tm1", "$translate", "$sce", "$timeout", "$q", "$helper", "$window", "Notification", "calcExplorerCore", "calcExplorerRequest",
         function ($scope, $rootScope, $state, $tm1, $translate, $sce, $timeout, $q, $helper, $window, Notification, core, calcExplorerRequest) {

            /* Arc configures angular-translate to sanitise, so
             * $translate.instant returns a $sce *trusted value wrapper*, not a
             * string. Two consequences, both found live:
             *   Notification.error({title: <wrapper>}) throws [$sce:itype], so
             *   every toast this plugin raised was silently lost, and
             *   "x " + <wrapper> renders as "[object Object]".
             * So every string that reaches JavaScript comes through here. The
             * template's translate directive is unaffected — it unwraps. */
            var translated = function (key) {
               var value = $translate.instant(key);
               if (typeof value === "string") { return value; }
               var plain = $sce.valueOf(value);
               return typeof plain === "string" ? plain : String(key);
            };

            /* The same, for the two strings that carry a number or a name in
             * the *middle* of a sentence rather than at the end, where this
             * plugin's usual `translated(key) + " " + n` cannot reach.
             *
             * Substituted here rather than through `$translate.instant(key,
             * params)`, which would be the framework's own answer: that only
             * works while Arc leaves angular-translate's default interpolator
             * in place, and §2.9 is the standing reminder that Arc's translate
             * configuration is not what it looks like -- it sanitises, and
             * every string reaching JavaScript has needed unwrapping ever
             * since. A split/join needs no regex escaping and cannot surprise
             * anybody. A placeholder nobody passes is left visible on purpose:
             * a `{seconds}` on screen is a bug report, a silently empty gap is
             * not. */
            var filled = function (key, values) {
               var text = translated(key);
               angular.forEach(values, function (value, name) {
                  text = text.split("{" + name + "}").join(String(value));
               });
               return text;
            };

            var MAX_COLUMNS = 25;          // columns rendered in the grid
            var MAX_CELLS = 8000;          // hard cap on cells pulled per page
            var MAX_CHILDREN = 250;        // components rendered per trace node
            var MAX_NODES = 20000;         // total nodes normalised from one trace
            var MAX_ROWS = 800;            // rows handed to the DOM at once
            var EXPORT_BYTES_WARN = 10485760;   // 10 MB: ask before saving a page bigger
            var RESOLVE_ALL_LIMIT = 200;   // past this, a 12-node sweep is noise
            var MAX_DRILL_HOPS = 15;       // auto-drill safety stop
            var HISTORY_LIMIT = 25;

            // cube name -> [dimension names], cube name -> rule index, and
            // cube + statement -> location (statements repeat across the tree)
            var dimensionCache = {};
            var ruleCache = {};
            var locationCache = {};

            $scope.state = {
               instances: [],
               instance: $scope.instance || null,
               cubes: [],
               cube: null,
               views: [],
               view: null,
               mode: "view",
               viewMode: "business",
               openPath: ["0"],
               sortByContribution: true,
               mdx: "SELECT NON EMPTY {} ON COLUMNS, NON EMPTY {} ON ROWS FROM [Cube]",
               /* Depth is only how many levels come back *labelled*: measured
                * live, the same consolidated cell of the test model returned
                * 241,689 components at depth 2 and at depth 3, because the API
                * sends `Components` in full whatever the $expand depth. So a
                * lower depth buys nothing — what protects the plugin from a
                * cell like that is MAX_NODES and MAX_ROWS, not this. */
               depth: 3,
               rowsPerPage: 50,
               rowOffset: 0,
               hideControlCubes: true,
               // Expanded by default: reading the whole cell reference is the
               // common case, collapsing it to save a line is the exception.
               coordOpen: true,
               // The export menu, closed. Same shape as coordOpen: one flag on
               // state, so exactly one thing decides whether the panel is up.
               shareOpen: false,
               // The filters panel, same shape and the same anchoring -- which
               // is why the two are never both true: toggleShare and
               // toggleFilters each clear the other.
               filtersOpen: false,
               loadingInstances: false,
               loadingCubes: false,
               loadingViews: false,
               loadingGrid: false,
               tracing: false,
               /* The ordinal of the grid cell a walk was started from, so the
                * grid can show where the click landed. Cellset ordinals are
                * unique across the whole grid, not per row. */
               tracingCell: null,
               /* The page-level trace indicator: `{ cube, phase, seconds }`
                * or null. It is page-level rather than per-control because
                * three of the six ways into a trace -- Arc's cell-menu
                * handover, an opened link, a history replay -- involve no
                * control on this page at all, so every indicator that hangs
                * off the thing the user clicked shows nothing for the full
                * 15-22 s on exactly the paths a non-developer takes.
                *
                * One writer (setWalkNotice) and one clearer (clearWalkNotice),
                * which is §4f applied to the second piece of state this
                * feature adds, and a test pins it. */
               walkNotice: null,
               /* §5e. `walks` is the last /Threads reading this page took,
                * whoever took it -- the page-load check, a poll tick or a
                * pre-flight. `admin` gates the cancel control and is false
                * until /ActiveUser says otherwise, so an unreadable answer
                * hides the control rather than offering one the server will
                * refuse. `cancelling` holds the thread id whose cancel is in
                * flight, which is the single-flight guard and the disabled
                * state in one value. */
               walks: { mine: [], others: [] },
               admin: false,
               cancelling: null,
               autoDrilling: false,
               loadingFeeders: false,
               cubeFilter: "",
               viewFilter: "",
               filterText: "",
               hideZero: true,
               rulesOnly: false,
               resolving: false,
               /* The preview's own flag, and it is not part of
                * walkInFlight(): a preview is not a walk and costs the
                * server nothing measurable (§5a.7). It exists only so a
                * double click cannot land two responses out of order,
                * and it is written in one place and cleared in one
                * place, which is §4f applied to it. */
               previewing: false,
               treeCubeFilter: "",
               focusId: null,
               error: null,
               gridWarning: null,
               activeTab: 0
            };

            $scope.grid = null;
            $scope.trace = null;
            /* The cell without its tree: what §5a.7 showed can be had
             * for 40 ms. Held beside `trace` rather than inside it,
             * because they answer different questions and the page shows
             * whichever it has -- see previewCoordinates. */
            $scope.preview = null;
            $scope.rows = [];
            $scope.breadcrumb = [];
            $scope.why = {};
            $scope.manual = { rows: [] };
            $scope.feeders = null;
            /* Set only when Arc's own Trace Feeders handed a cell straight to
             * the feeders tab, so that check can run without a calculation
             * trace first. It carries the same cube / coordinates /
             * coordinateLabel / instance a trace does, which is what lets one
             * accessor serve the coordinate bar and both clipboard copies. */
            $scope.feederTarget = null;
            $scope.fmt = core.formatValue;

            /* What the About block at the bottom of the first tab renders.
             * Read from the factory, never retyped -- and reached through the
             * template's interpolation rather than JavaScript, so 2.9's $sce
             * wrapper never enters into it. */
            $scope.about = { version: core.VERSION, arcBuild: core.ARC_BUILD };

            /* A preview is a cell, so it serves everything that only
             * needs a cell: the coordinate bar, both clipboard copies,
             * the link button and the **feeder check**, which only ever
             * needed a coordinate (v1.3.0) and can now have one without a
             * walk. Ordered tree-first: once a tree exists it is the
             * page's subject, and the preview it grew from is stale in
             * every field the tree also has. */
            var currentCell = function () {
               return $scope.trace || $scope.preview || $scope.feederTarget;
            };
            $scope.cell = currentCell;

            var coordinateLabelOf = function (coordinates) {
               return _.map(coordinates, function (coordinate) {
                  return coordinate.dimension + " = " + coordinate.element;
               }).join(", ");
            };

            /* Nothing here may capture `$rootScope.uiPrefs`.
             *
             * Arc's uiPrefs is server-backed (`/_api/user-preferences/defaults`
             * and `/overrides`), so the object can be **replaced** rather than
             * mutated, while the takeover hook at the top of this file reads
             * `$rootScope.uiPrefs` fresh on every transition. A captured
             * reference therefore lies: `ng-model="uiPrefs.calcExplorerTakeover"`
             * wrote the tick into the old object, the hook kept reading the new
             * one, and the switch showed *on* while the takeover was off -- Arc's
             * built-in pages kept opening with the box ticked. That is the bug
             * that was reported against v1.3.0, and it reproduces exactly by
             * swapping the object under a page that holds it.
             *
             * So the checkboxes write through `setTakeover()`, and one watch on
             * the object's *identity* re-adopts whatever is current. */
            var livePrefs = function () {
               if (!$rootScope.uiPrefs) { $rootScope.uiPrefs = {}; }
               return $rootScope.uiPrefs;
            };

            /* One checkbox per built-in page, defaulting on: a user who installs
             * a calculation tracer means to use it. Defaults are resolved by
             * `core.takeoverSettings` (which also carries a pre-split setting
             * forward) and written back once, so the stored prefs say what the
             * boxes show. */
            $scope.takeover = core.takeoverSettings(livePrefs());

            $scope.setTakeover = function () {
               var prefs = livePrefs();
               prefs.calcExplorerTakeover = !!$scope.takeover.calculation;
               prefs.calcExplorerTakeoverFeeders = !!$scope.takeover.feeders;
            };

            if (livePrefs().calcExplorerTakeover === undefined ||
                  livePrefs().calcExplorerTakeoverFeeders === undefined) {
               $scope.setTakeover();
            }

            var adoptPrefs = function (prefs) {
               var settings = core.takeoverSettings(prefs);
               $scope.takeover.calculation = settings.calculation;
               $scope.takeover.feeders = settings.feeders;
               if (!prefs.calcExplorerHistory) {
                  /* `traceExplorerHistory` is the pre-rename name, so an existing
                   * history is not orphaned; `$scope.history` covers the replaced
                   * object case, so a swap does not lose the traces on screen. */
                  prefs.calcExplorerHistory =
                     prefs.traceExplorerHistory || $scope.history || [];
               }
               $scope.history = prefs.calcExplorerHistory;
            };
            adoptPrefs(livePrefs());

            /* One identity comparison per digest, and it is all that stands
             * between a replaced prefs object and a switch that lies. */
            $scope.$watch(function () { return $rootScope.uiPrefs; }, function (prefs) {
               if (prefs) { adoptPrefs(prefs); }
            });

            // ---------------------------------------------------------------
            // REST plumbing
            // ---------------------------------------------------------------

            /* Guarded, because without an instance $tm1.async builds
             * /undefined/Cubes(...) and the user is told only "HTTP 404".
             * Shaped like a real result so every caller's failed() path works. */
            var api = function (method, path, body) {
               if (!$scope.state.instance) {
                  return $q.when({
                     status: 0,
                     data: { error: { message: translated("CALCEXPLORER_NOINSTANCE") } }
                  });
               }
               return $tm1.async($scope.state.instance, method, path, body === undefined ? null : body);
            };

            var failed = function (result) {
               return !(result && (result.status === 200 || result.status === 201 || result.status === 204));
            };

            var errorText = function (result) {
               if (result && result.data && result.data.error && result.data.error.message) {
                  return result.data.error.message;
               }
               return "HTTP " + (result ? result.status : "?");
            };

            var cubePath = function (name) {
               return "/Cubes('" + $helper.encodeName(name) + "')";
            };

            var cellsetPath = function (id) {
               return "/Cellsets('" + $helper.encodeName(id) + "')";
            };

            var reportError = function (title, result) {
               var message = typeof result === "string" ? result : errorText(result);
               $scope.state.error = message;
               Notification.error({ title: translated(title), message: message });
            };

            var isControlObject = function (name) {
               return String(name).charAt(0) === "}";
            };

            // ---------------------------------------------------------------
            // Instances / cubes / views
            // ---------------------------------------------------------------

            /* Landing straight on /calculation-explorer/<instance> — a bookmark,
             * a reload, or a context-menu click while Arc is still starting —
             * can run this before Arc has finished connecting, in which case
             * nothing is reported as loaded yet. One retry covers that; without
             * it the page sat there with an empty cube list and every request
             * failing, which is how this was found. */
            var instanceRetried = false;

            $scope.loadInstances = function () {
               $scope.state.loadingInstances = true;
               $tm1.instances().then(function (data) {
                  var loaded = _.filter(data, function (item) { return item.isLoaded; });
                  $scope.state.instances = _.map(loaded, function (item) { return item.Name; });
                  /* Arc opened this page *for* an instance, so keep that one in
                   * the list even when it is not reported as loaded (it can be
                   * reconnecting, or the call can come back empty). Seen live:
                   * with an empty list the <select> has no option to hold the
                   * value, ngOptions writes undefined back over the model, and
                   * every later request goes to /undefined/ and 404s. */
                  if ($scope.instance && !_.includes($scope.state.instances, $scope.instance)) {
                     $scope.state.instances.unshift($scope.instance);
                  }
                  if (!_.includes($scope.state.instances, $scope.state.instance)) {
                     $scope.state.instance = _.includes($scope.state.instances, $scope.instance)
                        ? $scope.instance
                        : $scope.state.instances[0];
                  }
                  if ($scope.state.instance) {
                     $scope.loadCubes();
                     /* And ask the server whether it is already walking for
                      * this user -- backlog 18's Tier 1, which is the case
                      * that actually happens: a reload leaves TM1 walking for
                      * at least ten more seconds (§5a.8) on a page that looks
                      * idle. Hooked here because it is the one place the
                      * instance is known to be usable, and it re-checks after
                      * a reconnect, where an orphan walk is just as likely.
                      *
                      * `showEarlierWalk` is declared further down the
                      * controller: this callback cannot run until the whole
                      * body has, so the assignment has always happened. */
                     showEarlierWalk();
                  }
                  if (!$scope.state.instances.length && !instanceRetried) {
                     instanceRetried = true;
                     $timeout($scope.loadInstances, 2000);
                  }
               }).finally(function () {
                  $scope.state.loadingInstances = false;
               });
            };

            $scope.loadCubes = function () {
               if (!$scope.state.instance) { return; }
               $scope.state.loadingCubes = true;
               $scope.state.cubes = [];
               $scope.state.views = [];
               $scope.grid = null;
               api("GET", "/Cubes?$select=Name").then(function (result) {
                  if (failed(result)) { reportError("CALCEXPLORER_LOADCUBESFAILED", result); return; }
                  $scope.state.cubes = _.map(result.data.value, function (cube) { return cube.Name; });
                  if (!_.includes($scope.state.cubes, $scope.state.cube)) { $scope.state.cube = null; }
               }).finally(function () {
                  $scope.state.loadingCubes = false;
               });
            };

            $scope.visibleCubes = function () {
               var text = ($scope.state.cubeFilter || "").toLowerCase();
               return _.filter($scope.state.cubes, function (name) {
                  if ($scope.state.hideControlCubes && isControlObject(name)) { return false; }
                  return !text || name.toLowerCase().indexOf(text) !== -1;
               });
            };

            $scope.visibleViews = function () {
               var text = ($scope.state.viewFilter || "").toLowerCase();
               return _.filter($scope.state.views, function (view) {
                  return !text || view.name.toLowerCase().indexOf(text) !== -1;
               });
            };

            $scope.selectCube = function (name) {
               $scope.state.cube = name;
               $scope.state.view = null;
               $scope.grid = null;
               $scope.state.error = null;
               $scope.state.rowOffset = 0;
               $scope.loadViews();
               loadDimensions(name).then(function (dimensions) {
                  $scope.manual.rows = _.map(dimensions, function (dimension) {
                     return { dimension: dimension, hierarchy: dimension, element: "" };
                  });
               });
            };

            $scope.loadViews = function () {
               if (!$scope.state.cube) { return; }
               $scope.state.loadingViews = true;
               $scope.state.views = [];
               var base = cubePath($scope.state.cube);
               return $q.all([
                  api("GET", base + "/Views?$select=Name"),
                  api("GET", base + "/PrivateViews?$select=Name")
               ]).then(function (results) {
                  var views = [];
                  if (!failed(results[0])) {
                     angular.forEach(results[0].data.value, function (view) {
                        views.push({ name: view.Name, private: false, type: view["@odata.type"] || "" });
                     });
                  } else {
                     reportError("CALCEXPLORER_LOADVIEWSFAILED", results[0]);
                  }
                  // Private views are a convenience; an error here is not fatal.
                  if (!failed(results[1])) {
                     angular.forEach(results[1].data.value, function (view) {
                        views.push({ name: view.Name, private: true, type: view["@odata.type"] || "" });
                     });
                  }
                  $scope.state.views = views;
               }).finally(function () {
                  $scope.state.loadingViews = false;
               });
            };

            $scope.selectView = function (view) {
               $scope.state.view = view;
               $scope.state.rowOffset = 0;
               $scope.loadGrid();
            };

            // ---------------------------------------------------------------
            // Dimensions and rules (cached per cube)
            // ---------------------------------------------------------------

            var loadDimensions = function (cube) {
               if (dimensionCache[cube]) { return $q.when(dimensionCache[cube]); }
               return api("GET", cubePath(cube) + "?$select=Name&$expand=Dimensions($select=Name)").then(function (result) {
                  if (failed(result)) { dimensionCache[cube] = null; return null; }
                  dimensionCache[cube] = _.map(result.data.Dimensions, function (dim) { return dim.Name; });
                  return dimensionCache[cube];
               });
            };

            var loadRuleIndex = function (cube) {
               if (ruleCache.hasOwnProperty(cube)) { return $q.when(ruleCache[cube]); }
               return api("GET", cubePath(cube) + "?$select=Rules").then(function (result) {
                  if (failed(result) || !result.data.Rules) { ruleCache[cube] = null; return null; }
                  ruleCache[cube] = core.buildRuleIndex(result.data.Rules);
                  return ruleCache[cube];
               });
            };

            // ---------------------------------------------------------------
            // Reading a page of cells out of a view / MDX statement
            // ---------------------------------------------------------------

            var METADATA_EXPAND = "$expand=Cube($select=Name;$expand=Dimensions($select=Name))," +
               "Axes($select=Ordinal,Cardinality;$expand=Hierarchies($select=Name))";

            var TUPLE_EXPAND = "$expand=Members($select=Name,UniqueName,Type)";

            var CELL_SELECT = "$select=Ordinal,Value,FormattedValue,RuleDerived,Consolidated,Updateable";

            var sourceDescriptor = function () {
               if ($scope.state.mode === "mdx") {
                  return { kind: "mdx", mdx: $scope.state.mdx };
               }
               if (!$scope.state.cube || !$scope.state.view) { return null; }
               return {
                  kind: "view",
                  cube: $scope.state.cube,
                  view: $scope.state.view,
                  label: ($scope.state.view.private ? "Private view " : "View ") + $scope.state.view.name
               };
            };

            var executeMetadata = function (source) {
               if (source.kind === "mdx") {
                  return api("POST", "/ExecuteMDX?" + METADATA_EXPAND, { MDX: source.mdx });
               }
               var collection = source.view.private ? "PrivateViews" : "Views";
               return api("POST", cubePath(source.cube) + "/" + collection + "('" +
                  $helper.encodeName(source.view.name) + "')/tm1.Execute?" + METADATA_EXPAND, {});
            };

            var parseTuple = function (tuple) {
               var members = [];
               angular.forEach(tuple.Members || [], function (member) {
                  var parsed = core.parseUniqueName(member.UniqueName);
                  members.push({
                     name: member.Name,
                     type: member.Type,
                     dimension: parsed ? parsed.dimension : null,
                     hierarchy: parsed ? parsed.hierarchy : null,
                     element: parsed ? parsed.element : member.Name
                  });
               });
               return {
                  ordinal: tuple.Ordinal,
                  members: members,
                  label: _.map(members, function (member) { return member.name; }).join(" | ")
               };
            };

            // Pull one page out of an existing cellset. Rejects so the caller
            // can fall back to a single-call execute.
            var loadPageFromCellset = function (metadata, rowOffset) {
               var axes = metadata.Axes || [];
               if (!axes.length) { return $q.reject("no axes"); }
               var cardinalities = _.map(axes, function (axis) { return axis.Cardinality || 1; });
               var columnCount = cardinalities[0] || 1;
               var rowTotal = cardinalities.length > 1 ? cardinalities[1] : 1;
               var rowCount = Math.min($scope.state.rowsPerPage, Math.max(0, rowTotal - rowOffset));
               var cellCount = Math.min(MAX_CELLS, rowCount * columnCount);
               var base = cellsetPath(metadata.ID);

               var calls = [
                  api("GET", base + "/Axes(0)/Tuples?$top=" + MAX_COLUMNS + "&" + TUPLE_EXPAND),
                  api("GET", base + "/Cells?" + CELL_SELECT + "&$top=" + cellCount + "&$skip=" + (rowOffset * columnCount))
               ];
               var axisIndex;
               for (axisIndex = 1; axisIndex < axes.length; axisIndex++) {
                  if (axisIndex === 1) {
                     calls.push(api("GET", base + "/Axes(1)/Tuples?$top=" + rowCount +
                        "&$skip=" + rowOffset + "&" + TUPLE_EXPAND));
                  } else {
                     calls.push(api("GET", base + "/Axes(" + axisIndex + ")/Tuples?$top=1&" + TUPLE_EXPAND));
                  }
               }

               return $q.all(calls).then(function (results) {
                  var i;
                  for (i = 0; i < results.length; i++) {
                     if (failed(results[i])) { return $q.reject(errorText(results[i])); }
                  }
                  var columns = _.map(results[0].data.value, parseTuple);
                  var cells = results[1].data.value;
                  var rowTuples = axes.length > 1 ? _.map(results[2].data.value, parseTuple) : [{ ordinal: 0, members: [], label: "" }];
                  var titles = [];
                  for (i = 3; i < results.length; i++) {
                     var tuples = results[i].data.value;
                     if (tuples && tuples.length) { titles.push(parseTuple(tuples[0])); }
                  }
                  return {
                     cardinalities: cardinalities,
                     columns: columns,
                     rows: rowTuples,
                     titles: titles,
                     cells: cells,
                     rowTotal: rowTotal,
                     columnTotal: columnCount,
                     rowOffset: rowOffset,
                     paged: true
                  };
               });
            };

            // Fallback: one call, everything capped, always from row 0. Used
            // when per-axis reads off the cellset are unavailable.
            var loadPageInOneCall = function (source) {
               var expand = "$expand=Cube($select=Name;$expand=Dimensions($select=Name))," +
                  "Axes($select=Ordinal,Cardinality;$expand=Hierarchies($select=Name)," +
                  "Tuples($top=" + $scope.state.rowsPerPage + ";" + TUPLE_EXPAND + "))," +
                  "Cells(" + CELL_SELECT + ";$top=" + MAX_CELLS + ")";
               var request = source.kind === "mdx"
                  ? api("POST", "/ExecuteMDX?" + expand, { MDX: source.mdx })
                  : api("POST", cubePath(source.cube) + "/" +
                     (source.view.private ? "PrivateViews" : "Views") + "('" +
                     $helper.encodeName(source.view.name) + "')/tm1.Execute?" + expand, {});

               return request.then(function (result) {
                  if (failed(result)) { return $q.reject(errorText(result)); }
                  var data = result.data;
                  var axes = data.Axes || [];
                  var cardinalities = _.map(axes, function (axis) { return axis.Cardinality || 1; });
                  var titles = [];
                  for (var i = 2; i < axes.length; i++) {
                     if (axes[i].Tuples && axes[i].Tuples.length) { titles.push(parseTuple(axes[i].Tuples[0])); }
                  }
                  return {
                     metadata: data,
                     cardinalities: cardinalities,
                     columns: _.map((axes[0] || {}).Tuples || [], parseTuple).slice(0, MAX_COLUMNS),
                     rows: axes.length > 1 ? _.map(axes[1].Tuples || [], parseTuple) : [{ ordinal: 0, members: [], label: "" }],
                     titles: titles,
                     cells: data.Cells || [],
                     rowTotal: cardinalities.length > 1 ? cardinalities[1] : 1,
                     columnTotal: cardinalities[0] || 1,
                     rowOffset: 0,
                     paged: false
                  };
               });
            };

            var buildGrid = function (metadata, page) {
               var cube = metadata.Cube ? metadata.Cube.Name : $scope.state.cube;
               var dimensions = metadata.Cube && metadata.Cube.Dimensions
                  ? _.map(metadata.Cube.Dimensions, function (dim) { return dim.Name; })
                  : (dimensionCache[cube] || []);
               dimensionCache[cube] = dimensions;

               var cellByOrdinal = {};
               angular.forEach(page.cells, function (cell) { cellByOrdinal[cell.Ordinal] = cell; });

               var rows = [];
               var missingCells = 0;
               angular.forEach(page.rows, function (rowTuple) {
                  var cells = [];
                  angular.forEach(page.columns, function (columnTuple, columnIndex) {
                     var indices = [columnTuple.ordinal, rowTuple.ordinal];
                     for (var i = 2; i < page.cardinalities.length; i++) { indices.push(0); }
                     var ordinal = core.cellOrdinal(page.cardinalities, indices);
                     var cell = cellByOrdinal[ordinal];
                     if (!cell) { missingCells++; }
                     cells.push({
                        ordinal: ordinal,
                        columnIndex: columnIndex,
                        column: columnTuple,
                        row: rowTuple,
                        present: !!cell,
                        value: cell ? cell.Value : null,
                        formatted: cell ? cell.FormattedValue : "",
                        ruleDerived: cell ? !!cell.RuleDerived : false,
                        consolidated: cell ? !!cell.Consolidated : false
                     });
                  });
                  rows.push({ tuple: rowTuple, label: rowTuple.label, cells: cells });
               });

               var warnings = [];
               if (page.columnTotal > page.columns.length) {
                  warnings.push(page.columns.length + " of " + page.columnTotal + " columns shown");
               }
               if (!page.paged && page.rowTotal > page.rows.length) {
                  warnings.push(page.rows.length + " of " + page.rowTotal + " rows shown (paging unavailable — narrow the view or use MDX)");
               }
               if (missingCells) {
                  warnings.push(missingCells + " cells fell outside the " + MAX_CELLS +
                     " cell window and show blank (they can still be traced)");
               }

               return {
                  cube: cube,
                  dimensions: dimensions,
                  cardinalities: page.cardinalities,
                  columns: page.columns,
                  rows: rows,
                  titles: page.titles,
                  rowTotal: page.rowTotal,
                  columnTotal: page.columnTotal,
                  rowOffset: page.rowOffset,
                  paged: page.paged,
                  warning: warnings.length ? warnings.join(" · ") : null
               };
            };

            $scope.loadGrid = function () {
               var source = sourceDescriptor();
               if (!source) { return; }
               $scope.state.loadingGrid = true;
               $scope.state.error = null;
               $scope.grid = null;

               executeMetadata(source).then(function (result) {
                  if (failed(result)) { return $q.reject(errorText(result)); }
                  var metadata = result.data;
                  return loadPageFromCellset(metadata, $scope.state.rowOffset).then(function (page) {
                     if (metadata.ID) { $tm1.cellsetDelete($scope.state.instance, metadata.ID); }
                     return buildGrid(metadata, page);
                  }, function () {
                     // Per-axis reads unavailable — one capped call instead.
                     if (metadata.ID) { $tm1.cellsetDelete($scope.state.instance, metadata.ID); }
                     $scope.state.rowOffset = 0;
                     return loadPageInOneCall(source).then(function (page) {
                        if (page.metadata && page.metadata.ID) {
                           $tm1.cellsetDelete($scope.state.instance, page.metadata.ID);
                        }
                        return buildGrid(page.metadata || metadata, page);
                     });
                  });
               }).then(function (grid) {
                  $scope.grid = grid;
                  $scope.state.gridWarning = grid.warning;
                  if (grid.cube && !$scope.state.cube) { $scope.state.cube = grid.cube; }
               }).catch(function (error) {
                  reportError("CALCEXPLORER_VIEWFAILED", error);
               }).finally(function () {
                  $scope.state.loadingGrid = false;
               });
            };

            $scope.pageRows = function (direction) {
               if (!$scope.grid) { return; }
               var next = $scope.state.rowOffset + direction * $scope.state.rowsPerPage;
               if (next < 0 || next >= $scope.grid.rowTotal) { return; }
               $scope.state.rowOffset = next;
               $scope.loadGrid();
            };

            // ---------------------------------------------------------------
            // Tracing
            // ---------------------------------------------------------------

            var requestedDepth = function () {
               var depth = parseInt($scope.state.depth, 10);
               if (!depth || depth < 1) { depth = 1; }
               return Math.min(core.MAX_EXPAND_DEPTH, depth);
            };

            /* ---- One server walk at a time (5a, Stage 0) ----------------
             *
             * A walk is `tm1.TraceCellCalculation`, and 2.7 measured what it
             * costs: the whole component closure comes back whatever $expand
             * depth is asked for -- 241,689 components for one cell of the
             * *demo* model -- and every cap this plugin has runs after the
             * response arrives. None of them is visible to the server. So the
             * only thing the page can honestly control is how many walks it
             * asks for, and the answer is one.
             *
             * Two functions rather than one, and the difference matters:
             *
             *   claimWalk()    guards the *request*. It reads state.tracing
             *                  alone, because a sweep (auto-drill, resolve
             *                  all) holds its own flag for the whole run and
             *                  still has to be able to take each hop.
             *   walkInFlight() guards the *gesture*. It reads all three, so a
             *                  grid click cannot slip into the gap a sweep
             *                  leaves between hops.
             *
             * state.tracing is set in exactly one place and cleared in
             * exactly one place -- the 4f lesson, and a test pins it. */
            var claimWalk = function () {
               if ($scope.state.tracing) { return null; }
               $scope.state.tracing = true;
               return function () { $scope.state.tracing = false; };
            };

            var walkInFlight = function () {
               return !!($scope.state.tracing || $scope.state.autoDrilling ||
                  $scope.state.resolving);
            };
            $scope.walkInFlight = walkInFlight;

            var declineWalk = function () {
               Notification.error({
                  title: translated("CALCEXPLORER_TRACEFAILED"),
                  message: translated("CALCEXPLORER_WALKBUSY")
               });
            };

            /* A refused PREVIEW is not a failure and is not a walk, so it gets
             * neither the red box nor the walk's cost model. It is a one-second
             * wait, and the honest thing to say is how long. */
            var declinePreview = function () {
               Notification.warning({
                  title: translated("CALCEXPLORER_PREVIEWBUSYTITLE"),
                  message: translated("CALCEXPLORER_PREVIEWBUSY")
               });
            };

            /* ---- Asking the server, not just remembering it (§5a.8, item 18)
             *
             * `state.tracing` lives in the page's scope, and §5a.8 measured
             * what that structurally cannot cover: **the walk outlives the
             * client by at least ten seconds**, so a reload -- the natural
             * response to a page that appears to do nothing -- hands the user
             * a fresh scope with the guard cleared while TM1 is still walking.
             * One click then buys two concurrent walks, which is the exact
             * failure Stage 0 exists to prevent, reached by a route Stage 0
             * cannot see. It covers three more of them the same way: a second
             * tab, and a second *person* on a shared instance.
             *
             * So the guard is also asked of the server. `GET /Threads` names
             * every in-flight trace it is willing to show this reader and
             * calcExplorerCore.inFlightTraces classifies it.
             *
             * **The cost is measured and is not the constraint.** A /Threads
             * read is 7-27 ms idle and <=41 ms in 34 of 36 in-walk samples at
             * 427 bytes, and 18 reads across a 16 s walk left no trace against
             * a 5,380 ms intrinsic variance (`WaitTime` stayed at zero
             * throughout). What the poll below still needs is a hard cap and a
             * guaranteed stop, because those are failure modes rather than
             * costs -- a runaway poll against the server this whole item
             * exists to protect would be the cure joining the disease.
             *
             * Everything here fails open, which is a requirement and not a
             * nicety: any failure of /Threads or /ActiveUser -- non-200,
             * network error, unparseable body, missing fields -- leaves
             * tracing fully working, as if nothing were running. */

            /* The TM1 user this page is signed in as. /ActiveUser rather than
             * /Sessions: §5a.8 found /Sessions gives a richer linkage (it
             * resolves a thread to `User { Name, Type, FriendlyName }`) but it
             * is likely administrator-only, and this is a user reading
             * themselves -- which is what has to work for everybody, since
             * Tier 1 is the case that actually happens.
             *
             * Keyed by instance because a TM1 user is per server and the
             * instance picker can change under an open page. Only a real
             * answer is cached: a failed read is usually a session still
             * coming up (§2.10 -- this page can exist before Arc has
             * connected), and remembering that would switch the guard off for
             * the life of the page. */
            var activeUserReads = {};

            /* Widened for §5e: the same read now answers **who this is** and
             * **whether they may cancel**, because the cancel control has to
             * be gated on something and this is the call the walk guard
             * already makes on every /Threads read.
             *
             * Two requests in the code, one on the wire in the healthy case.
             * The wide form was measured answering `Type: "Admin"` and
             * `Groups: [ADMIN, }tp_Everyone]` for this session -- but whether
             * a **non-admin** may read its own `Groups` is not established,
             * and if that expansion were refused the whole read would fail,
             * `readWalks` would see no user name, and §4r's indicator would go
             * dark for exactly those users. So a refusal falls back to the
             * narrow read this guard has always made, with `isAdmin` false:
             * the cancel control disappears and nothing else changes. */
            var activeUser = function () {
               var instance = $scope.state.instance;
               if (!instance) { return $q.when(core.activeUserInfo(null)); }
               if (!activeUserReads[instance]) {
                  var keep = function (info) {
                     if (!info.name) { delete activeUserReads[instance]; }
                     else { $scope.state.admin = info.isAdmin; }
                     return info;
                  };
                  activeUserReads[instance] =
                     api("GET", "/ActiveUser?$select=Name,Type&$expand=Groups($select=Name)")
                        .then(function (result) {
                           if (!failed(result)) { return core.activeUserInfo(result.data); }
                           return api("GET", "/ActiveUser?$select=Name").then(function (narrow) {
                              return core.activeUserInfo(failed(narrow) ? null : narrow.data);
                           });
                        })
                        .then(keep)
                        .catch(function () {
                           delete activeUserReads[instance];
                           return core.activeUserInfo(null);
                        });
               }
               return activeUserReads[instance];
            };

            var activeUserName = function () {
               return activeUser().then(function (info) { return info.name; });
            };

            /* One /Threads read, classified. Resolves to the same
             * `{ mine: [], others: [] }` shape whatever happens, including
             * every failure -- a rejection escaping here would take the trace
             * with it, which is the outage this must not become. The empty
             * shape comes from core rather than being retyped, so one place
             * knows it. */
            /* §5e: every /Threads read this page already makes -- the
             * page-load check, each poll tick, the pre-flight -- leaves its
             * answer on the scope, so an admin's list of other people's walks
             * is as fresh as the last read and needs no read of its own. It is
             * a **reading, not a live clock**: outside this page's own walk
             * nothing polls, so those seconds are as at that read. The cancel
             * itself re-reads /Threads before it acts, which is what makes a
             * stale row safe -- it becomes "that trace had already finished"
             * rather than a cancel aimed at whatever now holds that id. */
            var noteWalks = function (walks) {
               if (walkPageGone) { return walks; }
               $scope.state.walks = walks;
               watchOtherWalks();
               return walks;
            };

            var readWalks = function () {
               return $q.all([api("GET", "/Threads"), activeUserName()])
                  .then(function (answers) {
                     if (failed(answers[0])) { return core.inFlightTraces(null, null); }
                     return core.inFlightTraces(answers[0].data, answers[1]);
                  })
                  .catch(function () { return core.inFlightTraces(null, null); })
                  .then(noteWalks);
            };

            /* The three states the indicator can honestly be in. The first two
             * are the walk this page asked for; the third is one it found
             * already running when it loaded. */
            var PHASE_WALK = "walking";
            var PHASE_RECEIVE = "receiving";
            var PHASE_EARLIER = "earlier";
            /* **The fourth phase, and it exists because item 14 came back.**
             * §4r gave every WALK an indicator; v1.11.0 then moved all six
             * entry paths onto the preview, which never touched the notice --
             * so the path a non-developer is most likely to take (Arc's cell
             * menu) went back to showing nothing at all for the ~2 s it takes.
             * Measured: `activeTab` 0 at 71 ms, still 0 at 1,154 ms with
             * `previewing` true, and `walkNotice` null at every sample.
             *
             * It reuses `.ce-walkbar` rather than growing a second indicator:
             * one place where the page says what it is doing, whichever half
             * of the request is in flight. Seconds are `null` here, not 0 --
             * the preview has no server clock to report, and 0 would be a
             * number the page cannot stand behind. */
            var PHASE_PREVIEW = "preview";
            /* Long enough that the common case never flashes. A preview is
             * ~1 s when it has a round trip to make and ~50 ms warm, and a
             * notice that appears and vanishes inside a blink is noise rather
             * than feedback. */
            var PREVIEW_NOTICE_MS = 400;

            /* Set once by $destroy and never cleared -- this page is a tab Arc
             * creates and destroys, and a destroyed scope is never revived.
             *
             * It is checked by the two WRITERS rather than at each call site,
             * and that is the point: clearing the notice on $destroy stops the
             * poll's own chain (the measurement is in the $destroy handler
             * below), but it cannot stop a DIFFERENT async path from setting
             * the notice afterwards and starting a fresh poll. showEarlierWalk
             * is exactly such a path -- one /Threads read per page load, whose
             * .then tests `walkNotice` and `tracing`, both of which read false
             * on a scope that has just been torn down. Guarding the writers
             * covers it, covers pollWalk, and covers whatever is added next.
             *
             * Read from the code, not measured: unlike the poll-resurrection
             * bug this sits beside, no live reproduction of the
             * showEarlierWalk window has been taken. The window is one read
             * wide (18-72 ms healthy, ~1.7 s on a throttled client), which is
             * the "open the page and immediately close it" case. */
            var walkPageGone = false;

            var setWalkNotice = function (cube, phase, seconds) {
               if (walkPageGone) { return; }
               $scope.state.walkNotice = { cube: cube, phase: phase, seconds: seconds };
            };

            var clearWalkNotice = function () {
               $scope.state.walkNotice = null;
            };

            /* 1 s, chosen for the UI: `ElapsedTime` moves at about a second's
             * granularity (§5a.8), so nothing faster says anything new, and
             * the read is free at this rate by the measurement above.
             *
             * MAX_WALK_POLLS is the hard cap -- two minutes of reads, which is
             * several times the 15-22 s a demo-model walk takes (§2.7) and
             * still a number rather than "until something happens". */
            var WALK_POLL_MS = 1000;
            var MAX_WALK_POLLS = 120;
            var walkPollTimer = null;
            var walkPolls = 0;

            var stopWalkPoll = function () {
               if (walkPollTimer) { $timeout.cancel(walkPollTimer); }
               walkPollTimer = null;
            };

            /* The trap this feature would otherwise have shipped with, and it
             * is measured: the walking thread **leaves /Threads 0.3-0.9 s
             * before the first byte reaches the client** (walker present at
             * 13,087 ms, gone by 15,073 ms, TTFB 14,700 ms, then 560 ms of
             * transfer for 133 MB). A purely /Threads-driven indicator
             * therefore goes dark while the browser is still streaming the
             * answer -- the one moment it must not, because that is when a
             * user concludes nothing is happening and reloads.
             *
             * So the last stretch is rendered from the client instead: a
             * second phase, and both of them are true. The seconds stop moving
             * because they are the server's last word on how long the walk
             * took, not a timer -- §5a.8 measured a client timer diverging
             * from reality by more than ten seconds, which is the reason this
             * feature reads the server's clock at all. */
            var walkVanished = function (cube) {
               if ($scope.state.walkNotice &&
                     $scope.state.walkNotice.phase === PHASE_EARLIER) {
                  /* An orphan walk finished. This page never asked for it, so
                   * there is nothing arriving and nothing to say. */
                  clearWalkNotice();
                  return;
               }
               // state.tracing is set exactly while this page has a walk
               // request outstanding, which is what tells the two apart.
               if (!$scope.state.tracing) { clearWalkNotice(); return; }
               setWalkNotice(cube, PHASE_RECEIVE,
                  $scope.state.walkNotice ? $scope.state.walkNotice.seconds : 0);
            };

            /* One timer, so a second walk cannot leave the first one's poll
             * running behind it, and one place that assigns it. */
            var schedulePoll = function (cube) {
               walkPollTimer = $timeout(function () { pollWalk(cube); }, WALK_POLL_MS);
            };

            var pollWalk = function (cube) {
               walkPolls++;
               // Stop 1 of 3: the page's trace resolved and cleared the notice.
               if (!$scope.state.walkNotice) { return; }
               readWalks().then(function (walks) {
                  // …or it resolved while this read was still out.
                  if (!$scope.state.walkNotice) { return; }
                  if (!walks.mine.length) {
                     // Stop 2 of 3: the walk settled. Noticed and ended on the
                     // same tick -- no further poll is scheduled below.
                     walkVanished(cube);
                     return;
                  }
                  var phase = $scope.state.walkNotice.phase === PHASE_EARLIER
                     ? PHASE_EARLIER
                     : PHASE_WALK;
                  setWalkNotice(cube, phase, walks.mine[0].seconds);
                  // Stop 3 of 3: the hard cap. Past it the page stops asking
                  // and keeps the server's last reading on screen; a trace of
                  // this page's own then clears it in its finally.
                  if (walkPolls < MAX_WALK_POLLS) { schedulePoll(cube); }
                  else if (!$scope.state.tracing) { clearWalkNotice(); }
               });
            };

            /* **A second, slower poll, and it exists because of when the
             * feature is needed.** The §4r poll above runs only while this
             * page has a walk of its own to report -- but the case §5a
             * describes, an admin finding somebody else's runaway trace, is
             * precisely the case where this page is doing nothing. Without
             * this the admin's list would be a single reading taken at page
             * load and never corrected, which is a permanent overlay naming
             * a walk that may have finished minutes ago.
             *
             * Kept separate rather than widening §4r's poll: that one has
             * three measured stop conditions and a test per condition, and
             * this has different ones. Slower (nobody is waiting on it),
             * capped the same two minutes, admin-only, and it stops the
             * moment the list empties. */
            var OTHER_POLL_MS = 5000;
            var MAX_OTHER_POLLS = 24;
            var otherPollTimer = null;
            var otherPolls = 0;

            var stopOtherPoll = function () {
               if (otherPollTimer) { $timeout.cancel(otherPollTimer); }
               otherPollTimer = null;
            };

            var pollOthers = function () {
               otherPollTimer = null;
               if (walkPageGone || !$scope.state.admin) { return; }
               if (!$scope.state.walks || !$scope.state.walks.others.length) { return; }
               // readWalks() refreshes the list through noteWalks, which is
               // what schedules the next tick -- one place decides both.
               readWalks();
            };

            var watchOtherWalks = function () {
               if (walkPageGone || !$scope.state.admin) { return; }
               if (!$scope.state.walks || !$scope.state.walks.others.length) {
                  otherPolls = 0;
                  stopOtherPoll();
                  return;
               }
               if (otherPollTimer || otherPolls >= MAX_OTHER_POLLS) { return; }
               otherPolls++;
               otherPollTimer = $timeout(pollOthers, OTHER_POLL_MS);
            };

            var startWalkPoll = function (cube) {
               // The second writer, guarded for the reason above: a poll begun
               // after teardown would read /Threads for a page nobody has.
               if (walkPageGone) { return; }
               stopWalkPoll();
               walkPolls = 0;
               schedulePoll(cube);
            };

            /* On load, recognise your own orphan walk and show it running.
             *
             * A reload currently produces a page that looks idle while TM1 is
             * still working *for that user* (§5a.8: at least ten more seconds
             * on the demo model, and far longer on a production-scale cell).
             * The pre-flight below has to detect that walk anyway in order to
             * warn about it, so showing it is strictly better than waiting to
             * nag -- it is what turns this from a guard into a feature.
             *
             * Nothing is claimed here. This page is not requesting anything,
             * and claiming would refuse the user a trace on the strength of a
             * walk they can only wait out. The pre-flight is what asks them
             * about it, once they actually ask for one.
             *
             * Called wherever the instance becomes known, and idempotent by
             * the two guards below rather than by a flag of its own -- which
             * also means it re-checks after a reconnect, where an orphan walk
             * is exactly as likely. */
            var showEarlierWalk = function () {
               if ($scope.state.walkNotice || $scope.state.tracing) { return; }
               readWalks().then(function (walks) {
                  if (!walks.mine.length) { return; }
                  if ($scope.state.walkNotice || $scope.state.tracing) { return; }
                  var cube = walks.mine[0].cube || "";
                  setWalkNotice(cube, PHASE_EARLIER, walks.mine[0].seconds);
                  startWalkPoll(cube);
               });
            };

            /* Asked before every fresh walk, with the claim already held.
             * Resolves true to go ahead and false only if the user said no.
             *
             * **Both messages end in a choice, never a block.** §5a.7 says one
             * trace of a wide cell is the whole exposure, so a second
             * concurrent walk is a real cost and not a catastrophe -- and a
             * plugin that refuses outright gets worked around or switched off.
             * $window.confirm, as Stage 0's two existing confirmations do:
             * consistent, blocking, and no layout risk on a page Arc clips.
             *
             * Own and other are **not** interchangeable messages. The reload
             * case is the user's *own* walk and it is the common case, because
             * a reload is what produces it; telling that user another person
             * is tracing would be a lie in the situation that happens most.
             * Own is checked first for the same reason.
             *
             * When nothing is seen, nothing is said. For a non-admin the
             * absence of another user's walk is not evidence there isn't one
             * (§5a.8), so this never reports that the server is quiet. */
            var preflightWalk = function () {
               return readWalks().then(function (walks) {
                  if (walks.mine.length) {
                     return !!$window.confirm(filled("CALCEXPLORER_OWNWALK",
                        { seconds: walks.mine[0].seconds }));
                  }
                  if (walks.others.length) {
                     return !!$window.confirm(filled("CALCEXPLORER_OTHERWALK",
                        { name: walks.others[0].user, seconds: walks.others[0].seconds }));
                  }
                  return true;
               });
            };

            /* ---- Cancelling a walk (§5d item 37, designed in §5e) --------
             *
             * Set while THIS page asks for a cancel of its OWN walk, and read
             * by the walk's error path. It is the authoritative half of
             * telling a cancellation from a failure; `core.isCancelledError`
             * is the other half, for the walk somebody else stopped, where no
             * flag anywhere on this page can be set. */
            var cancelledByMe = false;

            /* One key per refusal core names, so a reason added there cannot
             * quietly fall through to silence here. Anything unmapped reads as
             * the unreadable case, which is the honest default: the page does
             * not know what it was looking at, so it did nothing. */
            var CANCEL_REFUSALS = {
               gone: "CALCEXPLORER_CANCELGONE",
               finished: "CALCEXPLORER_CANCELGONE",
               nottrace: "CALCEXPLORER_CANCELNOTTRACE",
               notmine: "CALCEXPLORER_CANCELNOTMINE",
               unreadable: "CALCEXPLORER_CANCELUNREADABLE"
            };

            /* The tree a re-trace displaced, kept only until that walk
             * settles. §4ac's review flagged that `previewCoordinates`
             * destroys the tree on screen before it knows the new walk will
             * succeed, and a cancelled re-trace is the sharpest version of
             * that: the reader stops a walk they did not want and loses the
             * answer they already had. */
            var cancelRestore = null;

            var restoreDisplacedTree = function () {
               if (!cancelRestore) { return false; }
               $scope.trace = cancelRestore.trace;
               $scope.preview = cancelRestore.preview;
               $scope.why = cancelRestore.why;
               $scope.showRule = cancelRestore.showRule;
               /* focusId and openPath are written together, here as
                * everywhere: the view cannot render a focus whose path is not
                * open, and a test pins that pairing at every site. */
               $scope.state.focusId = cancelRestore.focusId;
               $scope.state.openPath = cancelRestore.openPath;
               cancelRestore = null;
               refreshRows();
               return true;
            };

            /* A cancelled walk is not a failed one, and it may not land in the
             * red box (§5d item 22). Two messages, because the two situations
             * are not interchangeable: one is the reader's own gesture
             * arriving, the other is somebody else's admin stopping their
             * trace, which they have to be told plainly. */
            var noteCancelled = function (byMe) {
               $scope.state.error = null;
               var restored = restoreDisplacedTree();
               var key = byMe ? "CALCEXPLORER_TRACECANCELLED" : "CALCEXPLORER_TRACECANCELLEDOTHER";
               Notification.warning({
                  title: translated("CALCEXPLORER_CANCELTITLE"),
                  message: translated(key) +
                     (restored ? " " + translated("CALCEXPLORER_CANCELRESTORED") : "")
               });
            };

            /* One POST, and everything before it is refusal.
             *
             * **The id is re-checked against a fresh /Threads read**, never
             * trusted: the row the button sits on may be a second old or five
             * minutes old, ids are reused, and §5e.3's first refusal is that
             * this plugin must not become a general thread killer. So the
             * thread has to still be there, still be a `tm1.TraceCellCalculation`,
             * still be running, and still be this user's -- or this user has to
             * be an admin.
             *
             * It is **not** a walk and must not take `claimWalk`: a cancel is
             * the one gesture that has to work while a walk is in flight. Its
             * own single-flight guard is `state.cancelling`, which doubles as
             * the button's disabled state.
             *
             * A **404 is not an error** -- measured at 8 ms on a walk that had
             * just finished -- and neither is a thread that has left `Run`.
             * Both read as "that trace had already finished".
             *
             * And it does **not** hand the server's memory back: §5a.7 measured
             * TM1 keeping its pool at the high-water mark, so no string here
             * may suggest that stopping a walk recovers anything. */
            $scope.cancelWalk = function (entry) {
               if (!entry || entry.id === null || entry.id === undefined) { return $q.when(false); }
               if ($scope.state.cancelling !== null) { return $q.when(false); }
               $scope.state.cancelling = entry.id;
               return $q.all([api("GET", "/Threads"), activeUser()])
                  .then(function (answers) {
                     var info = answers[1] || core.activeUserInfo(null);
                     var verdict = core.cancelTarget(failed(answers[0]) ? null : answers[0].data,
                        entry.id, info.name, info.isAdmin);
                     if (!verdict.ok) {
                        Notification.warning({
                           title: translated("CALCEXPLORER_CANCELTITLE"),
                           message: translated(CANCEL_REFUSALS[verdict.reason] ||
                              "CALCEXPLORER_CANCELUNREADABLE")
                        });
                        return false;
                     }
                     var target = verdict.entry;
                     /* Somebody else's walk gets a confirm that repeats all
                      * three facts the admin is acting on -- user, cube and how
                      * long it has been running -- because the page cannot know
                      * whether that trace is a runaway or the thing its owner
                      * is waiting on. Their own walk does not: they are looking
                      * at it, and a confirm on every click is furniture. */
                     if (!target.mine) {
                        if (!$window.confirm(filled("CALCEXPLORER_CANCELCONFIRM", {
                           name: target.user,
                           cube: target.cube || translated("CALCEXPLORER_CANCELNOCUBE"),
                           seconds: target.seconds === null ? "?" : target.seconds
                        }))) { return false; }
                     }
                     if (target.mine) { cancelledByMe = true; }
                     return api("POST", "/Threads(" + target.id + ")/tm1.CancelOperation")
                        .then(function (result) {
                           if (!failed(result)) {
                              Notification.success({
                                 title: translated("CALCEXPLORER_CANCELTITLE"),
                                 message: translated("CALCEXPLORER_CANCELSENT")
                              });
                              return true;
                           }
                           cancelledByMe = false;
                           if (result && result.status === 404) {
                              Notification.warning({
                                 title: translated("CALCEXPLORER_CANCELTITLE"),
                                 message: translated("CALCEXPLORER_CANCELGONE")
                              });
                              return false;
                           }
                           reportError("CALCEXPLORER_CANCELFAILED", result);
                           return false;
                        });
                  })
                  .catch(function (error) {
                     cancelledByMe = false;
                     reportError("CALCEXPLORER_CANCELFAILED", error);
                     return false;
                  })
                  .finally(function () {
                     $scope.state.cancelling = null;
                     // Whatever happened, the list on screen is now a stale
                     // reading of /Threads. One read puts that right.
                     readWalks();
                  });
            };

            /* The walk this page is running, when the page knows which thread
             * it is. Null when there is none, when the poll has not seen it
             * yet, and -- §5e.3's second refusal -- when there is **more than
             * one**: two tabs on one cell is a real shape, and the repo's rule
             * about never guessing a coordinate applies harder to a target
             * about to be killed. The list below shows both instead. */
            $scope.myWalk = function () {
               /* §5e.2: admin-gated until somebody measures whether a non-admin
                * may cancel their own walk. That test needs a granted non-admin
                * account and that user's own session, which a session may not
                * sign into on the user's behalf. */
               if (!$scope.state.admin) { return null; }
               var mine = $scope.state.walks ? $scope.state.walks.mine : null;
               if (!mine || mine.length !== 1) { return null; }
               return mine[0].id === null || mine[0].id === undefined ? null : mine[0];
            };

            /* Everything an admin may stop that is not the single walk above:
             * other people's walks, and this page's own when there are two of
             * them. Empty for everyone who is not an admin, which is what §5e.2
             * gates on until somebody runs the non-admin measurement. */
            $scope.otherWalks = function () {
               var walks = $scope.state.walks;
               if (!walks) { return []; }
               if (!$scope.state.admin) { return []; }
               var mine = walks.mine.length === 1 ? [] : walks.mine;
               return mine.concat(walks.others);
            };

            /* **One depth, both halves of the query.** `buildTraceQuery` cuts the
             * `$select` and the `$expand` to the same level, which is what turns
             * `requestedDepth()` from "how many levels come back labelled" into a
             * real bound on what the server builds (§5a.11, §5a.12) -- 83 KB and
             * ~1 s in place of 133 MB, 19 s and +437 MB of TM1 memory, for the
             * same value and the same rows the page draws. Passing that same
             * number to `normalizeTree` as `boundDepth` is what lets the tree
             * tell its own frontier from a genuine leaf.
             *
             * This comment lives ABOVE the declaration on purpose: the guard
             * test slices a measured window after the `var runTrace` line and
             * looks for `core.TRACE_ACTION` inside it, so a long comment in the
             * body pushes the thing being checked out of range. */
            var runTrace = function (cube, coordinates) {
               /* One name for the action, exported from core -- this was a literal
                * until Stage 2 found out the hard way that the constant was not
                * reachable here. */
               var path = cubePath(cube) + "/" + core.TRACE_ACTION + "?" +
                  core.buildTraceQuery(requestedDepth());
               return api("POST", path, { "Tuple@odata.bind": core.buildTupleBind(coordinates) });
            };

            /* `prior` is not optional in practice, and leaving it out was a bug
             * for as long as this function has existed (§5a.12). `normalizeTree`
             * puts `nodeBudget`, `budgetHit` and `droppedCount` on its stats;
             * this literal carried none of the three, and `deepen` assigns the
             * result **wholesale** over `$scope.trace.stats`. So the first
             * deepen of a budget-hit trace deleted the size-limit alert while
             * `node.budgetDropped` stayed on the nodes and kept rendering its
             * per-row "left out" line -- the page reported the symptom with the
             * explanation removed. These three describe the *fetch*, not the
             * tree, so a recount cannot know them and must carry them across. */
            var recomputeStats = function (root, prior) {
               var was = prior || {};
               var stats = {
                  nodeCount: 0, maxDepth: 0, leafCount: 0, ruleCount: 0,
                  unresolvedCount: 0, truncatedCount: 0, boundaryCount: 0,
                  /* The frontier card and banner read this, not
                   * `boundaryCount` -- see normalizeTree's stats literal for
                   * why. Recounted rather than carried across: a deepen moves
                   * it, exactly as it moves `boundaryCount`. */
                  fetchableCount: 0,
                  nodeBudget: was.nodeBudget,
                  budgetHit: !!was.budgetHit,
                  droppedCount: was.droppedCount || 0,
                  boundDepth: was.boundDepth,
                  cubes: {}, statements: {}
               };
               core.visitTree(root, function (node) {
                  stats.nodeCount++;
                  stats.maxDepth = Math.max(stats.maxDepth, node.depth);
                  if (node.belowBound) { stats.boundaryCount++; }
                  /* `hasChildren` rather than `children.length`, because that
                   * is the flag the twisty's own ng-if reads; `deepen` and
                   * `fill` both keep the two in step. */
                  if (node.belowBound && !node.hasChildren && core.hasDeeperLevel(node)) {
                     stats.fetchableCount++;
                  }
                  if (!node.children.length && !node.belowBound) { stats.leafCount++; }
                  if (node.statements.length) { stats.ruleCount++; }
                  if (!node.resolved) { stats.unresolvedCount++; }
                  stats.truncatedCount += (node.childTruncated || 0);
                  if (node.cube) { stats.cubes[node.cube] = (stats.cubes[node.cube] || 0) + 1; }
                  angular.forEach(node.statements, function (statement) {
                     stats.statements[statement] = (stats.statements[statement] || 0) + 1;
                  });
               });
               return stats;
            };

            // Fill in dimension names and rule-file locations for everything
            // currently in the tree.
            var enrichTree = function () {
               if (!$scope.trace) { return $q.when(); }
               var root = $scope.trace.root;
               var cubes = {};
               core.visitTree(root, function (node) {
                  if (node.cube) { cubes[node.cube] = true; }
               });
               var names = _.keys(cubes);
               var jobs = [];
               angular.forEach(names, function (cube) {
                  jobs.push(loadDimensions(cube));
                  jobs.push(loadRuleIndex(cube));
               });
               return $q.all(jobs).then(function () {
                  core.visitTree(root, function (node) {
                     node.coordinateLabel = core.coordinateLabel(node, dimensionCache);
                     if (node.statements.length && !node.statementInfo.length) {
                        var index = ruleCache[node.cube];
                        node.statementInfo = _.map(node.statements, function (statement) {
                           var key = node.cube + "\u0000" + statement;
                           if (!locationCache.hasOwnProperty(key)) {
                              locationCache[key] = index ? core.locateStatement(index, statement) : null;
                           }
                           return {
                              raw: statement,
                              formatted: core.formatStatement(statement),
                              location: locationCache[key]
                           };
                        });
                     }
                  });
                  $scope.trace.cubeList = _.sortBy(names);
                  refreshRows();
               });
            };

            var pushHistory = function (trace) {
               $scope.history.unshift({
                  instance: trace.instance,
                  cube: trace.cube,
                  coordinates: trace.coordinates,
                  label: trace.coordinateLabel,
                  value: core.formatValue(trace.root.value),
                  depth: trace.depth,
                  at: trace.generatedAt
               });
               if ($scope.history.length > HISTORY_LIMIT) {
                  $scope.history.splice(HISTORY_LIMIT, $scope.history.length - HISTORY_LIMIT);
               }
            };

            /* The walk itself, once the gesture has been allowed and the
             * server has been asked about it.
             *
             * Split out of traceCoordinates only because the pre-flight in
             * front of it is asynchronous, and this body reads better at one
             * level of indentation than inside a `.then`. It runs on a claim
             * it did **not** take and releases it in its finally: one claim,
             * one release, whichever way it ends. */
            var runWalk = function (cube, coordinates, sourceLabel, release) {
               $scope.state.error = null;
               /* A feeder result belongs to a cell, not to a trace, so it is
                * dropped only when the cell itself changes. */
               var previous = currentCell();
               if (!(previous && previous.cube === cube &&
                     core.sameCoordinates(previous.coordinates, coordinates))) {
                  $scope.feeders = null;
                  $scope.feederTarget = null;
               }
               var started = (new Date()).getTime();

               /* The indicator goes up **before** the request leaves, which is
                * the whole point of it: on Arc's cell-menu handover, an opened
                * link and a history replay the user has clicked nothing on
                * this page, so there is no control to put a spinner on and the
                * page has until now looked idle for the full 15-22 s.
                *
                * It shows the cube rather than the whole coordinate: the
                * coordinate label is unbounded in width and this badge sits in
                * the tab strip, whose measured spare room (706.6 px at a
                * 1172 px content width) was measured with a compact badge in
                * it. A CSS max-width bounds it as well -- node cannot decide
                * whether a row wraps (§4k), so the width is constrained rather
                * than trusted. */
               setWalkNotice(cube, PHASE_WALK, 0);
               startWalkPoll(cube);

               return runTrace(cube, coordinates).then(function (result) {
                  if (failed(result)) { return $q.reject(errorText(result)); }
                  var normalized = core.normalizeTree(result.data, {
                     expandDepth: 2,
                     maxChildren: MAX_CHILDREN,
                     maxNodes: MAX_NODES,
                     boundDepth: requestedDepth()
                  });
                  var label = coordinateLabelOf(coordinates);
                  $scope.trace = {
                     instance: $scope.state.instance,
                     cube: cube,
                     coordinates: coordinates,
                     coordinateLabel: label,
                     source: sourceLabel || null,
                     depth: requestedDepth(),
                     root: normalized.root,
                     stats: normalized.stats,
                     cubeList: [],
                     elapsedMs: (new Date()).getTime() - started,
                     generatedAt: (new Date()).toString()
                  };
                  $scope.state.treeCubeFilter = "";
                  $scope.state.focusId = null;
                  $scope.state.openPath = ["0"];
                  $scope.state.shareOpen = false;
                  $scope.state.filtersOpen = false;
                  /* The traced cell is the one node whose workings the reader
                   * definitely came for, so its *Why?* opens itself. "0" is the
                   * root's id, the same one openPath is seeded with. The panel
                   * sits inside the tree's own scroll box, so it costs visible
                   * rows rather than pushing the tree off a page Arc clips
                   * (2.8) -- and the *Values used* list is capped, which is
                   * what keeps that cost bounded on a wide consolidation. */
                  $scope.why = { "0": true };
                  $scope.showRule = {};
                  // The trace is now the cell on screen.
                  $scope.feederTarget = null;
                  $scope.state.activeTab = 1;
                  pushHistory($scope.trace);
                  return enrichTree();
               }).catch(function (error) {
                  /* §5e: **a cancelled walk is not a failed one**, and this
                   * is the line between them. Two signals and both are
                   * needed: the flag is authoritative for the cancel this
                   * page asked for, and TM1's own `TM1UserException: Cancel`
                   * covers the one an admin asked for on somebody else's
                   * page, where no flag here can possibly be set. */
                  if (cancelledByMe || core.isCancelledError(error)) {
                     noteCancelled(cancelledByMe);
                     return;
                  }
                  reportError("CALCEXPLORER_TRACEFAILED", error);
               }).finally(function () {
                  /* Nothing polls after the page's own trace resolves: the
                   * pending timer is cancelled here, and the notice it reads
                   * is gone either way. */
                  stopWalkPoll();
                  clearWalkNotice();
                  /* Both are about THIS walk and nothing else: a flag left
                   * set would make the next genuine failure read as a
                   * cancellation, and a tree left here would be put back
                   * under a later cell. */
                  cancelledByMe = false;
                  cancelRestore = null;
                  release();
               });
            };

            var traceCoordinates = function (cube, coordinates, sourceLabel) {
               /* Every way into a trace lands here -- grid, typed
                * coordinates, Arc's cell menu, a pasted link, history -- so
                * this is where a fresh walk is allowed or refused. Written as
                * one branch so `release` is either callable or the function
                * has already returned: a null reaching .finally() would be a
                * leaked flag and a page that never traces again. */
               var release = walkInFlight() ? null : claimWalk();
               if (!release) { declineWalk(); return $q.when(); }

               /* **The order here is the feature, and it is easy to get
                * wrong.** walkInFlight() and claimWalk() above are both
                * synchronous and both run before anything is awaited, so the
                * local guard still lands on the gesture. The claim is then
                * *held across* the pre-flight request and across the dialog it
                * may raise -- a claim taken afterwards would leave a window as
                * wide as the round trip plus however long the user leaves the
                * dialog standing, and a second local gesture would fit through
                * it.
                *
                * On Cancel the claim is released and nothing else happens; on
                * Continue the walk proceeds on the claim already held and
                * never re-claims, because claimWalk would now refuse it. */
               return preflightWalk().then(function (proceed) {
                  if (!proceed) { release(); return; }
                  return runWalk(cube, coordinates, sourceLabel, release);
               });
            };

            /* ---- Stage 2: the cheap question, asked first (§5a.7)
             *
             * §5a.7's finding with a design consequence: **the server does
             * not build the component closure unless the closure is asked
             * for.** `$select=Value` on the cell whose tree costs 18.4 s,
             * 133 MB of payload and 416 MB of server memory it never gives
             * back returned in **14 ms and 97 bytes**; the value, the rule,
             * the type, the status, the coordinate and the cube together
             * stay under 1 KB and under 60 ms.
             *
             * So a cell click no longer buys the tree. **Every entry path
             * lands here** -- grid, typed coordinates, Arc's cell menu, a
             * pasted link, a history replay -- the reader gets the number
             * *and the rule that produced it*, with its rule-file line
             * number, and `buildTree()` is the priced second step.
             *
             * This is the first thing in this repo that **reduces** what
             * item 0 costs rather than rationing how often it is paid: the
             * common question -- which rule produced this number -- is now
             * answered with no walk at all.
             *
             * **Nothing about the walk changed.** The single claim, the
             * server pre-flight and the indicator (§4r) are all still
             * exactly where v1.10.0 left them; they now sit behind one
             * button instead of behind a click.
             *
             * **Guarded by walkInFlight() for coherence, not for cost.** A
             * preview is free, but it replaces the page's subject:
             * previewing cell Y while a tree for cell X is still streaming
             * would leave the coordinate bar naming Y and the tree naming
             * X. Refusing is also exactly what a grid click did in
             * v1.10.0, so this is not a new restriction on the user. */
            /* `thenBuild` is what makes a NAMED trace request trace.
             *
             * v1.11.0 split every path into a cheap preview and a priced
             * button because a tree cost the TM1 server +437 MB (§4s). v1.12.0
             * bounded the request, so the same tree is 83 KB and zero server
             * memory at the default depth (§4u) -- and the button became a
             * dead end on the paths where the user had already said the word
             * "trace": Arc's cell menu, an opened link, History's *Re-trace*
             * and manual *Trace this cell*. A GRID click is deliberately not
             * one of them: there the user is browsing, has not asked for a
             * tree, and on a rule cell the preview IS the answer.
             *
             * It is a continuation, not a second entry point -- `buildTree`
             * stays the only caller of `traceCoordinates`, so the claim, the
             * /Threads pre-flight and the indicator are all exactly where §4r
             * left them, behind one gesture instead of two. */
            var previewCoordinates = function (cube, coordinates, sourceLabel, thenBuild) {
               if (walkInFlight() || $scope.state.previewing) {
                  /* NOT declineWalk(): nothing failed, and no walk is running.
                   * A second click during the ~1 s preview used to raise a red
                   * "Trace failed -- a trace is already running", which is
                   * three false statements produced by the most natural
                   * mistake on the fastest path in the plugin. */
                  declinePreview();
                  return $q.when();
               }
               $scope.state.previewing = true;
               var noticeTimer = $timeout(function () {
                  if ($scope.state.previewing) { setWalkNotice(cube, PHASE_PREVIEW, null); }
               }, PREVIEW_NOTICE_MS);
               var started = (new Date()).getTime();
               var path = cubePath(cube) + "/" + core.TRACE_ACTION + "?" +
                  core.buildPreviewQuery();
               return api("POST", path,
                  { "Tuple@odata.bind": core.buildTupleBind(coordinates) })
                  .then(function (result) {
                     if (failed(result)) { return $q.reject(errorText(result)); }
                     var preview = core.normalizePreview(result.data);

                     /* A preview is the page's new subject, so a tree that
                      * was on screen belongs to a different cell and goes.
                      * The feeder result goes with it unless this is the
                      * same cell, which is runWalk's rule too. */
                     var previous = currentCell();
                     if (!(previous && previous.cube === cube &&
                           core.sameCoordinates(previous.coordinates, coordinates))) {
                        $scope.feeders = null;
                     }
                     /* §5e: a walk is about to be asked for, and it can be
                      * cancelled. Keep what is on screen until that walk
                      * settles -- but only when a walk is actually going to
                      * follow AND it is the same cell, which is exactly the
                      * Re-trace case. Anything wider would put a tree back
                      * under a different cell's preview. */
                     var sameCellAsTree = !!($scope.trace &&
                        $scope.trace.cube === cube &&
                        core.sameCoordinates($scope.trace.coordinates, coordinates));
                     cancelRestore = (thenBuild && sameCellAsTree) ? {
                        trace: $scope.trace,
                        preview: $scope.preview,
                        why: $scope.why,
                        showRule: $scope.showRule,
                        focusId: $scope.state.focusId,
                        openPath: $scope.state.openPath
                     } : null;
                     $scope.trace = null;
                     $scope.feederTarget = null;
                     $scope.rows = [];
                     $scope.breadcrumb = [];

                     /* The coordinates TM1 resolved are preferred over the
                      * ones the gesture assembled -- an alternate hierarchy
                      * comes back named -- but a response without a Tuple
                      * must still leave a usable cell behind, because these
                      * are what buildTree hands to the walk. */
                     if (!preview.coordinates.length) {
                        preview.coordinates = coordinates;
                     }
                     preview.instance = $scope.state.instance;
                     preview.cube = preview.cube || cube;
                     preview.source = sourceLabel || null;
                     preview.coordinateLabel = coordinateLabelOf(preview.coordinates);
                     preview.statementsElsewhere = 0;
                     preview.elapsedMs = (new Date()).getTime() - started;
                     preview.generatedAt = (new Date()).toString();
                     $scope.preview = preview;
                     $scope.state.activeTab = 1;
                     return enrichPreview().then(function () {
                        if (!thenBuild) { return null; }
                        /* Hand the notice over before the walk starts, so the
                         * two halves read as one sequence rather than blinking
                         * between them. The walk sets its own from /Threads. */
                        clearWalkNotice();
                        return $scope.buildTree();
                     });
                  })
                  .catch(function (error) {
                     reportError("CALCEXPLORER_TRACEFAILED", error);
                  })
                  .finally(function () {
                     $timeout.cancel(noticeTimer);
                     $scope.state.previewing = false;
                     /* Clear ONLY our own phase. By the time this runs a
                        continued walk may have set its own notice, and wiping
                        that would take the indicator off a request that is
                        still in flight. */
                     if ($scope.state.walkNotice &&
                        $scope.state.walkNotice.phase === PHASE_PREVIEW) {
                        clearWalkNotice();
                     }
                  });
            };

            /* The rule with its **line number**, which is the half of a
             * preview a reader cannot get from Arc any other way. Two cheap
             * reads for the one cube -- its dimension list and its rule
             * index -- against enrichTree's one pair per cube over a whole
             * tree.
             *
             * **§4m's lesson is the trap here: a cell's own rule is not
             * reliably the first statement it returns.** The demo model's
             * `New Store Opening (hide)` answers with ten, nine of them its
             * components' and its own last. `core.ownStatements` is the
             * same filter the tree's Calculation section uses, so a preview
             * and a tree name the same rule for the same cell -- and what
             * it sets aside is counted rather than silently dropped.
             *
             * The identity check before writing is not decoration: these
             * are two awaited requests, and a second preview can land while
             * they are in flight. */
            var enrichPreview = function () {
               var preview = $scope.preview;
               if (!preview || !preview.cube) { return $q.when(); }
               var cube = preview.cube;
               return $q.all([loadDimensions(cube), loadRuleIndex(cube)])
                  .then(function () {
                     if ($scope.preview !== preview) { return; }
                     var label = core.coordinateLabel(preview, dimensionCache);
                     if (label) { preview.coordinateLabel = label; }
                     var own = core.ownStatements(preview);
                     preview.statementsElsewhere =
                        (preview.statements || []).length - own.length;
                     var index = ruleCache[cube];
                     preview.statementInfo = _.map(own, function (statement) {
                        var key = cube + "\u0000" + statement;
                        if (!locationCache.hasOwnProperty(key)) {
                           locationCache[key] = index
                              ? core.locateStatement(index, statement)
                              : null;
                        }
                        return {
                           raw: statement,
                           formatted: core.formatStatement(statement),
                           location: locationCache[key]
                        };
                     });
                  });
            };

            /* **The priced second step, and the only gesture that now
             * reaches a walk.** Everything expensive is still
             * `traceCoordinates`: the claim held across the pre-flight, the
             * `/Threads` read, the dialog and the indicator, all unchanged
             * since v1.10.0.
             *
             * It hands over the coordinates **TM1 resolved** for the
             * preview rather than the ones the click assembled, which is a
             * strictly better starting point and the reason the preview
             * keeps them. */
            $scope.buildTree = function () {
               var preview = $scope.preview;
               if (!preview || !preview.cube) { return $q.when(); }
               return traceCoordinates(preview.cube, preview.coordinates,
                  preview.source);
            };

            // Coordinates for a clicked grid cell: column + row + title members
            // put back into cube dimension order.
            /* Returns the preview's promise, and returns one on every path
              * including a refusal. Until v1.11.1 this returned `undefined`,
              * so an awaiting caller resolved in ~2 ms while the request was
              * still in flight -- harmless in the page, where nothing awaits
              * it, and actively misleading to anything driving the scope from
              * a console, which is how this repo verifies (§4k). */
            $scope.traceCell = function (cell) {
               if (!$scope.grid) { return $q.when(); }
               /* 5a: this was the one entry point with no guard at all, and
                * it is the main way in. A click fired a full server walk,
                * nothing on screen said so, and clicking again fired another
                * -- so the cheapest way to ask the server for the expensive
                * walk twice was to wonder whether the first click had
                * registered. The cell spinner below is the other half of
                * that: the guard stops the second walk, the spinner stops
                * the second click. */
               if (walkInFlight()) { return $q.when(); }
               var members = [];
               angular.forEach(cell.column.members, function (member) { members.push(member); });
               angular.forEach(cell.row.members, function (member) { members.push(member); });
               angular.forEach($scope.grid.titles, function (title) {
                  angular.forEach(title.members, function (member) { members.push(member); });
               });
               var ordered = core.orderCoordinates($scope.grid.dimensions, members);
               if (!ordered.ok) {
                  reportError("CALCEXPLORER_TRACEFAILED",
                     "Could not resolve a full coordinate — missing: " + ordered.missing.join(", "));
                  return $q.when();
               }
               var label = $scope.state.mode === "mdx"
                  ? "MDX"
                  : ($scope.state.view.private ? "Private view " : "View ") + $scope.state.view.name;
               $scope.state.tracingCell = cell.ordinal;
               return previewCoordinates($scope.grid.cube, ordered.coordinates, label)
                  .finally(function () { $scope.state.tracingCell = null; });
            };

            /* Fills the manual coordinate rows from a pasted cell reference.
             * Element order follows the cube's dimension order, which is what
             * Arc's DB() reference uses. */
            /* A pasted table names its own dimensions, so the rows are matched
             * by name and may arrive in any order. Anything the cube does not
             * have is reported rather than shifting every later coordinate. */
            var applyReferencePairs = function (cube, pairs) {
               return loadDimensions(cube).then(function (dimensions) {
                  if (!dimensions || !dimensions.length) {
                     return $q.reject(translated("CALCEXPLORER_CELLREFBAD"));
                  }
                  var byName = {};
                  angular.forEach(pairs, function (pair) {
                     byName[String(pair.dimension).toUpperCase()] = pair;
                  });
                  var matched = 0;
                  $scope.manual.rows = _.map(dimensions, function (dimension) {
                     var pair = byName[String(dimension).toUpperCase()];
                     if (pair) { matched++; }
                     return {
                        dimension: dimension,
                        // Arc reports the hierarchy per member, and a trace of
                        // an alternate hierarchy needs it.
                        hierarchy: (pair && pair.hierarchy) || dimension,
                        element: pair ? pair.element : ""
                     };
                  });
                  $scope.state.cube = cube;
                  if (!matched) {
                     return $q.reject(cube + ": " +
                        translated("CALCEXPLORER_CELLREFNOMATCH"));
                  }
                  if (matched < dimensions.length) {
                     Notification.success({
                        title: translated("CALCEXPLORER_CELLREF"),
                        message: matched + " / " + dimensions.length + " " +
                           translated("CALCEXPLORER_CELLREFPARTIAL")
                     });
                     return;
                  }
                  $scope.manual.reference = "";
                  return $scope.traceManual();
               });
            };

            $scope.applyCellReference = function () {
               var parsed = core.parseCellReference($scope.manual.reference);
               if (!parsed) {
                  reportError("CALCEXPLORER_TRACEFAILED", translated("CALCEXPLORER_CELLREFBAD"));
                  return;
               }
               if (parsed.pairs) {
                  var pairCube = parsed.cube || $scope.state.cube;
                  if (!pairCube) {
                     reportError("CALCEXPLORER_TRACEFAILED", translated("CALCEXPLORER_PICKCUBEFIRST"));
                     return;
                  }
                  applyReferencePairs(pairCube, parsed.pairs).catch(function (error) {
                     reportError("CALCEXPLORER_TRACEFAILED", error);
                  });
                  return;
               }
               var cube = parsed.cube || $scope.state.cube;
               if (!cube) {
                  reportError("CALCEXPLORER_TRACEFAILED", translated("CALCEXPLORER_PICKCUBEFIRST"));
                  return;
               }
               loadDimensions(cube).then(function (dimensions) {
                  if (!dimensions || !dimensions.length) {
                     return $q.reject(translated("CALCEXPLORER_CELLREFBAD"));
                  }
                  if (parsed.elements.length !== dimensions.length) {
                     return $q.reject(cube + ": " + dimensions.length + " dimensions, " +
                        parsed.elements.length + " elements pasted.");
                  }
                  $scope.state.cube = cube;
                  $scope.manual.rows = _.map(dimensions, function (dimension, index) {
                     return {
                        dimension: dimension,
                        hierarchy: dimension,
                        element: parsed.elements[index] || ""
                     };
                  });
                  $scope.manual.reference = "";
                  return $scope.traceManual();
               }).catch(function (error) {
                  reportError("CALCEXPLORER_TRACEFAILED", error);
               });
            };

            $scope.traceManual = function () {
               if (!$scope.state.cube) { return $q.when(); }
               var incomplete = _.filter($scope.manual.rows, function (row) { return !row.element; });
               if (incomplete.length) {
                  reportError("CALCEXPLORER_TRACEFAILED", "Every dimension needs an element.");
                  return $q.when();
               }
               return previewCoordinates($scope.state.cube, _.map($scope.manual.rows, function (row) {
                  return { dimension: row.dimension, hierarchy: row.hierarchy || row.dimension, element: row.element };
               }), "Manual coordinates", true);
            };

            $scope.replay = function (item) {
               $scope.state.instance = item.instance;
               $scope.state.cube = item.cube;
               // "Re-trace" now re-traces. It said so before it did it.
               return previewCoordinates(item.cube, item.coordinates, "History", true);
            };

            /* The trace toolbar's Re-trace (5d item 26), and it is `replay`'s
             * shape with the cell read off the page instead of off a history
             * row -- deliberately, because that is the shape this repo has
             * already proved it can keep gated.
             *
             * **It adds no gate of its own**, and that is the point rather than
             * an omission: `previewCoordinates` is the one named-gesture path
             * (4y), and it already holds the walkInFlight/previewing refusal,
             * the visible decline, the single claim and the walkbar. Four
             * consecutive releases shipped a gesture that reached a walk around
             * the side of all that -- the grid (4o), the per-node Resolve
             * (5a.12), the frontier twisty (v1.12.0) and the operand chip (item
             * 36) -- so a tenth one growing its own is the failure mode, not the
             * missing feature. The button carries ng-disabled as well, because a
             * gate in the function alone still invites the click.
             *
             * The depth it re-runs at is `state.depth`, which the spinner beside
             * it writes: that is the whole point of the pair. `traceCoordinates`
             * reads `requestedDepth()` when it builds the query, so nothing has
             * to be passed.
             *
             * **The confirmation is gated on the raise, not on the gesture**,
             * and that division is the finding rather than a preference.
             * `CALCEXPLORER_PREVIEWCOST` -- the one paragraph on this page that
             * carries the measured depth curve -- lives under `ng-if="preview"`,
             * and this toolbar lives under `ng-if="trace"`, so the two are never
             * on screen together. At the moment this button is clicked the only
             * cost statement in reach is its own tooltip, while the spinner
             * beside it goes to 12. So a re-trace ABOVE the depth the tree on
             * screen was built at says the price first, in `DRILLCONFIRM`'s
             * register; a re-trace at the same depth or shallower is the common
             * path -- re-running after an edit, coming back down -- and stays
             * modal-free, because a prompt on every click is furniture and
             * teaches the reader to dismiss the one that matters.
             *
             * `stats.boundDepth` is what the tree was built at (`normalizeTree`
             * stamps it from `requestedDepth()`), and `requestedDepth()` is what
             * the walk will actually ask for -- the clamped value, not raw
             * `state.depth`, or the prompt would quote a number the request is
             * not going to use.
             *
             * The source label has a key of its own rather than borrowing the
             * button's, which is `CALCEXPLORER_OPERANDSOURCE`'s arrangement: the
             * coordinate bar's label names where a trace came FROM, and it is
             * only the English that makes it the same word as the control. */
            $scope.retrace = function () {
               if (!$scope.trace) { return $q.when(); }
               var now = requestedDepth();
               var was = $scope.trace.stats ? $scope.trace.stats.boundDepth : null;
               /* `typeof` rather than truthiness: an unbounded tree carries
                * `boundDepth` null and there is no raise to warn about. */
               if (typeof was === "number" && now > was) {
                  if (!$window.confirm(filled("CALCEXPLORER_RETRACECONFIRM",
                        { was: was, now: now }))) {
                     // §4t: every path returns its promise, refusals included.
                     return $q.when();
                  }
               }
               return previewCoordinates($scope.trace.cube, $scope.trace.coordinates,
                  translated("CALCEXPLORER_RETRACESOURCE"), true);
            };

            /* The frontier banner's sentence (5d item 26). Built with `filled`
             * rather than `translated(key) + " " + n`, because both numbers sit
             * in the middle of it -- "96 of these 115 rows..." -- and the
             * concatenating form cannot reach there.
             *
             * Returns "" rather than null at 0 so the template's ng-if and this
             * function cannot disagree about whether there is anything to say;
             * the ng-if is what actually suppresses the box.
             *
             * The first number is `fetchableCount`, not `boundaryCount`: the
             * sentence names the ⊞ as the thing to do about it, so it has to
             * count the rows that draw one. See normalizeTree's stats literal
             * for the shape where the two differ. */
            $scope.frontierNote = function () {
               if (!$scope.trace || !$scope.trace.stats ||
                  !$scope.trace.stats.fetchableCount) { return ""; }
               return filled("CALCEXPLORER_FRONTIERNOTE", {
                  boundary: $scope.trace.stats.fetchableCount,
                  total: $scope.trace.stats.nodeCount
               });
            };

            $scope.clearHistory = function () {
               $scope.history.splice(0, $scope.history.length);
            };

            // Re-root a trace at any labelled node and splice the result in —
            // this is what makes the effective depth unlimited.
            var deepen = function (node) {
               if (!node.resolved || node.busy) { return $q.when(false); }
               /* A deepen re-roots the trace at this node, which means it is a
                * *second full walk* and not a continuation of the first one.
                * node.busy only ever stopped the same node being asked twice;
                * two different nodes could walk in parallel, and a caret could
                * walk while a fresh trace was still running. Hence the same
                * single claim a trace makes -- and claimWalk reads only
                * state.tracing, so a sweep can still take its hops. */
               var release = claimWalk();
               if (!release) { return $q.when(false); }
               node.busy = true;
               return loadDimensions(node.cube).then(function () {
                  // Uses the hierarchy the trace itself reported for each member,
                  // falling back to the cube's primary hierarchies.
                  var coordinates = core.coordinatesOf(node, dimensionCache);
                  if (!coordinates) {
                     return $q.reject("The coordinates of this node could not be resolved for cube " + node.cube + ".");
                  }
                  return runTrace(node.cube, coordinates);
               }).then(function (result) {
                  if (failed(result)) { return $q.reject(errorText(result)); }
                  /* A deepen re-roots at `node`, so the subtree's own depths
                   * start at 0 again and its frontier is `requestedDepth()`
                   * levels below THIS node -- the same bound, measured from a
                   * new origin. */
                  var subtree = core.normalizeTree(result.data, {
                     expandDepth: 2,
                     maxChildren: MAX_CHILDREN,
                     maxNodes: MAX_NODES,
                     boundDepth: requestedDepth()
                  });
                  node.children = subtree.root.children;
                  node.hasChildren = node.children.length > 0;
                  node.childTruncated = subtree.root.childTruncated;
                  node.statements = subtree.root.statements;
                  node.statementInfo = [];
                  node.expanded = true;
                  node.deepened = true;
                  /* **Not the frontier any more**: it was a bounded stub and we
                   * just asked what is under it. `belowBound` is otherwise
                   * stamped once and never recomputed (§5a.12 -- `reassignIds`
                   * rewrites `depth`), so this is the one place that has to
                   * clear it. Left set, it made `recomputeStats` count a
                   * deepened node as boundary, and made an unmatched operand on
                   * it claim its components "were not fetched" when they had
                   * been (§5d item 36). A deepen that comes back with no children
                   * now reads as the proven leaf it is, rather than as a stub
                   * offering to fetch what is not there. */
                  node.belowBound = false;
                  core.reassignIds(node, node.id, node.depth);
                  // This node's children just changed, so its operands did.
                  delete node.calcView;
                  $scope.trace.stats = recomputeStats($scope.trace.root, $scope.trace.stats);
                  return enrichTree().then(function () { return true; });
               }).catch(function (error) {
                  reportError("CALCEXPLORER_TRACEFAILED", error);
                  return false;
               }).finally(function () {
                  node.busy = false;
                  release();
               });
            };

            /* The frontier twisty (§4u) calls this, and until now a click on
             * it during a walk was dropped in silence -- the ninth ungated
             * gesture, introduced by the release that closed the eighth. It
             * also returned nothing, against §4t's every-path contract. */
            $scope.traceDeeper = function (node) {
               if (walkInFlight()) { declineWalk(); return $q.when(false); }
               return deepen(node);
            };

            // Walk the biggest contributor down as far as it goes.
            $scope.autoDrill = function () {
               if (!$scope.trace || walkInFlight()) { return; }
               /* Every hop re-traces, so one click here can ask the server for
                * MAX_DRILL_HOPS full walks. That is not a reason to withdraw
                * the button -- it is a reason not to spend them silently while
                * 5a item 0 is open. The number is the whole point of the
                * prompt, so it is in the message rather than implied by it. */
               if (!$window.confirm(translated("CALCEXPLORER_DRILLCONFIRM") + " " +
                     MAX_DRILL_HOPS)) {
                  return;
               }
               $scope.state.autoDrilling = true;
               var hops = 0;

               var step = function (node) {
                  if (hops >= MAX_DRILL_HOPS) { return $q.when(node); }
                  node.expanded = true;
                  var next = core.biggestChild(node);
                  if (!next) {
                     if (core.hasDeeperLevel(node) && !node.deepened) {
                        return deepen(node).then(function (ok) {
                           if (!ok) { return node; }
                           var child = core.biggestChild(node);
                           if (!child) { return node; }
                           hops++;
                           return step(child);
                        });
                     }
                     return $q.when(node);
                  }
                  hops++;
                  return step(next);
               };

               step($scope.trace.root).then(function (node) {
                  /* **`openPath` as well as `focusId`, and the pairing is the fix.**
                   * `step()` sets `node.expanded` down the chain it walks, but in the
                   * business view `refreshRows()` calls `core.applyOpenPath`, which
                   * hard-resets `expanded` on EVERY node to exactly the `openPath`
                   * chain -- so a drill that never wrote `openPath` had its whole
                   * result erased one line later.
                   *
                   * Measured in the running app before the fix, business view, a
                   * 28-node tree: `focusId` moved null -> "0.0.1" while `openPath`,
                   * the expanded set, the row count and the deepest rendered row all
                   * stayed exactly as they were, and the focused node was not among
                   * the rendered rows at all. The user had just accepted a prompt
                   * naming up to 15 server traces.
                   *
                   * This is `jumpTo`'s pattern, which had it right all along. */
                  $scope.state.focusId = node ? node.id : null;
                  $scope.state.openPath = core.openPathIds(node ? node.id : "0");
                  refreshRows();
                  Notification.success({
                     title: translated("CALCEXPLORER_AUTODRILL"),
                     message: translated("CALCEXPLORER_AUTODRILLDONE") + " " + hops
                  });
               }).finally(function () {
                  $scope.state.autoDrilling = false;
               });
            };

            // ---------------------------------------------------------------
            // Tree rendering / filtering
            // ---------------------------------------------------------------

            var buildBreadcrumb = function () {
               if ($scope.state.viewMode !== "business" || !$scope.trace) { return []; }
               var deepest = $scope.state.openPath.length
                  ? $scope.state.openPath[$scope.state.openPath.length - 1]
                  : "0";
               var chain = core.pathTo($scope.trace.root, deepest);
               return _.map(chain, function (node, index) {
                  return {
                     id: node.id,
                     label: index === 0
                        ? $scope.trace.cube
                        : ((node.business && node.business.text) || core.namesOnly(node)),
                     value: core.formatValue(node.value)
                  };
               });
            };

            var refreshRows = function () {
               if (!$scope.trace) { $scope.rows = []; $scope.breadcrumb = []; return; }
               var business = $scope.state.viewMode === "business";
               if (business) { core.applyOpenPath($scope.trace.root, $scope.state.openPath); }
               $scope.rows = core.flatten($scope.trace.root, {
                  text: $scope.state.filterText,
                  hideZero: $scope.state.hideZero,
                  rulesOnly: $scope.state.rulesOnly,
                  cube: $scope.state.treeCubeFilter,
                  sortByContribution: business && $scope.state.sortByContribution,
                  maxRows: MAX_ROWS
               });
               $scope.breadcrumb = buildBreadcrumb();
            };

            $scope.setViewMode = function (mode) {
               $scope.state.viewMode = mode;
               // The Filters trigger is a technical-view control, so leaving the
               // flag set would reopen the panel on the way back.
               $scope.state.filtersOpen = false;
               if (mode === "business") {
                  // Business defaults, all still overridable in the toolbar.
                  $scope.state.hideZero = true;
                  $scope.state.sortByContribution = true;
                  $scope.state.rulesOnly = false;
                  $scope.state.filterText = "";
                  if (!$scope.state.openPath.length) { $scope.state.openPath = ["0"]; }
               } else {
                  $scope.state.hideZero = false;
                  core.visitTree($scope.trace ? $scope.trace.root : { children: [] }, function (node) {
                     node.expanded = node.depth < 2;
                  });
               }
               refreshRows();
            };

            /* One branch open at a time. Clicking an open row closes it;
             * clicking a row with nothing under it yet fetches the next level,
             * so "keep asking why" is just repeated clicking. */
            $scope.drill = function (node) {
               if (node.expanded && node.hasChildren) {
                  var ids = core.openPathIds(node.id);
                  ids.pop();
                  $scope.state.openPath = ids.length ? ids : ["0"];
                  refreshRows();
                  return;
               }
               if (!node.hasChildren) {
                  /* walkInFlight() as well as node.busy: deepen() would refuse
                   * on its own claim anyway, but it would refuse *silently*,
                   * and a business-view row that does nothing on click reads
                   * as broken rather than as busy. Same gate as every other
                   * gesture, for the same reason. */
                  if (core.hasDeeperLevel(node) && !node.deepened && !node.busy &&
                        !walkInFlight()) {
                     deepen(node).then(function (ok) {
                        if (ok) { $scope.state.openPath = core.openPathIds(node.id); }
                        refreshRows();
                     });
                  }
                  return;
               }
               $scope.state.openPath = core.openPathIds(node.id);
               refreshRows();
            };

            $scope.jumpTo = function (id) {
               $scope.state.openPath = core.openPathIds(id);
               refreshRows();
            };

            /* **An operand chip is a place a reader wants to go**, and until now
             * nothing on it was clickable — matched or not (§5d item 36 step 4).
             * The value came from somewhere and the panel knew where; it just
             * did not say. `token.nodeId` has been set on every matched token
             * since v1.7 and read by nothing at all.
             *
             * Two destinations, and which one applies is a property of the token
             * rather than a choice the reader has to make:
             *
             *   matched   -> the component is already in this tree. Open it
             *                where it sits. **No request.**
             *   unmatched -> TM1 reported no component for it, so the only route
             *                to a value is to ask about that cell.
             *
             * The second one reaches a walk, and this plugin has form here — four
             * releases running closed one ungated gesture while introducing the
             * next (§5d item 23). So it adds **no gate of its own**: it goes
             * through `previewCoordinates`, the same named-gesture path the cell
             * menu, a link, History and manual mode all use (§4v item 19), which
             * is where the claim, the decline and the walkbar already live. */
            $scope.operandTarget = function (node, token) {
               if (!node || !token || !token.ref) { return null; }
               if (token.nodeId) { return "jump"; }
               return core.operandCoordinates(node, token.refPairs) ? "trace" : null;
            };

            $scope.operandClick = function (node, token) {
               var target = $scope.operandTarget(node, token);
               if (!target) { return $q.when(false); }
               if (target === "jump") {
                  $scope.jumpTo(token.nodeId);
                  return $q.when(true);
               }
               return previewCoordinates(node.cube,
                  core.operandCoordinates(node, token.refPairs),
                  translated("CALCEXPLORER_OPERANDSOURCE"), true);
            };

            /* One title for the chip, because the reader needs the same two
             * things whatever the token is: why it reads what it reads, and what
             * a click will do. A chip that leads nowhere says only the first,
             * rather than offering something that will not happen. */
            $scope.operandHint = function (node, token) {
               var target = $scope.operandTarget(node, token);
               if (token.matched) {
                  return target === "jump" ? translated("CALCEXPLORER_OPERANDJUMP") : "";
               }
               var why = node.belowBound
                  ? translated("CALCEXPLORER_OPERANDBOUNDED")
                  : (token.dropped
                     ? translated("CALCEXPLORER_OPERANDDROPPED")
                     : translated("CALCEXPLORER_UNMATCHED"));
               return target === "trace"
                  ? why + " — " + translated("CALCEXPLORER_OPERANDTRACE")
                  : why;
            };

            // The `+` caret and the technical view's deeper button both read
            // this, so neither can offer a level a stored input does not have.
            $scope.hasDeeperLevel = core.hasDeeperLevel;

            $scope.toggleWhy = function (node) {
               $scope.why[node.id] = !$scope.why[node.id];
            };

            $scope.showRule = {};
            $scope.toggleRule = function (node) {
               $scope.showRule[node.id] = !$scope.showRule[node.id];
            };

            /* Memoised: the template asks for this on every digest of an open
             * row, and it must hand back the same object each time or Angular
             * never settles.
             *
             * The memo lives **on the node**, and that is the whole point. It
             * used to be a map keyed by `node.id`, and an id is only unique
             * within one trace: every re-trace has a window where the new tree
             * is already in `$scope.trace` while `$scope.rows` still holds the
             * old one, because `enrichTree` is asynchronous and `refreshRows`
             * only runs when it resolves. A digest in that window filled key
             * "0" from the *old* root, and every later ask for the new root got
             * that answer back -- one cell's coordinates above another cell's
             * formula and another cell's values. Measured in the running app:
             * a consolidation of 8 retailers reporting Store Cost's GMWA rule.
             * Emptying the map first did not help; the refill is what lands.
             *
             * A node object belongs to exactly one trace, so keyed this way
             * there is no window, nothing to invalidate on a new trace, and no
             * reset for a later code path to forget. `hasOwnProperty` rather
             * than a truth test because a node with no formula memoises null. */
            $scope.calcFor = function (node) {
               if (!node.hasOwnProperty("calcView")) {
                  node.calcView = core.calculationView(node);
               }
               return node.calcView;
            };

            var nearestResolvedAncestor = function (node) {
               var chain = core.pathTo($scope.trace.root, node.id);
               for (var i = chain.length - 1; i >= 0; i--) {
                  if (chain[i].resolved) { return chain[i]; }
               }
               return null;
            };

            // A node below the requested depth has no coordinates of its own,
            // so the fix is to re-trace the nearest ancestor that does.
            /* **The gesture gate was missing here, and it was the last hole in
             * Stage 0's guard (§5a.12).** Every other gesture that reaches a
             * server walk reads `walkInFlight()` first; this one read only
             * `$scope.trace`, and its buttons carried no `ng-disabled`. Two
             * consequences, and the second is the one §4o exists to prevent:
             * `deepen`'s own `claimWalk()` refuses while `state.tracing` is set,
             * but a sweep releases that flag *between hops* while
             * `state.resolving` stays true, so a click in the gap was not
             * refused at all; and in the ordinary case the button stayed enabled
             * during a walk and the click was dropped in **silence** -- exactly
             * the "invites a click it would drop" defect v1.9.0 fixed for the
             * grid. `declineWalk()` makes the refusal say so. */
            $scope.resolve = function (node) {
               if (!$scope.trace) { return $q.when(); }
               if (walkInFlight()) { declineWalk(); return $q.when(); }
               var target = nearestResolvedAncestor(node);
               if (!target) {
                  reportError("CALCEXPLORER_TRACEFAILED", translated("CALCEXPLORER_NORESOLVE"));
                  return $q.when();
               }
               return deepen(target).then(function () { refreshRows(); });
            };

            var hasUnresolvedChild = function (node) {
               for (var i = 0; i < node.children.length; i++) {
                  if (!node.children[i].resolved) { return true; }
               }
               return false;
            };

            /* Sweep the whole tree, deepening every boundary where labels ran
             * out. Capped, and it says so when the cap is what stopped it. */
            /* Offered only while sweeping can plausibly finish the job. At
             * 241,574 unresolved levels (a real number from the test model) the
             * button would promise to fix a rounding error's worth of them. */
            $scope.canResolveAll = function () {
               if (!$scope.trace) { return false; }
               var count = $scope.trace.stats.unresolvedCount;
               return count > 0 && count <= RESOLVE_ALL_LIMIT;
            };

            $scope.resolveAll = function () {
               if (!$scope.trace || walkInFlight()) { return; }
               var MAX_SWEEPS = 12;
               var pending = [];
               core.visitTree($scope.trace.root, function (node) {
                  if (core.hasDeeperLevel(node) && !node.deepened && node.children.length && hasUnresolvedChild(node)) {
                     pending.push(node);
                  }
               });
               if (!pending.length) {
                  Notification.success({
                     title: translated("CALCEXPLORER_RESOLVEALL"),
                     message: translated("CALCEXPLORER_NOTHINGTORESOLVE")
                  });
                  return;
               }
               var capped = pending.length > MAX_SWEEPS;
               var batch = pending.slice(0, MAX_SWEEPS);
               /* Unlike auto-drill this knows exactly how many walks it is
                * about to ask for, so it says the real number. */
               if (!$window.confirm(translated("CALCEXPLORER_RESOLVECONFIRM") + " " +
                     batch.length)) {
                  return;
               }
               $scope.state.resolving = true;
               var index = 0;
               var next = function () {
                  if (index >= batch.length) { return $q.when(); }
                  return deepen(batch[index++]).then(next);
               };
               next().then(function () {
                  refreshRows();
                  Notification.success({
                     title: translated("CALCEXPLORER_RESOLVEALL"),
                     message: batch.length + " " + translated("CALCEXPLORER_RESOLVED") +
                        (capped ? " " + translated("CALCEXPLORER_RESOLVECAPPED") : "")
                  });
               }).finally(function () {
                  $scope.state.resolving = false;
               });
            };
            $scope.refreshRows = refreshRows;

            $scope.toggle = function (node) {
               node.expanded = !node.expanded;
               refreshRows();
            };

            $scope.expandAll = function () {
               if (!$scope.trace) { return; }
               core.visitTree($scope.trace.root, function (node) { node.expanded = true; });
               refreshRows();
            };

            $scope.collapseAll = function () {
               if (!$scope.trace) { return; }
               core.visitTree($scope.trace.root, function (node) { node.expanded = node.depth === 0; });
               refreshRows();
            };

            $scope.indentStyle = function (node) {
               return { "padding-left": (node.indent * 18) + "px" };
            };

            $scope.barStyle = function (node) {
               var share = node.absShare === null || node.absShare === undefined ? 0 : node.absShare;
               return { width: Math.max(1, Math.round(share * 100)) + "%" };
            };

            $scope.cubeCount = function () {
               return $scope.trace ? _.keys($scope.trace.stats.cubes).length : 0;
            };

            // ---------------------------------------------------------------
            // Feeder diagnostics
            // ---------------------------------------------------------------

            /* The two feeder calls need only a cube and a coordinate, so this
             * does not require a calculation trace to have been run first --
             * which is what lets Arc's own Trace Feeders hand a cell straight to
             * this tab (see the takeover at the top of the file). */
            $scope.loadFeeders = function () {
               var cell = currentCell();
               /* Returns its promise on every path, including this one. A
                * Trace Feeders handover ends `return $scope.loadFeeders();`,
                * and until item 10 went through here that returned `undefined`
                * -- so the handover reported itself finished while the request
                * it exists for was still out. §4t made this the rule for every
                * other entry point; this one was missed. */
               if (!cell) { return $q.when(false); }
               var body = { "Tuple@odata.bind": core.buildTupleBind(cell.coordinates) };
               var base = cubePath(cell.cube);
               $scope.state.loadingFeeders = true;
               $scope.feeders = null;

               // Try to label the fed cells; fall back to the plain call if the
               // server will not expand them.
               return api("POST", base + "/tm1.TraceFeeders?$expand=FedCells/Tuple($select=Name),FedCells/Cube($select=Name)", body)
                  .then(function (result) {
                     if (failed(result)) { return api("POST", base + "/tm1.TraceFeeders", body); }
                     return result;
                  })
                  .then(function (result) {
                     var traced = failed(result) ? null : result.data;
                     return api("POST", base + "/tm1.CheckFeeders", body).then(function (checked) {
                        var feeders = {
                           statements: traced ? (traced.Statements || []) : [],
                           fedCells: traced ? (traced.FedCells || []) : [],
                           checked: failed(checked) ? [] : (checked.data.value || []),
                           traceError: traced ? null : errorText(result),
                           checkError: failed(checked) ? errorText(checked) : null,
                           raw: { trace: traced, check: failed(checked) ? null : checked.data }
                        };
                        /* The rows are built once, here, rather than by a filter in
                         * the markup: `Fed` is a three-state answer and the row has
                         * to carry its own open/closed state, neither of which
                         * survives being recomputed on every digest.
                         *
                         * Dimension names are what make a six-member coordinate
                         * readable, so every cube a row names is looked up first.
                         * The traced cube is always already cached -- every entry
                         * point to this tab loads it for the coordinate bar -- so in
                         * the ordinary case this adds no request at all. A fed cell
                         * in ANOTHER cube (a link rule feeding across) costs one
                         * small metadata GET, once, and `loadDimensions` caches and
                         * never throws: a cube it cannot read simply leaves that
                         * row's elements in server order with no dimension claimed
                         * against them. */
                        var cubes = {};
                        var collect = function (list) {
                           _.forEach(list, function (item) {
                              var name = item && item.Cube ? item.Cube.Name : null;
                              if (name) { cubes[name] = true; }
                           });
                        };
                        collect(feeders.fedCells);
                        collect(feeders.checked);
                        return $q.all(_.map(_.keys(cubes), loadDimensions)).then(function () {
                           var row = function (item) { return core.normalizeFedCell(item, dimensionCache); };
                           feeders.fedRows = _.map(feeders.fedCells, row);
                           feeders.checkRows = _.map(feeders.checked, row);
                           feeders.fedSummary = core.fedCellSummary(feeders.fedRows);
                           $scope.feeders = feeders;
                        });
                     });
                  })
                  .catch(function (error) {
                     reportError("CALCEXPLORER_FEEDERSFAILED", error);
                  })
                  .finally(function () {
                     $scope.state.loadingFeeders = false;
                  });
            };

            /* The tick is per row, but the thing worth leading with is the count
             * of rows that do NOT have one: those are cells a feeder statement
             * names and nothing reaches, which is where a consolidation over
             * them starts reading low.
             *
             * `unknown` is deliberately kept out of this sentence and given its
             * own muted line in the markup. A server that did not report `Fed`
             * has said nothing, and nothing may be totalled up as a fault. */
            $scope.fedNote = function () {
               var summary = $scope.feeders ? $scope.feeders.fedSummary : null;
               if (!summary || !summary.unfed) { return ""; }
               return filled("CALCEXPLORER_FEDUNFEDNOTE", {
                  unfed: summary.unfed,
                  total: summary.total
               });
            };


            // ---------------------------------------------------------------
            // Export
            // ---------------------------------------------------------------

            var buildPayload = function () {
               var trace = $scope.trace;
               return {
                  instance: trace.instance,
                  cube: trace.cube,
                  viewName: trace.source,
                  coordinateLabel: trace.coordinateLabel,
                  depth: trace.depth,
                  generatedAt: trace.generatedAt,
                  root: trace.root,
                  stats: trace.stats,
                  dimensionsByCube: dimensionCache
               };
            };

            var safeFileName = function (extension) {
               var trace = $scope.trace;
               var base = (trace.cube + " " + trace.coordinateLabel).replace(/[^A-Za-z0-9 _-]+/g, " ")
                  .replace(/\s+/g, " ").trim().substring(0, 90);
               return "trace " + base + extension;
            };

            var describeSize = function (bytes) {
               return bytes >= 1048576
                  ? (bytes / 1048576).toFixed(1) + " MB"
                  : Math.max(1, Math.round(bytes / 1024)) + " KB";
            };

            /* The export embeds every node it renders, so a big trace becomes a
             * big file — measured live, a 20,000 node trace of this model came
             * to 81 MB. The page is built first and the *real* size put in the
             * question, because "20,000 nodes" means nothing to a reader while
             * "81.1 MB" means "do not email this". Null means "user said no". */
            var guardedReport = function () {
               var html = core.buildHtmlReport(buildPayload());
               if (html.length > EXPORT_BYTES_WARN &&
                     !window.confirm(describeSize(html.length) + " " +
                        translated("CALCEXPLORER_BIGEXPORT"))) {
                  return null;
               }
               return html;
            };

            var saveFile = function (content, filename, mime) {
               var blob = new Blob([content], { type: mime + ";charset=utf-8" });
               var url = URL.createObjectURL(blob);
               var link = document.createElement("a");
               link.href = url;
               link.download = filename;
               document.body.appendChild(link);
               link.click();
               $timeout(function () {
                  document.body.removeChild(link);
                  URL.revokeObjectURL(url);
               }, 2000);
            };

            /* One control for the four actions below. They wrapped the toolbar
             * onto a second row at 1500 px, and Arc clips a plugin page rather
             * than scrolling it (2.8), so a toolbar row is taken out of the tree.
             *
             * Dismissal has to be document level, because the panel overlays the
             * tree rather than sitting in the flow: a click anywhere else, or
             * Esc, closes it. mousedown rather than click, so the click that
             * dismisses still reaches whatever it was aimed at. Both listeners
             * come off again on $destroy -- this page is a tab Arc creates and
             * destroys, and a leaked handler would keep a dead scope alive. */
            $scope.toggleShare = function () {
               // One panel at a time: both are anchored to the toolbar's right
               // edge, so two open at once would sit on top of each other.
               $scope.state.filtersOpen = false;
               $scope.state.shareOpen = !$scope.state.shareOpen;
            };

            $scope.toggleFilters = function () {
               $scope.state.shareOpen = false;
               $scope.state.filtersOpen = !$scope.state.filtersOpen;
            };

            $scope.closeFilters = function () {
               $scope.state.filtersOpen = false;
            };

            /* What the badge on the Filters trigger says, and the whole reason
             * three controls may sit behind one: it counts filters that are
             * NARROWING the tree, not ones that differ from a default. In the
             * technical view all three start off -- setViewMode clears hideZero
             * and every trace clears treeCubeFilter -- so no badge means nothing
             * is being hidden, which is the fact a reader of the tree needs from
             * a closed panel. Called from an ng-if, so it stays side-effect
             * free: three comparisons per digest. */
            $scope.filterCount = function () {
               var count = 0;
               if ($scope.state.treeCubeFilter) { count++; }
               if ($scope.state.hideZero) { count++; }
               if ($scope.state.rulesOnly) { count++; }
               return count;
            };

            $scope.closeShare = function () {
               $scope.state.shareOpen = false;
            };

            // Trigger or panel: a mousedown in either must not close the menu
            // before the item's own ng-click has run.
            var insideMenu = function (node) {
               while (node && node.nodeType === 1) {
                  if ((" " + String(node.className || "") + " ").indexOf(" ce-menu ") > -1) { return true; }
                  node = node.parentNode;
               }
               return false;
            };

            /* Outside Angular, so the state change goes through $timeout: a bare
             * $scope.$apply throws if a digest happens to be running. */
            /* One dismisser per menu, built from one body: each closes only its
             * own flag, so a third menu is one more line and no edit to the
             * logic. Clicking one trigger while the other is open is handled by
             * the toggles, which clear each other. */
            var menuDismisser = function (flag) {
               return function (event) {
                  if (!$scope.state[flag]) { return; }
                  if (event.type === "keydown" && event.key !== "Escape" && event.key !== "Esc") { return; }
                  if (event.type === "mousedown" && insideMenu(event.target)) { return; }
                  $timeout(function () { $scope.state[flag] = false; });
               };
            };
            var dismissShare = menuDismisser("shareOpen");
            var dismissFilters = menuDismisser("filtersOpen");

            var shareDoc = angular.element(document);
            shareDoc.on("mousedown keydown", dismissShare);
            shareDoc.on("mousedown keydown", dismissFilters);
            $scope.$on("$destroy", function () {
               shareDoc.off("mousedown keydown", dismissShare);
               shareDoc.off("mousedown keydown", dismissFilters);
            });

            $scope.exportHtml = function () {
               if (!$scope.trace) { return; }
               var html = guardedReport();
               if (!html) { return; }
               saveFile(html, safeFileName(".html"), "text/html");
               Notification.success({
                  title: translated("CALCEXPLORER_EXPORT"),
                  message: translated("CALCEXPLORER_EXPORTDONE") +
                     " (" + describeSize(html.length) + ")"
               });
            };

            $scope.openHtml = function () {
               if (!$scope.trace) { return; }
               var html = guardedReport();
               if (!html) { return; }
               var blob = new Blob([html], { type: "text/html;charset=utf-8" });
               var url = URL.createObjectURL(blob);
               var opened = window.open(url, "_blank");
               if (!opened) {
                  // Blocked (or no external browser wired up) — fall back to a file.
                  saveFile(html, safeFileName(".html"), "text/html");
               }
               $timeout(function () { URL.revokeObjectURL(url); }, 30000);
            };

            /* execCommand rather than navigator.clipboard: Arc runs over http on
             * localhost for most people, where the async clipboard API is not
             * available. Returns whether it worked so callers can say so. */
            var copyToClipboard = function (text) {
               var area = document.createElement("textarea");
               area.value = text;
               area.setAttribute("readonly", "readonly");
               area.style.position = "absolute";
               area.style.left = "-9999px";
               document.body.appendChild(area);
               area.select();
               var copied = false;
               try { copied = document.execCommand("copy"); } catch (error) { copied = false; }
               document.body.removeChild(area);
               return copied;
            };

            $scope.copyText = function () {
               if (!$scope.trace) { return; }
               if (copyToClipboard(core.buildTextReport(buildPayload()))) {
                  Notification.success({
                     title: translated("CALCEXPLORER_COPY"),
                     message: translated("CALCEXPLORER_COPYDONE")
                  });
               } else {
                  reportError("CALCEXPLORER_COPY", "Clipboard copy was refused by the browser.");
               }
            };

            /* The traced cell, as text. One line is the whole coordinate, which
             * is what someone pastes into a mail, a ticket or another tool —
             * and the reason the header line has to be copyable at all. */
            $scope.coordinateText = function () {
               var cell = currentCell();
               if (!cell) { return ""; }
               return cell.cube + " :: " + cell.coordinateLabel;
            };

            /* Also offered as the table Arc's own Cell Reference dialog copies,
             * so a coordinate can travel back into this plugin (or anywhere
             * else that reads that shape) without being retyped. */
            $scope.copyCoordinates = function (asTable) {
               var cell = currentCell();
               if (!cell) { return; }
               var text;
               if (asTable) {
                  var lines = ["Dimension\tHierarchy\tElement"];
                  angular.forEach(cell.coordinates, function (coordinate) {
                     lines.push(coordinate.dimension + "\t" +
                        (coordinate.hierarchy || coordinate.dimension) + "\t" + coordinate.element);
                  });
                  text = lines.join("\n");
               } else {
                  text = $scope.coordinateText();
               }
               if (copyToClipboard(text)) {
                  Notification.success({
                     title: translated("CALCEXPLORER_COPYCELL"),
                     message: translated(asTable ? "CALCEXPLORER_COPYCELLTABLEDONE" : "CALCEXPLORER_COPYCELLDONE")
                  });
               } else {
                  reportError("CALCEXPLORER_COPYCELL", "Clipboard copy was refused by the browser.");
               }
            };

            $scope.exportText = function () {
               if (!$scope.trace) { return; }
               saveFile(core.buildTextReport(buildPayload()), safeFileName(".txt"), "text/plain");
            };

            // ---------------------------------------------------------------
            // Lifecycle
            // ---------------------------------------------------------------

            $scope.onInstanceChange = function () {
               $scope.state.cube = null;
               $scope.state.view = null;
               $scope.grid = null;
               $scope.trace = null;
               $scope.feeders = null;
               $scope.feederTarget = null;
               $scope.rows = [];
               dimensionCache = {};
               ruleCache = {};
               locationCache = {};
               $scope.loadCubes();
            };

            /* Arc's built-in Trace Calculation or Trace Feeders was redirected
             * here, so the cell is already known: decode it against the cube's
             * dimensions and go straight to what was asked for. Declining is
             * safe — the coordinates are left on the manual tab for the user to
             * complete — but it should not happen, since Arc built the parameter
             * from a real cell.
             *
             * A Trace Feeders handover runs only the feeder check: that is what
             * the user asked for, it needs nothing but the coordinate, and a
             * calculation trace of a big cell can take 20 s. The manual rows are
             * filled either way, so the other one is one click away on tab 1. */
            var applyHandedOverCell = function (request) {
               var wantFeeders = !!request.wantFeeders;
               $scope.state.mode = "manual";
               $scope.state.cube = request.cube;
               $scope.grid = null;
               $scope.state.error = null;
               /* **No tab flick, and nothing stale while it loads.** This used
                * to set activeTab = 0 here and let previewCoordinates move to
                * tab 1 when its request resolved, which measured as 2.2 s on a
                * tab the user had not asked for followed by the page moving
                * under them. The tab the answer arrives on is chosen up front
                * instead; tab 0 is still where a FAILED decode lands, which is
                * the only reason it was set here.
                *
                * The previous cell's trace is cleared, because tab 1 would
                * otherwise show another cell's tree under this cell's heading
                * for as long as the handover takes. */
               if (!wantFeeders) {
                  $scope.trace = null;
                  $scope.rows = [];
                  $scope.preview = null;
                  $scope.state.activeTab = 1;
               }

               return loadDimensions(request.cube).then(function (dimensions) {
                  var decoded = core.decodeElementList(request.elementsRaw, dimensions);
                  if (!decoded) {
                     // The one case tab 0 is right for: the coordinates could
                     // not be read, so they are left there to be completed.
                     $scope.state.activeTab = 0;
                     $scope.manual.reference = request.elementsRaw;
                     reportError(wantFeeders ? "CALCEXPLORER_FEEDERSFAILED" : "CALCEXPLORER_TRACEFAILED",
                        translated("CALCEXPLORER_HANDOVERFAILED") + " " + request.elementsRaw);
                     return;
                  }
                  // Already in cube dimension order, with the hierarchy Arc
                  // reported for each member where it gave one.
                  $scope.manual.rows = _.map(decoded.coordinates, function (coordinate) {
                     return {
                        dimension: coordinate.dimension,
                        hierarchy: coordinate.hierarchy,
                        element: coordinate.element
                     };
                  });
                  if (wantFeeders) {
                     // The trace on screen, if any, is of some other cell.
                     $scope.trace = null;
                     $scope.rows = [];
                     $scope.feeders = null;
                     $scope.feederTarget = {
                        instance: $scope.state.instance,
                        cube: request.cube,
                        coordinates: decoded.coordinates,
                        coordinateLabel: coordinateLabelOf(decoded.coordinates),
                        source: translated(request.source === "url"
                           ? "CALCEXPLORER_FROMLINK"
                           : "CALCEXPLORER_FROMFEEDERSMENU")
                     };
                     $scope.state.activeTab = 2;
                     return $scope.loadFeeders();
                  }
                  return previewCoordinates(request.cube, decoded.coordinates,
                     translated(request.source === "url"
                        ? "CALCEXPLORER_FROMLINK"
                        : "CALCEXPLORER_FROMCELLMENU"), true);
               });
            };

            /* A context-menu click asked for a cube (and maybe a view).
             * Resolved by name against the loaded view list, because the tree
             * branch does not reliably say whether a view is private. */
            var applyRequest = function (request) {
               if (!request || !request.cube) { return; }
               // A shared link can carry the depth its author traced at.
               if (request.depth > 0) { $scope.state.depth = request.depth; }
               if (request.elementsRaw) { return applyHandedOverCell(request); }
               $scope.state.mode = "view";
               $scope.state.activeTab = 0;
               $scope.state.cube = request.cube;
               $scope.state.view = null;
               $scope.state.rowOffset = 0;
               $scope.grid = null;
               $scope.state.error = null;

               loadDimensions(request.cube).then(function (dimensions) {
                  $scope.manual.rows = _.map(dimensions || [], function (dimension) {
                     return { dimension: dimension, hierarchy: dimension, element: "" };
                  });
               });

               $scope.loadViews().then(function () {
                  if (!request.view) { return; }
                  var match = _.find($scope.state.views, function (view) {
                     return view.name === request.view && !view.private;
                  }) || _.find($scope.state.views, function (view) {
                     return view.name === request.view;
                  });
                  if (match) {
                     $scope.selectView(match);
                  } else {
                     Notification.error({
                        title: translated("CALCEXPLORER_LOADVIEWSFAILED"),
                        message: request.view
                     });
                  }
               });
            };

            $scope.$on("calculation-explorer-request", function (event, request) {
               if (request && request.instance === $scope.state.instance) {
                  calcExplorerRequest.clear();
                  applyRequest(request);
               }
            });

            $scope.loadInstances();

            /* The isolate binding can also arrive after the first digest. As
             * soon as it does, adopt it — a <select> with no option to hold the
             * value makes ngOptions write undefined over the model, and every
             * request after that goes to /undefined/ and 404s. */
            var stopInstanceWatch = $scope.$watch("instance", function (name) {
               if (!name) { return; }
               stopInstanceWatch();
               if (!_.includes($scope.state.instances, name)) {
                  $scope.state.instances.unshift(name);
               }
               if (!$scope.state.instance) { $scope.state.instance = name; }
               if (!$scope.state.cubes.length && !$scope.state.loadingCubes) { $scope.loadCubes(); }
            });

            /* A cell can also arrive in the page's own URL -- see `path` and
             * `params` on the registration at the top of this file. Read **once**
             * at startup, and never written back, because Arc's tab layer
             * re-navigates every page-plugin state with `{instance}` alone a tick
             * later and the parameters are gone (§2.12, measured). That is enough
             * for a *link* to work, which is the point: the trace runs on open.
             * The address itself normalises to `/calculation-explorer/<instance>`,
             * so the link has to be copied from here rather than read off the
             * address bar -- which is what `copyLink()` is for. */
            var urlRequest = function () {
               var params = $state.params || {};
               if (!params.cube) { return null; }
               var depth = parseInt(params.depth, 10);
               if (depth > 0) { $scope.state.depth = depth; }
               return {
                  instance: params.instance || $scope.state.instance,
                  cube: params.cube,
                  view: params.view || null,
                  elementsRaw: params.elements ? String(params.elements) : null,
                  source: "url"
               };
            };

            /* The link is built by ui-router, not by hand: it encodes the cell
             * exactly as the state expects to read it back, including the second
             * layer over the `%20`s already inside the handover string. */
            $scope.copyLink = function () {
               var cell = currentCell();
               if (!cell) { return; }
               var href = $state.href("cubewiseCalculationExplorer", {
                  instance: cell.instance || $scope.state.instance,
                  cube: cell.cube,
                  elements: core.encodeElementList(cell.coordinates),
                  depth: $scope.state.depth || null
               }, { absolute: false });
               var link = location.origin + location.pathname + href;
               if (copyToClipboard(link)) {
                  Notification.success({
                     title: translated("CALCEXPLORER_COPYLINK"),
                     message: translated("CALCEXPLORER_COPYLINKDONE")
                  });
               } else {
                  reportError("CALCEXPLORER_COPYLINK", "Clipboard copy was refused by the browser.");
               }
            };

            // Opened by a context menu: the tab did not exist to hear the
            // broadcast, so the request is still waiting. A URL is the other way
            // in, and cannot collide with it -- a context-menu click never
            // carries parameters in the address.
            var openingRequest = calcExplorerRequest.take($scope.state.instance) || urlRequest();
            if (openingRequest) { applyRequest(openingRequest); }

            $scope.$on("login-reload", function (event, args) {
               if (args.instance == $scope.instance) { $scope.loadInstances(); }
            });

            $scope.$on("close-tab", function (event, args) {
               if (args.page == "cubewiseCalculationExplorer" && args.instance == $scope.instance && args.name == null) {
                  $rootScope.close(args.page, { instance: $scope.instance });
               }
            });

            $scope.$on("$destroy", function (event) {
               dimensionCache = {};
               ruleCache = {};
               locationCache = {};
               /* The fourth stop on the poll, and the one a closed tab needs:
                * a $timeout outliving its scope would keep reading /Threads
                * for a page nobody can see.
                *
                * BOTH calls, and the second one is not redundant -- it was
                * measured missing. Cancelling the timer does not stop a
                * readWalks() that is ALREADY OUT: when it resolves it tests
                * `state.walkNotice`, finds it still set on the dead scope, and
                * schedules a fresh $timeout. Measured against the running app
                * before this line existed: 8 further /Threads reads in the 14 s
                * after $destroy, ending only when the walk left /Threads or at
                * MAX_WALK_POLLS. With /Threads answering instantly -- so that
                * no read was ever in flight -- the same teardown leaked
                * nothing, which is what identified the in-flight read as the
                * carrier. Clearing the notice is what makes pollWalk's two
                * guards fire, so it is the stop that actually holds. */
               stopWalkPoll();
               clearWalkNotice();
               /* And the third stop, which is the one that holds against a
                * path this handler cannot see: setWalkNotice and
                * startWalkPoll refuse once this is set, so no async
                * continuation can put the indicator back or start a new poll
                * after the page is gone. See walkPageGone's own comment. */
               walkPageGone = true;
            });

         }]
   };
});

