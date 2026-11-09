arc.run(["$rootScope", function ($rootScope) {

   $rootScope.plugin("arcPulseSanityCheck", "Pulse API Sanity Check (Sample)", "page", {
      menu: "tools",
      icon: "fa-heartbeat",
      description: "Runs the Pulse API calls Arc makes, and the Pulse data APIs (monitoring, history, usage, alerts), through Arc's /_pulse proxy for this instance and checks each one returns the expected status",
      author: "Cubewise",
      url: "https://github.com/cubewise-code/arc-plugins-samples/tree/master/pulse-api-sanity-check",
      version: "1.4.2"
   });

}]);

arc.run(["$dialogs", function ($dialogs) {

   $dialogs.registerDialog("arcPulseSanityCheckDetailsDialog", {
      title: "Pulse request details",
      directive: "arcPulseSanityCheckDetails",
      icon: "fa-heartbeat",
      size: "large",
      okButtonClass: "d-none",
      cancelButtonLabel: "CLOSE"
   });

}]);

arc.directive("arcPulseSanityCheckDetails", function () {
   return {
      restrict: "EA",
      replace: true,
      scope: {
         data: "=arcModelData",
         options: "=arcOptions",
         dialog: "=arcDialog"
      },
      templateUrl: "__/plugins/pulse-api-sanity-check/m-details.html",
      controller: ["$scope", function ($scope) {
         var item = $scope.data.item;
         $scope.item = item;
         // A non-JSON answer (an HTML error page, a PDF) is shown as text, cut short
         $scope.responseIsText = _.isString(item.responseData);
         $scope.responseText = $scope.responseIsText ? item.responseData.substring(0, 5000) : null;
      }]
   };
});

