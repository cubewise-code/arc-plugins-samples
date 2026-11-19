arc.run(["$rootScope", function ($rootScope) {

   $rootScope.plugin("workbookFlowDiagram", "Workbook Flow Diagram", "page", {
      menu: "tools",
      icon: "fa-sitemap",
      description: "Draws a flow diagram that starts from an Excel workbook tracked by Pulse: the cubes its worksheets use, then the processes, dimensions, cubes and other objects related to those cubes, as Pulse documents them",
      author: "Cubewise",
      url: "https://github.com/cubewise-code/arc-plugins-samples/tree/master/workbook-flow-diagram",
      version: "1.7.2"
   });

}]);

arc.directive("workbookFlowDiagram", function () {
   return {
      restrict: "EA",
      replace: true,
      scope: {
         instance: "=tm1Instance"
      },
      templateUrl: "__/plugins/workbook-flow-diagram/template.html",
      controller: ["$scope", "$rootScope", "$http", "$q", "$timeout", "$element", "$document", "$translate", "$tm1", "$pulse", "$tabs",
         function ($scope, $rootScope, $http, $q, $timeout, $element, $document, $translate, $tm1, $pulse, $tabs) {

            var _logger = log.getLogger("WorkbookFlowDiagram");

            // Layout sizes, in SVG units
            var NODE_W = 210, NODE_H = 36, COL_GAP = 130, ROW_GAP = 14, MARGIN = 30;
            var LABEL_MAX = 23;

            // Arc's own icon class for each object type, as in Arc's tree (`fa cubes`...). Font Awesome classes for the rest.
            var TYPE_ICON_CLASS = {
               workbook: "Excel",
               worksheet: "fa-table",
               cube: "cubes",
               process: "processes",
               dimension: "dimensions",
               chore: "chores",
               datasource: "fa-plug",
               file: "fa-file-text-o",
               odbc: "fa-database"
            };

            // Fill colour of each type when Arc's icon class gives none. Mid-tone colours with white text read on light and dark themes.
            var TYPE_COLORS = {
               workbook: "#0e6d36",
               worksheet: "#5a8f29",
               cube: "#e84a52",
               process: "#339933",
               dimension: "#0099cc",
               chore: "#ff6a00",
               datasource: "#5f6b76",
               file: "#5f6b76",
               odbc: "#5f6b76"
            };
            var TYPE_ORDER = ["workbook", "worksheet", "cube", "process", "datasource", "chore", "dimension", "file", "odbc"];
            var TYPE_LABELS = { datasource: "data source" };

            // A process's data source as TM1 gives it (DataSource.Type): its label and icon
            var DS_KINDS = {
               ASCII: { label: "File", cls: "fa-file-text-o" },
               ODBC: { label: "ODBC", cls: "fa-database" },
               TM1CubeView: { label: "Cube view", cls: "fa-table" },
               TM1DimensionSubset: { label: "Subset", cls: "fa-filter" }
            };

            // SVG cannot hold an <i> icon: read the glyph and colour an icon class draws, and draw the glyph as SVG text.
            // Read from Arc's stylesheet at start, so the diagram follows Arc's icons and colours.
            var readIcon = function (cls) {
               var probe = document.createElement("i");
               probe.className = "fa " + cls;
               probe.style.position = "absolute";
               probe.style.visibility = "hidden";
               document.body.appendChild(probe);
               var icon = null;
               try {
                  var before = window.getComputedStyle(probe, "::before");
                  var glyph = String(before.content || "").replace(/^["']|["']$/g, "");
                  if (glyph && glyph !== "none" && glyph !== "normal") {
                     // Arc's object classes carry their own colour; plain Font Awesome classes inherit the text colour
                     icon = { glyph: glyph, font: before.fontFamily || "FontAwesome", color: cls.indexOf("fa-") !== 0 ? before.color : null };
                  }
               } catch (e) {
                  _logger.warn("Icon not read", cls, e);
               }
               document.body.removeChild(probe);
               return icon;
            };

            var TYPE_ICONS = {};
            _.each(TYPE_ICON_CLASS, function (cls, type) {
               var icon = readIcon(cls);
               if (icon) {
                  TYPE_ICONS[type] = icon;
                  if (icon.color) { TYPE_COLORS[type] = icon.color; }
               }
            });
            _.each(DS_KINDS, function (kind) { kind.icon = readIcon(kind.cls); });

            $scope.page = {
               loading: false,
               error: null,
               serverName: null,
               serviceName: null,
               checked: 0,             // workbooks whose worksheets were read, while the list loads
               totalInPulse: 0,        // workbooks Pulse has for this Pulse environment, all instances
               search: "",
               mode: "all",            // "all": every workbook listed, "one": the workbook clicked
               depth: 1,
               showSheets: false,
               building: false,
               buildError: null,
               warnings: [],
               needsSignIn: false      // Pulse answered 401: the Pulse session is missing or expired
            };

            // Rejection reason of a call Pulse refused for lack of a session; shown as the sign-in warning, not as an error
            var SIGN_IN_NEEDED = "pulse-sign-in-needed";
            // Pulse lists only workbooks opened between two dates: "All time" asks from this date
            var ALL_FROM = "2000-01-01";

            // --- Period: which workbooks to list, by when they were opened ----------------
            // Relative periods end today; "Specific dates" takes a from and a to day (both included).
            $scope.periodOptions = [
               { id: "7d", months: 0, days: 7, label: "WBFLOWP7D" },
               { id: "1m", months: 1, label: "WBFLOWP1M" },
               { id: "3m", months: 3, label: "WBFLOWP3M" },
               { id: "12m", months: 12, label: "WBFLOWP12M" },
               { id: "all", label: "WBFLOWPALL" },
               { id: "custom", label: "WBFLOWPCUSTOM" }
            ];
            // Translate the labels once: a `translate` filter inside ng-options makes Angular see the options
            // as changed on every digest ("10 $digest() iterations reached")
            _.each($scope.periodOptions, function (o) { o.text = String($translate.instant(o.label)); });
            // Arc's $translate.instant can return a trusted-value object: make it a plain string
            var text = function (key) { return String($translate.instant(key)); };
            var PERIOD_KEY = "workbookFlowDiagram.period";
            var monthAgo = new Date();
            monthAgo.setMonth(monthAgo.getMonth() - 1);
            // Date objects, as <input type="date"> needs
            $scope.period = { preset: "1m", from: monthAgo, to: new Date(), error: null };
            // The period chosen last time, for this browser (a convenience: the page works without it)
            try {
               var saved = JSON.parse(window.localStorage.getItem(PERIOD_KEY) || "null");
               if (saved && _.find($scope.periodOptions, { id: saved.preset })) {
                  $scope.period.preset = saved.preset;
                  if (saved.from) { $scope.period.from = new Date(saved.from + "T00:00:00"); }
                  if (saved.to) { $scope.period.to = new Date(saved.to + "T00:00:00"); }
               }
            } catch (e) { /* no storage: keep the default period */ }
            // Workbook details read at the same time while the list is checked
            var PARALLEL = 6;
            $scope.workbooks = [];
            $scope.selected = null;         // the workbook drawn in "one" mode
            $scope.lastOne = null;          // the workbook last drawn on its own, to go back to from "all"
            $scope.graph = null;            // { nodes, edges, width, height }
            $scope.hiddenTypes = {};
            $scope.typesPresent = [];
            $scope.focus = null;            // the node clicked
            $scope.view = { x: 0, y: 0, k: 1 };

            var model = null;               // every node and edge found, before type filters
            var stopped = false;
            var details = {};               // workbook path -> Pulse's workbook detail (its worksheets)
            var listRun = 0;                // a newer list load makes an older one stop

            // --- Helpers -----------------------------------------------------------

            var pad = function (n) { return (n < 10 ? "0" : "") + n; };
            var isoDate = function (d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); };

            // Pulse field names vary in case between versions: read the first one present
            var pick = function (obj, names) {
               if (!obj) { return undefined; }
               for (var i = 0; i < names.length; i++) {
                  if (obj[names[i]] !== undefined && obj[names[i]] !== null) { return obj[names[i]]; }
               }
               var lower = {};
               _.each(obj, function (v, k) { lower[k.toLowerCase()] = v; });
               for (var j = 0; j < names.length; j++) {
                  var v = lower[names[j].toLowerCase()];
                  if (v !== undefined && v !== null) { return v; }
               }
               return undefined;
            };

            var sameName = function (a, b) {
               return String(a || "").toLowerCase() === String(b || "").toLowerCase();
            };

            var fileName = function (path) {
               var parts = String(path || "").split(/[\\\/]/);
               return parts[parts.length - 1] || path;
            };

            var normType = function (type) {
               var t = String(type || "").toLowerCase();
               if (t === "rule") { return "cube"; }
               return t || "other";
            };

            var keyOf = function (type, name) { return normType(type) + "|" + String(name).toLowerCase(); };

            // GET through Arc's Pulse proxy, without letting a 401 open Arc's sign-in dialog
            var pulseGet = function (url) {
               var done = function (r) { return r || {}; };
               return $http({
                  method: "GET",
                  url: url,
                  headers: { "x-login-no-prompt": true, "x-non-interactive": true },
                  transformResponse: function (text) {
                     if (!_.isString(text) || !/^\s*[\[{]/.test(text)) { return text; }
                     try { return JSON.parse(text); } catch (e) { return text; }
                  }
               }).then(done, done).then(function (r) {
                  if (r.status === 401) {
                     $scope.page.needsSignIn = true;
                     return $q.reject(SIGN_IN_NEEDED);
                  }
                  if (r.status !== 200) { return $q.reject("Pulse answered " + r.status + " to " + url.split("?")[0]); }
                  if (r.data && r.data.Failed === true) { return $q.reject(r.data.Message || "Pulse reported a failure"); }
                  return r.data;
               });
            };

            var tomorrow = function () { return isoDate(new Date(Date.now() + 24 * 3600 * 1000)); };

            // The chosen period as Pulse's start and end. Pulse compares the opening time with the end day
            // at midnight, so the end sent is the day after the last day wanted.
            var periodRange = function () {
               var p = $scope.period;
               var option = _.find($scope.periodOptions, { id: p.preset }) || $scope.periodOptions[1];
               if (option.id === "all") { return { start: ALL_FROM, end: tomorrow(), last: isoDate(new Date()) }; }
               if (option.id === "custom") {
                  if (!(p.from instanceof Date) || isNaN(p.from) || !(p.to instanceof Date) || isNaN(p.to)) {
                     return { error: text("WBFLOWPNEEDDATES") };
                  }
                  if (p.from > p.to) { return { error: text("WBFLOWPORDER") }; }
                  return { start: isoDate(p.from), end: nextDay(isoDate(p.to)), last: isoDate(p.to) };
               }
               var start = new Date();
               if (option.months) { start.setMonth(start.getMonth() - option.months); }
               if (option.days) { start.setDate(start.getDate() - option.days); }
               return { start: isoDate(start), end: tomorrow(), last: isoDate(new Date()) };
            };

            // Shown under the selector: the days the list covers
            $scope.periodText = function () {
               var r = periodRange();
               if (r.error) { return ""; }
               return $scope.period.preset === "all" ? text("WBFLOWPALLTEXT") : r.start + " → " + r.last;
            };

            // A new period from the selector or the date fields: remember it, and list again
            $scope.applyPeriod = function () {
               var r = periodRange();
               $scope.period.error = r.error || null;
               if (r.error) { return; }
               try {
                  window.localStorage.setItem(PERIOD_KEY, JSON.stringify({
                     preset: $scope.period.preset,
                     from: isoDate($scope.period.from),
                     to: isoDate($scope.period.to)
                  }));
               } catch (e) { /* no storage: the period is kept for this page only */ }
               $scope.loadWorkbooks();
            };

            $scope.onPresetChange = function () {
               // Specific dates: wait for Apply, so the list is not loaded at every key press in the date fields
               if ($scope.period.preset !== "custom") { $scope.applyPeriod(); }
            };

            // Does this worksheet read this instance? A worksheet with no TM1 server recorded counts as this instance.
            // Pulse records "Unknown" for a worksheet it could not tie to a TM1 server (seen on Pulse 8.0.1 for a sheet with no cube).
            var isThisInstance = function (tm1Server) {
               return !tm1Server || sameName(tm1Server, "Unknown") ||
                  sameName(tm1Server, $scope.page.serviceName) || sameName(tm1Server, $scope.instance);
            };

            // The day after a yyyy-MM-dd day, as yyyy-MM-dd
            var nextDay = function (day) {
               var d = new Date(day + "T12:00:00");
               d.setDate(d.getDate() + 1);
               return isoDate(d);
            };

            // Pulse's detail of one workbook. Its worksheets do not depend on dates, but Pulse 8.0.1 answers
            // "Unable to get excel workbook" when the period holds no opening of the workbook. So ask for the
            // day it was last opened (from the list) and the day after: one opening, and a small usage part.
            var detailRange = function (workbook) {
               var day = String(workbook.lastOpened || "").substring(0, 10);
               if (/^\d{4}-\d{2}-\d{2}$/.test(day)) { return { start: day, end: nextDay(day) }; }
               return { start: ALL_FROM, end: tomorrow() };
            };

            var loadDetail = function (workbook) {
               if (details[workbook.path]) { return $q.when(details[workbook.path]); }
               var range = detailRange(workbook);
               var url = "_pulse/api/workbook?servername=" + encodeURIComponent($scope.page.serverName) +
                  "&path=" + encodeURIComponent(workbook.path) +
                  "&logVersion=" + encodeURIComponent(workbook.logVersion) +
                  "&start=" + range.start + "&end=" + range.end;
               return pulseGet(url).then(function (detail) {
                  details[workbook.path] = detail;
                  return detail;
               });
            };

            var worksheetsOf = function (detail) { return pick(detail, ["worksheets", "Worksheets"]) || []; };

            // The cubes of this instance a workbook's worksheets read
            var instanceCubes = function (detail) {
               return _.uniq(_.flatten(_.map(worksheetsOf(detail), function (sheet) {
                  return isThisInstance(pick(sheet, ["TM1ServerName", "tm1ServerName"])) ? sheetCubes(sheet) : [];
               })));
            };

            // --- Workbook list -----------------------------------------------------

            // The workbooks Pulse saw opened in the chosen period, then only those whose worksheets read this instance.
            // `fresh` (the reload button, a new sign-in) also forgets the worksheets and data sources already read;
            // a new period keeps them, since a workbook's worksheets do not depend on the period.
            $scope.loadWorkbooks = function (fresh) {
               var run = ++listRun;
               $scope.page.error = null;
               $scope.workbooks = [];
               $scope.page.checked = 0;
               $scope.page.totalInPulse = 0;
               if (fresh) {
                  details = {};
                  dataSources = null;
               }
               var range = periodRange();
               $scope.period.error = range.error || null;
               if (range.error) {
                  $scope.page.loading = false;
                  return $q.when();
               }
               // Not signed in to Pulse in Arc: show the sign-in warning instead of calling Pulse
               if (!$pulse.isLoggedIn()) {
                  $scope.page.loading = false;
                  return $q.when();
               }
               $scope.page.needsSignIn = false;
               $scope.page.loading = true;

               return $pulse.serviceFromInstance($scope.instance).then(function (service) {
                  $scope.page.serverName = service.serverName;
                  $scope.page.serviceName = service.serviceName;
                  return pulseGet("_pulse/api/workbooks?start=" + range.start + "&end=" + range.end);
               }, function (error) {
                  return $q.reject((error && error.message) || String(error));
               }).then(function (data) {
                  if (!_.isArray(data)) { return $q.reject($translate.instant("WBFLOWBADANSWER")); }
                  // The list covers every Pulse environment: keep this instance's one when Pulse says which
                  var all = _.chain(data)
                     .filter(function (w) {
                        var server = pick(w, ["serverName", "ServerName"]);
                        return !server || sameName(server, $scope.page.serverName);
                     })
                     .map(function (w) {
                        var path = pick(w, ["path", "Path"]);
                        return {
                           path: path,
                           name: pick(w, ["name", "Name"]) || fileName(path),
                           openCount: pick(w, ["openCount", "OpenCount"]),
                           lastOpened: pick(w, ["lastOpened", "LastOpened"]),
                           lastOpenedBy: pick(w, ["lastOpenedBy", "LastOpenedBy"]),
                           sheets: pick(w, ["sheets", "Sheets"]),
                           tm1Sheets: pick(w, ["tm1Sheets", "TM1Sheets"]),
                           logVersion: pick(w, ["logVersion", "LogVersion"]) || 1
                        };
                     })
                     .filter("path")
                     .uniqBy("path")
                     .sortBy(function (w) { return String(w.name).toLowerCase(); })
                     .value();
                  $scope.page.totalInPulse = all.length;

                  // Pulse's list does not say which TM1 instance a workbook reads: its worksheets do.
                  // Read them a few at a time and show each workbook of this instance as soon as it is known.
                  var queue = all.slice();
                  var failed = [];
                  var worker = function () {
                     if (run !== listRun || stopped || !queue.length) { return $q.when(); }
                     var workbook = queue.shift();
                     return loadDetail(workbook).then(function (detail) {
                        if (run !== listRun) { return; }
                        var cubes = instanceCubes(detail);
                        if (cubes.length) {
                           workbook.cubes = cubes;
                           $scope.workbooks = _.sortBy($scope.workbooks.concat([workbook]), function (w) { return String(w.name).toLowerCase(); });
                        }
                     }, function (reason) {
                        if (reason === SIGN_IN_NEEDED) { queue.length = 0; return $q.reject(reason); }
                        failed.push(workbook.name);
                        _logger.warn("Workbook detail failed", workbook.path, reason);
                     })["finally"](function () {
                        $scope.page.checked++;
                     }).then(worker);
                  };
                  return $q.all(_.times(Math.min(PARALLEL, all.length), worker)).then(function () {
                     if (failed.length && run === listRun) {
                        $scope.page.error = $translate.instant("WBFLOWDETAILFAILED") + " " + failed.join(", ");
                     }
                     _logger.info("Workbooks of this instance", $scope.workbooks.length, "of", all.length);
                  });
               })["catch"](function (reason) {
                  if (reason === SIGN_IN_NEEDED) { return; }
                  $scope.page.error = String(reason);
                  _logger.error("Workbook list failed", reason);
               })["finally"](function () {
                  if (run !== listRun) { return; }
                  $scope.page.loading = false;
                  afterListLoad();
               });
            };

            // When Pulse last recorded the workbook's sheets: the add-in records them when the workbook is
            // opened, so a sheet added or renamed since then is missing until the next opening (seen on Pulse 8.0.1).
            // Pulse's "2026-11-09T16:45:01.000+0100" shown as "2026-11-09 16:45".
            $scope.recordedAt = function (workbook) {
               var m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(String((workbook && workbook.lastOpened) || ""));
               return m ? m[1] + " " + m[2] : null;
            };

            $scope.visibleWorkbook = function (w) {
               var words = _.compact(String($scope.page.search || "").toLowerCase().split(/\s+/));
               if (!words.length) { return true; }
               var text = (w.name + " " + w.path + " " + (w.lastOpenedBy || "") + " " + (w.cubes || []).join(" ")).toLowerCase();
               return _.every(words, function (word) { return text.indexOf(word) >= 0; });
            };

            // --- Diagram data ------------------------------------------------------

            var addNode = function (type, name, extra) {
               var key = keyOf(type, name);
               if (!model.nodes[key]) {
                  model.nodes[key] = _.assign({ key: key, type: normType(type), name: String(name) }, extra || {});
               }
               return model.nodes[key];
            };

            var addEdge = function (from, to, kind) {
               if (from.key === to.key) { return; }
               var key = from.key + ">" + to.key;
               if (!model.edges[key]) {
                  model.edges[key] = { key: key, from: from.key, to: to.key, kind: kind || "relation" };
               }
            };

            // Relationships Pulse documented for one cube: [{id, name, type, edges: [{id, name, type}]}]
            var loadCubeRelations = function (cubeName) {
               var url = "_pulse/relationship/" + encodeURIComponent($scope.page.serverName) + "/" +
                  encodeURIComponent($scope.page.serviceName) + "/" + encodeURIComponent(cubeName);
               return pulseGet(url).then(function (nodes) {
                  if (!_.isArray(nodes)) { return $q.reject($translate.instant("WBFLOWBADRELATION") + " " + cubeName); }
                  var found = [];
                  _.each(nodes, function (n) {
                     if (!n || !n.name) { return; }
                     var source = addNode(n.type, n.name);
                     found.push(source);
                     _.each(n.edges || [], function (e) {
                        if (!e || !e.name) { return; }
                        var target = addNode(e.type, e.name);
                        found.push(target);
                        addEdge(source, target, "relation");
                     });
                  });
                  return found;
               });
            };

            // Cube names a worksheet uses. Pulse keeps one name per worksheet; split in case a list comes back.
            var sheetCubes = function (sheet) {
               var value = pick(sheet, ["cubeName", "CubeName"]);
               if (_.isArray(value)) { return _.compact(value); }
               return _.compact(_.map(String(value || "").split(/\s*[;\n]\s*/), _.trim));
            };

            // One workbook: draw it from the workbook. Clicking a workbook in the list always shows that one.
            $scope.draw = function (workbook) {
               if ($scope.page.building || !workbook) { return; }
               $scope.page.mode = "one";
               $scope.selected = workbook;
               buildDiagram([workbook]);
            };

            // All workbooks: every workbook in the list (as filtered by the search), side by side, at Levels 1 by default
            $scope.drawAll = function (keepLevels) {
               if ($scope.page.building) { return; }
               var shown = _.filter($scope.workbooks, $scope.visibleWorkbook);
               if (!keepLevels) { $scope.page.depth = 1; }
               $scope.page.mode = "all";
               $scope.selected = null;
               if (!shown.length) {
                  $scope.graph = null;
                  model = null;
                  return;
               }
               buildDiagram(shown);
            };

            $scope.setMode = function (mode) {
               if ($scope.page.building || mode === $scope.page.mode) { return; }
               if (mode === "all") { $scope.drawAll(); return; }
               // One workbook: the one last drawn on its own, else the first in the list
               var one = ($scope.lastOne && _.find($scope.workbooks, { path: $scope.lastOne.path })) ||
                  _.find($scope.workbooks, $scope.visibleWorkbook);
               if (one) { $scope.draw(one); } else { $scope.page.mode = "one"; $scope.graph = null; }
            };

            // Draw one or more workbooks: each workbook -> its worksheets' cubes -> related objects -> data sources
            var buildDiagram = function (workbooks) {
               stopped = false;
               if ($scope.page.mode === "one") { $scope.lastOne = workbooks[0]; }
               $scope.focus = null;
               $scope.graph = null;
               $scope.page.building = true;
               $scope.page.buildError = null;
               $scope.page.warnings = [];
               $scope.page.allLevels = false;
               model = { nodes: {}, edges: {}, roots: [] };
               var otherServers = {};
               var cubes = {};

               // Usually read already while the list loaded
               $q.all(_.map(workbooks, function (workbook) {
                  return loadDetail(workbook).then(function (detail) { return { workbook: workbook, detail: detail }; });
               })).then(function (loaded) {
                  _.each(loaded, function (item) {
                     var workbook = item.workbook;
                     // Keyed by path: two workbooks can have the same file name in different folders
                     var root = addNode("workbook", workbook.path, {
                        label: workbook.name,
                        path: workbook.path,
                        recordedAt: $scope.recordedAt(workbook)
                     });
                     model.roots.push(root.key);

                     _.each(worksheetsOf(item.detail), function (sheet) {
                        var names = sheetCubes(sheet);
                        if (!names.length) { return; }
                        var tm1Server = pick(sheet, ["TM1ServerName", "tm1ServerName"]);
                        // A worksheet can read cubes on another TM1 instance: Pulse relationships are per instance
                        if (!isThisInstance(tm1Server)) {
                           otherServers[tm1Server] = true;
                           return;
                        }
                        var sheetName = pick(sheet, ["name", "Name"]) || "?";
                        var sheetNode = null;
                        if ($scope.page.showSheets) {
                           sheetNode = addNode("worksheet", workbook.path + " / " + sheetName, { label: sheetName });
                           addEdge(root, sheetNode, "workbook");
                        }
                        _.each(names, function (cube) {
                           var cubeNode = addNode("cube", cube);
                           var sheetLabel = workbooks.length > 1 ? workbook.name + " / " + sheetName : sheetName;
                           cubeNode.sheets = _.union(cubeNode.sheets || [], [sheetLabel]);
                           addEdge(sheetNode || root, cubeNode, "workbook");
                           cubes[cubeNode.key] = cube;
                        });
                     });
                  });

                  if (_.size(otherServers)) {
                     $scope.page.warnings.push($translate.instant("WBFLOWOTHERSERVERS") + " " + _.keys(otherServers).join(", "));
                  }
                  if (!_.size(cubes)) {
                     $scope.page.warnings.push($translate.instant("WBFLOWNOCUBES"));
                     return;
                  }
                  return expand(_.values(cubes), $scope.page.depth).then(addDataSources);
               }).then(function () {
                  if (stopped) { return; }
                  collectTypes();
                  layout();
                  autoFit = true;
               })["catch"](function (reason) {
                  if (reason === SIGN_IN_NEEDED) { return; }
                  $scope.page.buildError = String(reason);
                  _logger.error("Diagram failed", reason);
               })["finally"](function () {
                  $scope.page.building = false;
                  // Fit once the diagram is on screen, with the canvas at its real size
                  $timeout(function () { if (autoFit) { $scope.fit(); } });
               });
            };

            // --- Process data sources (from TM1: Pulse's relationships stop at the process) ---------

            // Every process's data source on this instance, read once per page: process name (lower case) -> DataSource
            var dataSources = null;

            var loadDataSources = function () {
               if (dataSources) { return $q.when(dataSources); }
               return $tm1.async($scope.instance, "GET", "/Processes?$select=Name,DataSource", null).then(function (r) {
                  if (!r || r.status !== 200 || !r.data || !_.isArray(r.data.value)) {
                     return $q.reject($translate.instant("WBFLOWDSFAILED") + " (HTTP " + (r && r.status) + ")");
                  }
                  dataSources = {};
                  _.each(r.data.value, function (p) {
                     // Keep what the diagram shows; never the ODBC password
                     var ds = p.DataSource || {};
                     dataSources[String(p.Name).toLowerCase()] = {
                        type: ds.Type,
                        name: ds.dataSourceNameForServer || ds.dataSourceNameForClient || "",
                        view: ds.view || null,
                        subset: ds.subset || null,
                        query: ds.query || null,
                        userName: ds.userName || null
                     };
                  });
                  return dataSources;
               }, function (e) {
                  return $q.reject($translate.instant("WBFLOWDSFAILED") + " (" + ((e && e.status) || "no answer") + ")");
               });
            };

            // A node for each process's data source, linked data source -> process (the data flows into the process)
            var addDataSources = function () {
               var processes = _.filter(_.values(model.nodes), { type: "process" });
               if (!processes.length || stopped) { return $q.when(); }
               return loadDataSources().then(function (all) {
                  _.each(processes, function (proc) {
                     var ds = all[proc.name.toLowerCase()];
                     if (!ds || !ds.type || ds.type === "None") { return; }
                     proc.dataSource = ds;
                     var kind = DS_KINDS[ds.type] || { label: ds.type, icon: TYPE_ICONS.datasource };
                     var name = ds.name + (ds.view ? " » " + ds.view : "") + (ds.subset ? " » " + ds.subset : "");
                     // ODBC: one node per DSN and query, so two processes reading the same query share it
                     var key = ds.type + ":" + name + (ds.query ? ":" + ds.query : "");
                     var node = addNode("datasource", key, {
                        // A file shows its name on the node; the full path is in the details
                        label: (ds.type === "ASCII" ? fileName(name) : name) || kind.label,
                        typeLabel: "data source · " + kind.label,
                        dsKind: kind.label,
                        dsIcon: kind.icon || TYPE_ICONS.datasource,
                        dataSource: ds
                     });
                     addEdge(node, proc, "datasource");
                  });
               }, function (reason) {
                  // No rights to read processes, for example: draw the rest and say why the sources are missing
                  $scope.page.warnings.push(String(reason));
               });
            };

            // Load the relationships of these cubes, then of the cubes they lead to, `depth` levels deep
            var expand = function (cubeNames, depth) {
               var done = {};
               $scope.page.allLevels = false;
               var level = function (names, remaining) {
                  names = _.filter(_.uniq(names), function (n) { return !done[n.toLowerCase()]; });
                  // No new cube to follow: one more level would draw nothing more
                  if (!names.length) { $scope.page.allLevels = true; }
                  if (!names.length || remaining <= 0 || stopped) { return $q.when(); }
                  _.each(names, function (n) { done[n.toLowerCase()] = true; });
                  return $q.all(_.map(names, function (name) {
                     return loadCubeRelations(name).then(function (found) { return found; }, function (reason) {
                        if (reason === SIGN_IN_NEEDED) { return $q.reject(reason); }
                        $scope.page.warnings.push(String(reason));
                        return [];
                     });
                  })).then(function (lists) {
                     var next = _.chain(lists).flatten().filter({ type: "cube" }).map("name").value();
                     return level(next, remaining - 1);
                  });
               };
               return level(cubeNames, depth);
            };

            var collectTypes = function () {
               var types = _.uniq(_.map(_.values(model.nodes), "type"));
               $scope.typesPresent = _.sortBy(_.filter(types, function (t) { return t !== "workbook"; }), function (t) {
                  var i = TYPE_ORDER.indexOf(t);
                  return (i < 0 ? 99 : i) + t;
               });
            };

            // --- Layout --------------------------------------------------------------

            var shorten = function (text) {
               text = String(text);
               return text.length > LABEL_MAX ? text.substring(0, LABEL_MAX - 1) + "…" : text;
            };

            // Columns by distance from the workbook (edges followed both ways), rows sorted by type then name
            var layout = function () {
               if (!model || !model.roots || !model.roots.length) { $scope.graph = null; return; }
               var shown = _.filter(_.values(model.nodes), function (n) {
                  return n.type === "workbook" || n.type === "cube" || !$scope.hiddenTypes[n.type];
               });
               var shownKeys = _.keyBy(shown, "key");
               var edges = _.filter(_.values(model.edges), function (e) { return shownKeys[e.from] && shownKeys[e.to]; });

               var neighbours = {};
               _.each(edges, function (e) {
                  (neighbours[e.from] = neighbours[e.from] || []).push(e.to);
                  (neighbours[e.to] = neighbours[e.to] || []).push(e.from);
               });
               var level = {};
               // Every workbook drawn starts in the first column
               _.each(model.roots, function (r) { level[r] = 0; });
               var queue = model.roots.slice();
               while (queue.length) {
                  var k = queue.shift();
                  _.each(neighbours[k] || [], function (n) {
                     if (level[n] === undefined) { level[n] = level[k] + 1; queue.push(n); }
                  });
               }
               // Objects only linked through a hidden type have no path back: leave them out
               shown = _.filter(shown, function (n) { return level[n.key] !== undefined; });
               shownKeys = _.keyBy(shown, "key");
               edges = _.filter(edges, function (e) { return shownKeys[e.from] && shownKeys[e.to]; });

               var columns = _.groupBy(shown, function (n) { return level[n.key]; });
               var colCount = _.size(columns);
               var tallest = _.max(_.map(columns, "length")) || 1;
               var fullHeight = tallest * (NODE_H + ROW_GAP) - ROW_GAP;

               var nodes = [];
               _.each(columns, function (list, col) {
                  list = _.sortBy(list, function (n) {
                     var i = TYPE_ORDER.indexOf(n.type);
                     return pad(i < 0 ? 99 : i) + String(n.name).toLowerCase();
                  });
                  var colHeight = list.length * (NODE_H + ROW_GAP) - ROW_GAP;
                  var top = MARGIN + (fullHeight - colHeight) / 2;
                  _.each(list, function (n, row) {
                     nodes.push(_.assign(n, {
                        col: Number(col),
                        x: MARGIN + Number(col) * (NODE_W + COL_GAP),
                        y: top + row * (NODE_H + ROW_GAP),
                        color: TYPE_COLORS[n.type] || "#6c757d",
                        icon: n.dsIcon || TYPE_ICONS[n.type] || null,
                        typeText: n.typeLabel || TYPE_LABELS[n.type] || n.type,
                        text: shorten(n.label || n.name)
                     }));
                  });
               });

               var byKey = _.keyBy(nodes, "key");
               var lines = _.map(edges, function (e) {
                  var a = byKey[e.from], b = byKey[e.to];
                  var ay = a.y + NODE_H / 2, by = b.y + NODE_H / 2, d;
                  if (b.col > a.col) {
                     var x1 = a.x + NODE_W, x2 = b.x - 4, mx = (x1 + x2) / 2;
                     d = "M" + x1 + "," + ay + " C" + mx + "," + ay + " " + mx + "," + by + " " + x2 + "," + by;
                  } else if (b.col < a.col) {
                     var x3 = a.x, x4 = b.x + NODE_W + 4, mx2 = (x3 + x4) / 2;
                     d = "M" + x3 + "," + ay + " C" + mx2 + "," + ay + " " + mx2 + "," + by + " " + x4 + "," + by;
                  } else {
                     // Same column: loop out to the right
                     var x5 = a.x + NODE_W, bulge = x5 + 50 + Math.min(Math.abs(by - ay) / 4, 60);
                     d = "M" + x5 + "," + ay + " C" + bulge + "," + ay + " " + bulge + "," + by + " " + (x5 + 4) + "," + by;
                  }
                  return { key: e.key, from: e.from, to: e.to, kind: e.kind, d: d };
               });

               $scope.graph = {
                  nodes: nodes,
                  edges: lines,
                  width: MARGIN * 2 + colCount * NODE_W + (colCount - 1) * COL_GAP + 60,
                  height: MARGIN * 2 + fullHeight,
                  hiddenCount: _.size(model.nodes) - nodes.length
               };
               if ($scope.focus && !byKey[$scope.focus.key]) { $scope.focus = null; }
            };

            $scope.toggleType = function (type) {
               // Cubes are always shown: they hold the diagram together
               if (type === "cube") { return; }
               $scope.hiddenTypes[type] = !$scope.hiddenTypes[type];
               layout();
            };
            $scope.typeColor = function (type) { return TYPE_COLORS[type] || "#6c757d"; };
            // Class of the <i> icon for a type in the legend and the details panel
            $scope.typeIconClass = function (type) { return TYPE_ICON_CLASS[type] ? "fa fa-fw " + TYPE_ICON_CLASS[type] : null; };
            // Icon class of one object: a data source shows the icon of its kind (file, ODBC, view, subset)
            $scope.nodeIconClass = function (node) {
               if (node && node.dataSource && node.type === "datasource") {
                  var kind = DS_KINDS[node.dataSource.type];
                  return "fa fa-fw " + (kind ? kind.cls : TYPE_ICON_CLASS.datasource);
               }
               return (node && $scope.typeIconClass(node.type)) || "fa fa-fw fa-circle";
            };
            $scope.typeLabel = function (type) { return TYPE_LABELS[type] || type; };
            $scope.typeCount = function (type) { return model ? _.filter(_.values(model.nodes), { type: type }).length : 0; };

            // --- Focus: click a node to highlight what it is linked to ----------------

            $scope.select = function (node, $event) {
               if ($event) { $event.stopPropagation(); }
               if (moved) { return; }
               $scope.focus = ($scope.focus && $scope.focus.key === node.key) ? null : node;
               if ($scope.focus) {
                  var byKey = _.keyBy($scope.graph.nodes, "key");
                  $scope.focus.incoming = _.map(_.filter($scope.graph.edges, { to: node.key }), function (e) { return byKey[e.from]; });
                  $scope.focus.outgoing = _.map(_.filter($scope.graph.edges, { from: node.key }), function (e) { return byKey[e.to]; });
               }
            };

            $scope.clearFocus = function () { if (!moved) { $scope.focus = null; } };
            $scope.closeFocus = function () { $scope.focus = null; };

            $scope.isLinked = function (node) {
               var f = $scope.focus;
               if (!f) { return true; }
               if (f.key === node.key) { return true; }
               return _.some(f.incoming, { key: node.key }) || _.some(f.outgoing, { key: node.key });
            };

            $scope.isEdgeLinked = function (edge) {
               return !$scope.focus || edge.from === $scope.focus.key || edge.to === $scope.focus.key;
            };

            // Double-click opens the object in Arc
            var OPENABLE = { cube: true, process: true, dimension: true, chore: true };
            $scope.canOpen = function (node) { return node && OPENABLE[node.type]; };
            $scope.openObject = function (node, $event) {
               if ($event) { $event.stopPropagation(); }
               if (!$scope.canOpen(node)) { return; }
               var params = { instance: $scope.instance, name: node.name };
               if (node.type === "dimension") { params.hierarchy = node.name; }
               $tabs.open(node.type, params);
            };

            // --- Pan and zoom ----------------------------------------------------------

            var svgBox = function () { return $element[0].querySelector(".wbflow-canvas"); };

            $scope.transform = function () {
               return "translate(" + $scope.view.x + "," + $scope.view.y + ") scale(" + $scope.view.k + ")";
            };

            // While true, the diagram is fitted again whenever the canvas changes size (window, Arc panels, tab shown again).
            // Zooming or dragging turns it off; Fit and drawing a workbook turn it back on.
            var autoFit = true;

            $scope.fit = function () {
               autoFit = true;
               var box = svgBox();
               if (!box || !$scope.graph) { return; }
               var w = box.clientWidth, h = box.clientHeight;
               // Hidden tab or not laid out yet: the resize watcher fits it once the canvas has a size
               if (w < 50 || h < 50) { return; }
               var k = Math.min(w / $scope.graph.width, h / $scope.graph.height, 1.5);
               k = Math.max(k, 0.1);
               $scope.view.k = k;
               $scope.view.x = (w - $scope.graph.width * k) / 2;
               $scope.view.y = Math.max((h - $scope.graph.height * k) / 2, 0);
            };

            $scope.zoom = function (factor, cx, cy) {
               autoFit = false;
               var box = svgBox();
               if (cx === undefined && box) { cx = box.clientWidth / 2; cy = box.clientHeight / 2; }
               var k = Math.min(Math.max($scope.view.k * factor, 0.1), 4);
               var ratio = k / $scope.view.k;
               $scope.view.x = cx - (cx - $scope.view.x) * ratio;
               $scope.view.y = cy - (cy - $scope.view.y) * ratio;
               $scope.view.k = k;
            };

            var dragging = null, moved = false;

            var onWheel = function (event) {
               if (!$scope.graph) { return; }
               event.preventDefault();
               var rect = svgBox().getBoundingClientRect();
               var factor = event.deltaY < 0 ? 1.15 : 1 / 1.15;
               $scope.$apply(function () { $scope.zoom(factor, event.clientX - rect.left, event.clientY - rect.top); });
            };

            var onDown = function (event) {
               if (event.button !== 0) { return; }
               dragging = { x: event.clientX, y: event.clientY, vx: $scope.view.x, vy: $scope.view.y };
               moved = false;
            };

            var onMove = function (event) {
               if (!dragging) { return; }
               var dx = event.clientX - dragging.x, dy = event.clientY - dragging.y;
               if (!moved && Math.abs(dx) + Math.abs(dy) < 4) { return; }
               moved = true;
               autoFit = false;
               $scope.$apply(function () {
                  $scope.view.x = dragging.vx + dx;
                  $scope.view.y = dragging.vy + dy;
               });
            };

            var onUp = function () {
               dragging = null;
               // Let the click that ends a drag see `moved`, then reset it
               setTimeout(function () { moved = false; }, 0);
            };

            var resizeWatcher = null;

            var bindCanvas = function () {
               var box = svgBox();
               if (!box || box.wbflowBound) { return; }
               box.wbflowBound = true;
               box.addEventListener("wheel", onWheel, { passive: false });
               box.addEventListener("mousedown", onDown);
               if (window.ResizeObserver) {
                  resizeWatcher = new ResizeObserver(function () {
                     if (autoFit && $scope.graph) { $scope.$applyAsync($scope.fit); }
                  });
                  resizeWatcher.observe(box);
               }
            };
            $document.on("mousemove", onMove);
            $document.on("mouseup", onUp);
            $scope.$watch("graph", function (g) { if (g) { setTimeout(bindCanvas, 0); } });

            // --- Download as SVG ---------------------------------------------------------

            // An icon glyph drawn as a PNG (data URL), twice its size for sharpness. The SVG file cannot rely on
            // the FontAwesome font: most programs that open it do not have it and would show empty badges.
            var ICON_PX = 18;
            var iconImage = function (glyph, font, color) {
               var scale = 3, size = ICON_PX * scale;
               var canvas = document.createElement("canvas");
               canvas.width = size;
               canvas.height = size;
               var ctx = canvas.getContext("2d");
               ctx.fillStyle = color;
               ctx.textAlign = "center";
               ctx.textBaseline = "middle";
               ctx.font = Math.round(15 * scale) + "px " + font;
               ctx.fillText(glyph, size / 2, size / 2 + scale);
               return canvas.toDataURL("image/png");
            };

            $scope.downloadSvg = function () {
               var svg = $element[0].querySelector(".wbflow-canvas svg");
               if (!svg || !$scope.graph) { return; }
               var SVG_NS = "http://www.w3.org/2000/svg";
               var copy = svg.cloneNode(true);
               copy.setAttribute("xmlns", SVG_NS);
               copy.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");
               copy.setAttribute("width", $scope.graph.width);
               copy.setAttribute("height", $scope.graph.height);
               copy.setAttribute("viewBox", "0 0 " + $scope.graph.width + " " + $scope.graph.height);
               copy.setAttribute("style", "color:#444;background:#fff;font-family:Segoe UI,Arial,sans-serif");
               var g = copy.querySelector(".wbflow-root");
               if (g) { g.removeAttribute("transform"); }

               // Tooltips in the file: the object only, not the page's click hints
               _.each(copy.querySelectorAll("title"), function (t) {
                  t.textContent = String(t.textContent).split("\n")[0];
               });

               // Swap each icon glyph for an embedded image of it, drawn here with the page's FontAwesome font.
               // Wait for the font so a glyph is never drawn as an empty box.
               var fontReady = (document.fonts && document.fonts.load) ?
                  $q.when(document.fonts.load("15px FontAwesome")).catch(angular.noop) : $q.when();
               fontReady.then(function () {
                  var cache = {};
                  _.each(copy.querySelectorAll("text.wbflow-icon"), function (t) {
                     var glyph = t.textContent, font = t.getAttribute("font-family") || "FontAwesome", color = t.getAttribute("fill") || "#444";
                     var key = glyph + "|" + font + "|" + color;
                     if (!cache[key]) { cache[key] = iconImage(glyph, font, color); }
                     var img = document.createElementNS(SVG_NS, "image");
                     var cx = Number(t.getAttribute("x")) || 18;
                     img.setAttribute("x", cx - ICON_PX / 2);
                     img.setAttribute("y", 9);
                     img.setAttribute("width", ICON_PX);
                     img.setAttribute("height", ICON_PX);
                     img.setAttribute("href", cache[key]);
                     img.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", cache[key]);
                     t.parentNode.replaceChild(img, t);
                  });
                  saveSvg(copy);
               });
            };

            var saveSvg = function (copy) {
               var text = new XMLSerializer().serializeToString(copy);
               var blob = new Blob([text], { type: "image/svg+xml" });
               var link = document.createElement("a");
               link.href = URL.createObjectURL(blob);
               link.download = ($scope.selected ? fileName($scope.selected.name).replace(/\.[^.]+$/, "") : String($translate.instant("WBFLOWALLFILE"))) + " - flow.svg";
               document.body.appendChild(link);
               link.click();
               document.body.removeChild(link);
               setTimeout(function () { URL.revokeObjectURL(link.href); }, 1000);
            };

            // --- Pulse sign-in -----------------------------------------------------------

            $scope.pulseSignedIn = function () { return $pulse.isLoggedIn() && !$scope.page.needsSignIn; };
            $scope.signInToPulse = function () {
               _logger.info("Asking Arc to sign in to Pulse");
               // Cancel in Arc's Pulse sign-in dialog disconnects Pulse, and loginRequired() then does nothing
               if ($rootScope.uiPrefs.pulseDisconnected) { $pulse.setConnectedStatus(); }
               $pulse.loginRequired();
            };

            // Draw again with the current settings (levels, worksheets), keeping the levels chosen
            $scope.redraw = function () {
               if ($scope.page.mode === "all") { $scope.drawAll(true); }
               else if ($scope.selected) { $scope.draw($scope.selected); }
            };

            // After the list loads again (new period, reload, sign-in): keep the diagram in step with it
            var afterListLoad = function () {
               if (!$scope.pulseSignedIn()) { return; }
               if ($scope.page.mode === "all") { $scope.drawAll(true); return; }
               if ($scope.selected) {
                  var again = _.find($scope.workbooks, { path: $scope.selected.path });
                  if (again) { $scope.draw(again); } else { $scope.selected = null; $scope.graph = null; model = null; }
               }
            };

            // All workbooks follow the search box: draw again once the typing stops
            var searchTimer = null;
            $scope.$watch("page.search", function (now, before) {
               if (now === before || $scope.page.mode !== "all") { return; }
               if (searchTimer) { $timeout.cancel(searchTimer); }
               searchTimer = $timeout(function () { $scope.drawAll(true); }, 600);
            });

            // How many levels of cube relationships to follow from the workbook's cubes
            $scope.minLevels = 1;
            $scope.maxLevels = 5;
            $scope.changeLevels = function (step) {
               var depth = Math.min(Math.max($scope.page.depth + step, $scope.minLevels), $scope.maxLevels);
               if (depth === $scope.page.depth || $scope.page.building) { return; }
               if (step > 0 && $scope.page.allLevels) { return; }
               $scope.page.depth = depth;
               $scope.redraw();
            };

            // --- Start and events ----------------------------------------------------------

            $scope.loadWorkbooks(true);

            // Signed in (or out) of Pulse in Arc: reload the list; the diagram follows (afterListLoad)
            $scope.$on("pulse-login-change", function () {
               $scope.page.needsSignIn = false;
               $scope.loadWorkbooks(true);
            });
            $scope.$on("login-reload", function () { $scope.loadWorkbooks(true); });

            $scope.$on("close-tab", function (event, args) {
               if (args.page == "workbookFlowDiagram" && args.instance == $scope.instance) {
                  stopped = true;
                  $rootScope.close(args.page, args);
               }
            });

            $scope.$on("$destroy", function () {
               stopped = true;
               $document.off("mousemove", onMove);
               $document.off("mouseup", onUp);
               var box = svgBox();
               if (box) {
                  box.removeEventListener("wheel", onWheel);
                  box.removeEventListener("mousedown", onDown);
               }
               if (resizeWatcher) {
                  resizeWatcher.disconnect();
                  resizeWatcher = null;
               }
            });
         }]
   };
});