arc.directive("arcPulseSanityCheck", function () {
   return {
      restrict: "EA",
      replace: true,
      scope: {
         instance: "=tm1Instance"
      },
      templateUrl: "__/plugins/pulse-api-sanity-check/template.html",
      controller: ["$scope", "$rootScope", "$http", "$q", "$timeout", "$tm1", "$pulse", "$dialogs",
         function ($scope, $rootScope, $http, $q, $timeout, $tm1, $pulse, $dialogs) {

            var _logger = log.getLogger("PulseSanityCheck");

            // Name of the lock and the Test Hub category the write requests create and remove again
            var TEST_NAME = "zzArcPulseSanityCheck";
            var REQUESTS_FILE = "__/plugins/pulse-api-sanity-check/requests.json";

            // Why a placeholder can have no value, shown on the skipped request
            var MISSING_HINTS = {
               serverName: "This instance is not linked to a Pulse environment (pulseenvironment in Arc's settings.yml).",
               serviceName: "This instance is not linked to a Pulse environment (pulseenvironment in Arc's settings.yml).",
               process: "No process was found on the instance.",
               chore: "No chore was found on the instance.",
               ruleCube: "No cube was found on the instance.",
               tm1User: "The TM1 user could not be read.",
               commitId: "Pulse has no change for this instance in the last 30 days, so there is no change to read.",
               commitPath: "Pulse has no change for this instance in the last 30 days, so there is no change to read.",
               commitAuthor: "Pulse has no change for this instance in the last 30 days, so there is no author to search for."
            };

            $scope.page = {
               loading: true,
               running: false,
               loadError: null,
               contextError: null,
               filter: null,
               search: "",
               totalMs: 0
            };
            $scope.requests = [];
            $scope.ctx = {};
            $scope.counts = { success: 0, warning: 0, failed: 0, skipped: 0, done: 0, total: 0 };
            $scope.methodBadge = {
               GET: "badge-success",
               POST: "badge-primary",
               PUT: "badge-info",
               PATCH: "badge-warning",
               DELETE: "badge-danger"
            };

            var stopped = false;

            // --- Helpers ---------------------------------------------------------

            var pad = function (n) { return (n < 10 ? "0" : "") + n; };
            var isoDate = function (d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); };

            var newId = function () {
               return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
                  var r = Math.random() * 16 | 0;
                  return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
               });
            };

            var odataKey = function (name) { return String(name).replace(/'/g, "''"); };

            // Replace {key} with a context value. `mode` is "url" (URL-encoded),
            // "odata" (apostrophes doubled, for a TM1 path) or "raw" (request bodies).
            // Keys with no value are added to `missing`.
            var fill = function (text, mode, missing) {
               return String(text).replace(/\{(\w+)\}/g, function (match, key) {
                  var value = $scope.ctx[key];
                  if (value === undefined || value === null || value === "") {
                     if (missing.indexOf(key) < 0) { missing.push(key); }
                     return match;
                  }
                  if (mode === "url") { return encodeURIComponent(value); }
                  if (mode === "odata") { return odataKey(value); }
                  return String(value);
               });
            };

            var fillBody = function (value, missing) {
               if (_.isString(value)) { return fill(value, "raw", missing); }
               if (_.isArray(value)) { return _.map(value, function (v) { return fillBody(v, missing); }); }
               if (_.isObject(value)) { return _.mapValues(value, function (v) { return fillBody(v, missing); }); }
               return value;
            };

            var tm1Get = function (path) {
               return $tm1.async($scope.instance, "GET", path, null).then(function (r) {
                  return r;
               }, function (e) {
                  return { status: (e && e.status) || 0, data: e && e.data };
               });
            };

            var errorMessage = function (response) {
               var d = response && response.data;
               if (d && _.isObject(d)) {
                  if (d.Message) { return d.Message; }
                  if (d.message) { return d.message; }
                  if (d.error) { return _.isString(d.error) ? d.error : (d.error.message || JSON.stringify(d.error)); }
               }
               if (response && response.status === 401) { return "Not signed in to Pulse, or the Pulse session expired."; }
               if (response && response.status === 403) { return "The Pulse user does not have access to this."; }
               if (response && response.status === -1) { return "No answer from Arc's Pulse proxy."; }
               if (response && !response.status) { return "No HTTP answer" + (response.message ? ": " + response.message : "."); }
               return (response && response.statusText) || null;
            };

            // --- Context: which Pulse server/service this instance is, and sample objects

            var loadContext = function () {
               var today = new Date();
               var monthAgo = new Date(today.getTime() - 30 * 24 * 3600 * 1000);
               $scope.ctx = {
                  today: isoDate(today),
                  monthAgo: isoDate(monthAgo),
                  testName: TEST_NAME,
                  testId: newId(),
                  testId2: newId(),
                  nowMs: Date.now(),
                  pulseUser: $rootScope.uiPrefs.pulseLoggedInUserName || null
               };
               $scope.page.contextError = null;
               var ctx = $scope.ctx;
               var notControl = "$filter=indexof(Name,'}') eq -1";

               var pulseService = $pulse.serviceFromInstance($scope.instance).then(function (service) {
                  ctx.serverName = service.serverName;
                  ctx.serviceName = service.serviceName;
               }, function (error) {
                  $scope.page.contextError = (error && error.message) || String(error);
                  _logger.warn("Instance not matched to a Pulse service", error);
               });

               var processes = tm1Get("/Processes?$select=Name&" + notControl + "&$top=1").then(function (r) {
                  if (r.status === 200 && r.data.value.length) {
                     ctx.process = r.data.value[0].Name;
                     ctx.searchText = ctx.process;
                  }
               });

               var chores = tm1Get("/Chores?$select=Name&$top=1").then(function (r) {
                  if (r.status === 200 && r.data.value.length) { ctx.chore = r.data.value[0].Name; }
               });

               // Prefer a cube that has rules; fall back to any cube
               var cubes = tm1Get("/Cubes?$select=Name&" + notControl + " and Rules ne null&$top=1").then(function (r) {
                  if (r.status === 200 && r.data.value.length) {
                     ctx.ruleCube = r.data.value[0].Name;
                     return;
                  }
                  return tm1Get("/Cubes?$select=Name&" + notControl + "&$top=1").then(function (r2) {
                     if (r2.status === 200 && r2.data.value.length) { ctx.ruleCube = r2.data.value[0].Name; }
                  });
               });

               var user = tm1Get("/ActiveUser?$select=Name").then(function (r) {
                  if (r.status === 200 && r.data) { ctx.tm1User = r.data.Name; }
               });

               return $q.all([pulseService, processes, chores, cubes, user]);
            };

            // --- Requests file -----------------------------------------------------

            var loadRequests = function () {
               // Read as text: Angular's own JSON parse error does not say where the problem is
               return $http.get(REQUESTS_FILE + "?t=" + Date.now(), {
                  transformResponse: function (text) { return text; }
               }).then(function (r) {
                  if (r.status !== 200) {
                     return $q.reject("requests.json could not be read (HTTP " + r.status + ").");
                  }
                  var list;
                  try {
                     list = JSON.parse(String(r.data).replace(/^﻿/, ""));
                  } catch (e) {
                     return $q.reject("requests.json is not valid JSON: " + e.message);
                  }
                  if (!_.isArray(list)) {
                     return $q.reject("requests.json must be a list of requests.");
                  }
                  return _.filter(list, function (item, i) {
                     var ok = item && item.name && item.method && item.url && item.statusCodeExpected;
                     if (!ok) { _logger.warn("requests.json entry " + (i + 1) + " skipped: it needs name, method, url and statusCodeExpected"); }
                     return ok;
                  });
               }, function (r) {
                  return $q.reject("requests.json could not be read (HTTP " + (r && r.status) + ").");
               });
            };

            // --- Running -----------------------------------------------------------

            var resetItem = function (item) {
               item.state = null;
               item.statusResult = null;
               item.message = null;
               item.ms = null;
               item.requestUrl = null;
               item.requestBody = null;
               item.responseData = null;
            };

            $scope.reset = function () {
               _.each($scope.requests, resetItem);
               $scope.counts = { success: 0, warning: 0, failed: 0, skipped: 0, done: 0, total: 0 };
               $scope.page.totalMs = 0;
            };

            var finish = function (item, state, message) {
               item.state = state;
               if (message !== undefined) { item.message = message; }
               $scope.counts[state]++;
               $scope.counts.done++;
               if (item.ms) { $scope.page.totalMs += item.ms; }
            };

            var expectedList = function (item) {
               return _.isArray(item.statusCodeExpected) ? item.statusCodeExpected : [item.statusCodeExpected];
            };

            var runOne = function (item) {
               resetItem(item);
               item.state = "running";

               if (item.needs && !$scope.ctx[item.needs]) {
                  finish(item, "skipped", "Not run: the step that creates its test object did not succeed.");
                  return $q.when();
               }

               var missing = [];
               var url = fill(item.url, "url", missing);
               var body = item.body !== undefined ? fillBody(item.body, missing) : undefined;
               var tm1Path = item.bodyFromTm1 ? fill(item.bodyFromTm1, "odata", missing) : null;
               item.requestUrl = url;

               if (missing.length) {
                  var hints = _.uniq(_.compact(_.map(missing, function (k) { return MISSING_HINTS[k]; })));
                  finish(item, "skipped", "No value for " + _.map(missing, function (k) { return "{" + k + "}"; }).join(", ") +
                     (hints.length ? ". " + hints.join(" ") : "."));
                  return $q.when();
               }

               // `delayBefore` (ms) gives Pulse time to index what the previous request created
               var ready = item.delayBefore ? $timeout(angular.noop, item.delayBefore) : $q.when();

               // Some requests send a TM1 object as their body (code validation)
               var bodyReady = ready.then(function () { return tm1Path ? tm1Get("/" + tm1Path) : null; }).then(function (r) {
                  if (!tm1Path) { return body; }
                  if (r.status !== 200) { return $q.reject("The request body could not be read from TM1 (" + tm1Path + ", HTTP " + r.status + ")."); }
                  return _.omit(r.data, ["@odata.context", "@odata.etag"]);
               });

               return bodyReady.then(function (requestBody) {
                  item.requestBody = requestBody;
                  var headers = _.assign({
                     // Do not let a 401 open Arc's Pulse sign-in dialog in the middle of a run
                     "x-login-no-prompt": true,
                     "x-non-interactive": true
                  }, item.headers || {});
                  var config = {
                     method: item.method, url: url, headers: headers,
                     // Some Pulse answers are plain text (api/raw returns a file): parse JSON when it is JSON, keep text otherwise
                     transformResponse: function (text) {
                        if (!_.isString(text) || !/^\s*[\[{]/.test(text)) { return text; }
                        try { return JSON.parse(text); } catch (e) { return text; }
                     }
                  };
                  if (requestBody !== undefined) {
                     config.data = requestBody;
                     headers["Content-Type"] = "application/json";
                  }
                  var started = Date.now();
                  var done = function (response) {
                     response = response || {};
                     item.ms = Date.now() - started;
                     item.statusResult = response.status;
                     item.responseData = response.data;
                     var status = response.status;
                     // Pulse reports some errors as 200 with { Failed: true, Message } (Arc checks data.Failed too)
                     var pulseFailed = response.data && _.isObject(response.data) && response.data.Failed === true;
                     if (pulseFailed) {
                        finish(item, "failed", "Pulse answered " + status + " but reported a failure: " + (response.data.Message || "no message"));
                     } else if (_.includes(expectedList(item), status)) {
                        // A capture can list several paths (the answer's shape differs between Pulse versions): the first with a value wins
                        _.each(item.capture || {}, function (paths, key) {
                           _.some(_.castArray(paths), function (path) {
                              var value = _.get(response.data, path);
                              if (value !== undefined && value !== null && value !== "") {
                                 $scope.ctx[key] = value;
                                 return true;
                              }
                              return false;
                           });
                        });
                        if (item.sets) { $scope.ctx[item.sets] = true; }
                        finish(item, "success", null);
                     } else if (status >= 200 && status < 300) {
                        finish(item, "warning", "Answered " + status + ", expected " + expectedList(item).join(" or ") + ".");
                     } else {
                        finish(item, "failed", errorMessage(response));
                     }
                  };
                  return $http(config).then(done, done);
               }, function (reason) {
                  finish(item, "failed", String(reason));
               });
            };

            var runAll = function () {
               var toRun = _.filter($scope.requests, "checked");
               $scope.reset();
               $scope.counts.total = toRun.length;
               $scope.page.running = true;
               stopped = false;
               // The write requests use fresh flags and fresh category ids on every run
               _.each($scope.requests, function (i) { if (i.sets) { delete $scope.ctx[i.sets]; } });
               $scope.ctx.testId = newId();
               $scope.ctx.testId2 = newId();
               $scope.ctx.nowMs = Date.now();

               // One at a time: later requests use values captured from earlier ones
               var chain = $q.when();
               _.each(toRun, function (item) {
                  chain = chain.then(function () {
                     if (stopped) { return; }
                     return runOne(item);
                  });
               });
               return chain['finally'](function () {
                  $scope.page.running = false;
                  _logger.info("Pulse sanity check done", $scope.counts);
                  // A test object was created but the request that removes it did not succeed
                  var left = _.filter(toRun, function (creator) {
                     return creator.sets && $scope.ctx[creator.sets] && _.some(toRun, function (i) {
                        return i.needs === creator.sets && i.method === "DELETE" && i.state !== "success";
                     });
                  });
                  if (left.length) {
                     $dialogs.error("Test data left in Pulse", "These test objects could not be removed: " +
                        _.map(left, function (i) { return i.group + ", '" + i.name + "'"; }).join("; ") +
                        ". Remove them in Pulse (object locks) or in Arc's Test Centre (test categories called '" + TEST_NAME + "...').", "medium");
                  }
               });
            };

            $scope.run = function () {
               if ($scope.page.running) { return; }
               var writes = _.filter($scope.requests, function (i) { return i.checked && i.writes; });
               if (!writes.length) {
                  runAll();
                  return;
               }
               var groups = _.uniq(_.map(writes, "group")).join(", ");
               var warnUpdate = _.some(writes, { group: "Test Hub update (writes)" }) ?
                  " Pulse 8.0.1 cannot delete a test category after it was renamed, so 'Test Hub update' may leave a category called '" + TEST_NAME + "-<id> (updated)' behind." : "";
               $dialogs.confirm("The selected write requests (" + groups + ") create test objects called '" + TEST_NAME +
                  "...' in Pulse for " + $scope.instance + " (an object lock, Test Hub categories), read them and remove them again." +
                  " No TM1 object is changed." + warnUpdate + " Run them?", runAll);
            };

            $scope.stop = function () { stopped = true; };

            // --- Selection and filtering ---------------------------------------------

            // Select all / none acts on the rows the status filter and the search show
            $scope.toggleAll = function () {
               var shown = $scope.shownRequests();
               var allOn = shown.length > 0 && _.every(shown, "checked");
               _.each(shown, function (i) { i.checked = !allOn; });
            };

            $scope.allChecked = function () {
               var shown = $scope.shownRequests();
               return shown.length > 0 && _.every(shown, "checked");
            };
            $scope.checkedCount = function () { return _.filter($scope.requests, "checked").length; };

            $scope.setFilter = function (state) {
               $scope.page.filter = $scope.page.filter === state ? null : state;
            };

            // Text searched: every column, plus the result message and where Arc uses the call
            var searchText = function (item) {
               return [
                  item.index + 1, item.group, item.name, item.method, item.url, item.requestUrl,
                  _.castArray(item.statusCodeExpected).join(" "), item.statusResult, item.state,
                  item.ms !== null && item.ms !== undefined ? item.ms + " ms" : "",
                  item.message, item.usedBy, item.writes ? "writes" : ""
               ].join(" ").toLowerCase();
            };

            $scope.visible = function (item) {
               if ($scope.page.filter && item.state !== $scope.page.filter) { return false; }
               // Every word typed must appear somewhere in the row
               var words = _.compact(String($scope.page.search || "").toLowerCase().split(/\s+/));
               if (!words.length) { return true; }
               var text = searchText(item);
               return _.every(words, function (w) { return text.indexOf(w) >= 0; });
            };

            $scope.shownRequests = function () { return _.filter($scope.requests, $scope.visible); };

            $scope.percent = function (state) {
               return $scope.counts.total ? ($scope.counts[state] / $scope.counts.total * 100) : 0;
            };

            $scope.showDetails = function (item) {
               if (!item.state || item.state === "running") { return; }
               $dialogs.showDialog("arcPulseSanityCheckDetailsDialog", { item: item }, { title: item.method + " " + item.name });
            };

            // --- Start -------------------------------------------------------------

            $scope.init = function () {
               $scope.page.loading = true;
               $scope.page.loadError = null;
               $q.all([loadRequests(), loadContext()]).then(function (results) {
                  $scope.requests = _.map(results[0], function (item, index) {
                     item.index = index;
                     item.checked = !item.writes;
                     return item;
                  });
               }, function (reason) {
                  $scope.page.loadError = String(reason);
                  _logger.error("Load failed", reason);
               })['finally'](function () {
                  $scope.page.loading = false;
               });
            };

            $scope.init();

            // Arc's own Pulse sign-in: stored credentials, or Arc's Pulse sign-in dialog
            $scope.pulseSignedIn = function () { return $pulse.isLoggedIn(); };
            $scope.signInToPulse = function () {
               // Cancel in Arc's Pulse sign-in dialog disconnects Pulse, and loginRequired() then does nothing:
               // reconnect first, as Arc's own Connect does
               if ($rootScope.uiPrefs.pulseDisconnected) {
                  _logger.info("Pulse is disconnected in Arc, reconnecting before sign-in");
                  $pulse.setConnectedStatus();
               }
               $pulse.loginRequired();
            };

            $scope.$on("pulse-login-change", function (event, args) {
               if (!$scope.page.running) { $scope.init(); }
            });

            $scope.$on("login-reload", function (event, args) {
               if (!$scope.page.running) { $scope.init(); }
            });

            $scope.$on("close-tab", function (event, args) {
               if (args.page == "arcPulseSanityCheck" && args.instance == $scope.instance) {
                  stopped = true;
                  $rootScope.close(args.page, args);
               }
            });

            $scope.$on("$destroy", function (event) {
               stopped = true;
            });
         }]
   };
});
