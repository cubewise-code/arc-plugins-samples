// Academy: short, daily, Duolingo-style lessons to learn Cubewise software.
// The lessons are in lessons.json, next to this file. Edit that file to change
// or add courses; no code change is needed.
// Progress (XP, streak, completed lessons) is stored per TM1 user in the
// control cube }Academy, which also feeds the leaderboard.

var ACADEMY_META = {
   id: "arcAcademy",
   version: "1.0.0",
   lessonsFile: "__/plugins/academy/lessons.json",
   cube: "}Academy",
   measureDim: "}Academy Measure",
   usersDim: "}Clients",
   process: "}Academy.SaveProgress",
   xpCorrect: 10,      // per exercise right at the first try
   xpPractice: 5,      // per exercise right at the first try, when replaying a finished lesson
   xpLessonBonus: 10,  // finishing a lesson for the first time
   xpPerfectBonus: 10  // no mistakes in the lesson
};

arc.run(['$rootScope', function ($rootScope) {

   $rootScope.plugin(ACADEMY_META.id, "Academy", "page", {
      menu: "tools",
      icon: "fa-graduation-cap",
      description: "Learn Cubewise software with short daily lessons: earn XP, keep your streak and climb the leaderboard. Lessons are in lessons.json.",
      author: "Cubewise",
      url: "https://github.com/cubewise-code/arc-plugins-samples/tree/master/academy",
      version: ACADEMY_META.version
   });

}]);

arc.directive("arcAcademy", function () {
   return {
      restrict: "EA",
      replace: true,
      scope: {
         instance: "=tm1Instance"
      },
      templateUrl: "__/plugins/academy/template.html",
      controller: ["$scope", "$rootScope", "$http", "$tm1", "$q", "$timeout", "$document", "$element", function ($scope, $rootScope, $http, $tm1, $q, $timeout, $document, $element) {

         var _logger = log.getLogger("Academy");
         var M = ACADEMY_META;

         // ---------------------------------------------------------------
         // State
         // ---------------------------------------------------------------
         $scope.view = { name: "loading", courseId: null };
         $scope.status = { loading: true, saving: false, error: null, storage: "cube", storageMessage: null };
         $scope.courses = [];
         $scope.me = { name: null, displayName: null };
         $scope.progress = emptyProgress();
         $scope.leaderboard = [];
         $scope.lesson = null;   // the lesson being played
         $scope.meta = M;

         function emptyProgress() {
            return { xp: 0, lessons: 0, streak: 0, bestStreak: 0, lastDay: "", completed: {} };
         }

         // ---------------------------------------------------------------
         // Helpers
         // ---------------------------------------------------------------
         var odataKey = function (name) {
            return String(name).replace(/'/g, "''");
         };

         var api = function (method, url, body) {
            return $tm1.async(
               $scope.instance,
               method,
               url,
               body !== undefined && body !== null ? JSON.stringify(body) : null
            );
         };

         var isOk = function (r) {
            return r && (r.status === 200 || r.status === 201 || r.status === 204);
         };

         var errorText = function (r) {
            return (r && r.data && r.data.error && r.data.error.message) || ("HTTP " + (r && r.status));
         };

         var pad = function (n) { return (n < 10 ? "0" : "") + n; };

         var dayString = function (date) {
            return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());
         };

         var today = function () { return dayString(new Date()); };

         var yesterday = function () {
            var d = new Date();
            d.setDate(d.getDate() - 1);
            return dayString(d);
         };

         var shuffle = function (list) {
            var a = list.slice();
            for (var i = a.length - 1; i > 0; i--) {
               var j = Math.floor(Math.random() * (i + 1));
               var t = a[i]; a[i] = a[j]; a[j] = t;
            }
            return a;
         };

         // A streak only counts if the last lesson was today or yesterday
         $scope.currentStreak = function () {
            var p = $scope.progress;
            return (p.lastDay === today() || p.lastDay === yesterday()) ? p.streak : 0;
         };

         $scope.doneToday = function () {
            return $scope.progress.lastDay === today();
         };

         // ---------------------------------------------------------------
         // Lessons file
         // ---------------------------------------------------------------
         var TYPES = ["choice", "truefalse", "fill", "match", "order"];

         var validExercise = function (ex) {
            if (!ex || TYPES.indexOf(ex.type) < 0 || !ex.q) { return false; }
            switch (ex.type) {
               case "choice":
               case "fill":
                  return angular.isArray(ex.options) && ex.options.length >= 2 &&
                     ex.answer >= 0 && ex.answer < ex.options.length;
               case "truefalse":
                  return ex.answer === true || ex.answer === false;
               case "match":
                  return angular.isArray(ex.pairs) && ex.pairs.length >= 2;
               case "order":
                  return angular.isArray(ex.items) && ex.items.length >= 2;
            }
            return false;
         };

         // Accepts { courses: [...] } or a single course { course/title, units }
         var normaliseCourses = function (data) {
            var list = angular.isArray(data && data.courses) ? data.courses : (data && data.units ? [data] : []);
            var courses = [];
            _.each(list, function (course, ci) {
               var c = {
                  id: course.id || ("course" + ci),
                  title: course.title || course.course || "Course",
                  description: course.description || "",
                  icon: course.icon || "fa-graduation-cap",
                  color: /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(course.color || "") ? course.color : null,
                  units: [],
                  lessons: []
               };
               _.each(course.units || [], function (unit, ui) {
                  var u = {
                     id: unit.id || (c.id + "-u" + ui),
                     title: unit.title || "",
                     icon: unit.icon || "fa-book",
                     objective: unit.objective || "",
                     lessons: []
                  };
                  // The Confluence pages the unit's content comes from: [{ title, source }]
                  var pageLink = function (source) {
                     return /^https?:\/\//.test(String(source || "")) ? source :
                        (course.sourceUrl && source ? String(course.sourceUrl).replace("{source}", encodeURIComponent(source)) : null);
                  };
                  u.sources = _.filter(_.map(unit.sources || [], function (s) {
                     var link = pageLink(s && s.source);
                     return link ? { title: s.title || "Manual page", link: link } : null;
                  }));
                  _.each(unit.lessons || [], function (lesson, li) {
                     var exercises = _.filter(lesson.exercises || [], function (ex) {
                        var ok = validExercise(ex);
                        if (!ok) { _logger.warn("Skipped an invalid exercise in lesson", lesson.id || lesson.title, ex); }
                        return ok;
                     });
                     if (!exercises.length) { return; }
                     var l = {
                        id: lesson.id || (u.id + "-l" + li),
                        title: lesson.title || ("Lesson " + (li + 1)),
                        tip: lesson.tip || "",
                        source: lesson.source || null,
                        // "Read more" link: the course's sourceUrl with {source} replaced by the lesson's source,
                        // or a full URL given as the lesson's source
                        link: /^https?:\/\//.test(String(lesson.source || "")) ? lesson.source :
                           (course.sourceUrl && lesson.source ? String(course.sourceUrl).replace("{source}", encodeURIComponent(lesson.source)) : null),
                        exercises: exercises,
                        unit: u,
                        course: c
                     };
                     // Everything the search box looks in, lower case. Not the unit objective:
                     // it names topics of several lessons, so every lesson of the unit would match.
                     l.searchText = _.flattenDeep([
                        l.title, l.tip, u.title,
                        _.map(exercises, function (ex) { return [ex.q, ex.options, ex.pairs, ex.items, ex.explain]; })
                     ]).filter(function (t) { return typeof t === "string"; }).join(" ").toLowerCase();
                     u.lessons.push(l);
                     c.lessons.push(l);
                  });
                  if (u.lessons.length) { c.units.push(u); }
               });
               if (c.lessons.length) { courses.push(c); }
            });
            return courses;
         };

         var loadLessons = function () {
            // The query string stops the browser from caching an old copy of the file
            // Read it as text and parse it here, so a typo gives a message that says where it is
            return $http.get(M.lessonsFile + "?t=" + Date.now(), {
               transformResponse: function (text) { return text; }
            }).then(function (r) {
               if (r.status !== 200) {
                  return $q.reject("lessons.json could not be read (HTTP " + r.status + ").");
               }
               var data;
               try {
                  data = JSON.parse(String(r.data).replace(/^﻿/, ""));
               } catch (e) {
                  return $q.reject("lessons.json is not valid JSON: " + e.message + ". Fix the file and try again.");
               }
               var courses = normaliseCourses(data);
               if (!courses.length) {
                  return $q.reject("lessons.json has no lessons with valid exercises.");
               }
               return courses;
            }, function (r) {
               return $q.reject("lessons.json could not be read (HTTP " + (r && r.status) + ").");
            });
         };

         // ---------------------------------------------------------------
         // Storage: the }Academy cube, or this browser when the cube is not available
         // ---------------------------------------------------------------
         var MEASURES = [
            { Name: "XP", Type: "Numeric" },
            { Name: "Lessons", Type: "Numeric" },
            { Name: "Streak", Type: "Numeric" },
            { Name: "BestStreak", Type: "Numeric" },
            { Name: "LastDay", Type: "String" },
            { Name: "Completed", Type: "String" },
            { Name: "DisplayName", Type: "String" }
         ];

         // The process writes only the row of the user who runs it (TM1User()),
         // so nobody can change someone else's score.
         var PROLOG =
            "sUser = TM1User();\r\n" +
            "IF( DIMIX( '" + M.usersDim + "', sUser ) = 0 );\r\n" +
            "  ProcessQuit;\r\n" +
            "ENDIF;\r\n" +
            "sCube = '" + M.cube + "';\r\n" +
            "CellPutN( pXP, sCube, sUser, 'XP' );\r\n" +
            "CellPutN( pLessons, sCube, sUser, 'Lessons' );\r\n" +
            "CellPutN( pStreak, sCube, sUser, 'Streak' );\r\n" +
            "CellPutN( pBestStreak, sCube, sUser, 'BestStreak' );\r\n" +
            "CellPutS( pLastDay, sCube, sUser, 'LastDay' );\r\n" +
            "CellPutS( pCompleted, sCube, sUser, 'Completed' );\r\n" +
            "CellPutS( pDisplayName, sCube, sUser, 'DisplayName' );\r\n";

         var PARAMETERS = [
            { Name: "pXP", Prompt: "XP", Type: "Numeric", Value: 0 },
            { Name: "pLessons", Prompt: "Lessons completed", Type: "Numeric", Value: 0 },
            { Name: "pStreak", Prompt: "Streak", Type: "Numeric", Value: 0 },
            { Name: "pBestStreak", Prompt: "Best streak", Type: "Numeric", Value: 0 },
            { Name: "pLastDay", Prompt: "Last day (YYYY-MM-DD)", Type: "String", Value: "" },
            { Name: "pCompleted", Prompt: "Completed lesson ids", Type: "String", Value: "" },
            { Name: "pDisplayName", Prompt: "Display name", Type: "String", Value: "" }
         ];

         var exists = function (url) {
            return api("GET", url).then(function (r) { return r.status === 200; }, function () { return false; });
         };

         var createDimension = function () {
            return api("POST", "/Dimensions", {
               Name: M.measureDim,
               Hierarchies: [{ Name: M.measureDim, Elements: MEASURES }]
            });
         };

         var createCube = function () {
            return api("POST", "/Cubes", {
               Name: M.cube,
               "Dimensions@odata.bind": [
                  "Dimensions('" + odataKey(M.usersDim) + "')",
                  "Dimensions('" + odataKey(M.measureDim) + "')"
               ]
            });
         };

         var createProcess = function () {
            return api("POST", "/Processes", {
               Name: M.process,
               Parameters: PARAMETERS,
               PrologProcedure: PROLOG
            }).then(function (r) {
               if (!isOk(r)) { return r; }
               // A process saves even with broken code, so compile it to be sure
               return api("POST", "/Processes('" + odataKey(M.process) + "')/tm1.Compile", {}).then(function (c) {
                  // Through Arc's async handling the compile can answer 201 as well as 200
                  if ((c.status === 200 || c.status === 201) && c.data && c.data.value && c.data.value.length) {
                     _logger.error("The progress process does not compile", c.data.value);
                     return { status: 500, data: { error: { message: "The process " + M.process + " does not compile." } } };
                  }
                  return r;
               });
            });
         };

         // Creates the cube, its measure dimension and the process if they are not there.
         // Resolves when they all exist; rejects with a message otherwise.
         var ensureObjects = function () {
            var cubeUrl = "/Cubes('" + odataKey(M.cube) + "')?$select=Name";
            var dimUrl = "/Dimensions('" + odataKey(M.measureDim) + "')?$select=Name";
            var procUrl = "/Processes('" + odataKey(M.process) + "')?$select=Name";

            var step = function (found, url, create, label) {
               return $q.when(found).then(function (found) {
                  if (found) { return; }
                  _logger.info("Creating " + label);
                  return create().then(function (r) {
                     if (!isOk(r)) { return $q.reject("Could not create " + label + ": " + errorText(r)); }
                  }, function () {
                     // A fast write can reject although TM1 saved it, so look again
                     return exists(url).then(function (ok) {
                        if (!ok) { return $q.reject("Could not create " + label + "."); }
                     });
                  });
               });
            };

            // Look for all three at once (the usual case: they exist), then create
            // what is missing in order: the cube needs the dimension first
            return $q.all([exists(dimUrl), exists(cubeUrl), exists(procUrl)]).then(function (found) {
               return step(found[0], dimUrl, createDimension, "the dimension " + M.measureDim)
                  .then(function () { return step(found[1], cubeUrl, createCube, "the cube " + M.cube); })
                  .then(function () { return step(found[2], procUrl, createProcess, "the process " + M.process); });
            });
         };

         var loadActiveUser = function () {
            return api("GET", "/ActiveUser?$select=Name,FriendlyName").then(function (r) {
               if (r.status !== 200) { return $q.reject("Could not read the active user: " + errorText(r)); }
               $scope.me.name = r.data.Name;
               $scope.me.displayName = r.data.FriendlyName || r.data.Name;
            });
         };

         var parseCompleted = function (text) {
            var done = {};
            _.each(String(text || "").split(","), function (id) {
               id = id.trim();
               if (id) { done[id] = true; }
            });
            return done;
         };

         var rowToProgress = function (row) {
            return {
               xp: Number(row.XP) || 0,
               lessons: Number(row.Lessons) || 0,
               streak: Number(row.Streak) || 0,
               bestStreak: Number(row.BestStreak) || 0,
               lastDay: row.LastDay || "",
               completed: parseCompleted(row.Completed)
            };
         };

         // Reads every user's row from the cube: feeds the leaderboard and my progress
         var loadCube = function () {
            var measureHier = "[" + M.measureDim + "].[" + M.measureDim + "]";
            var userHier = "[" + M.usersDim + "].[" + M.usersDim + "]";
            var mdx = "SELECT {TM1SUBSETALL(" + measureHier + ")} ON COLUMNS, " +
               "NON EMPTY {TM1SUBSETALL(" + userHier + ")} ON ROWS " +
               "FROM [" + M.cube + "]";
            return api("POST", "/ExecuteMDX?$expand=Axes($expand=Tuples($expand=Members($select=Name))),Cells($select=Ordinal,Value)", { MDX: mdx })
               .then(function (r) {
                  if (r.status !== 200 && r.status !== 201) { return $q.reject("Could not read " + M.cube + ": " + errorText(r)); }
                  var axes = r.data.Axes || [];
                  var cols = _.map((axes[0] && axes[0].Tuples) || [], function (t) { return t.Members[0].Name; });
                  var rows = _.map((axes[1] && axes[1].Tuples) || [], function (t) { return t.Members[0].Name; });
                  var cells = {};
                  _.each(r.data.Cells || [], function (c) { cells[c.Ordinal] = c.Value; });
                  var users = [];
                  _.each(rows, function (user, ri) {
                     var row = { user: user };
                     _.each(cols, function (col, ci) { row[col] = cells[ri * cols.length + ci]; });
                     users.push(row);
                  });
                  return users;
               });
         };

         var buildLeaderboard = function (users) {
            var board = _.map(users, function (row) {
               var p = rowToProgress(row);
               var active = p.lastDay === today() || p.lastDay === yesterday();
               return {
                  user: row.user,
                  name: row.DisplayName || row.user,
                  xp: p.xp,
                  lessons: p.lessons,
                  streak: active ? p.streak : 0,
                  me: row.user === $scope.me.name
               };
            });
            board = _.filter(board, function (b) { return b.xp > 0; });
            board.sort(function (a, b) { return b.xp - a.xp || b.lessons - a.lessons; });
            $scope.leaderboard = board.slice(0, 10);
            var myRank = _.findIndex(board, { me: true });
            $scope.myRank = myRank >= 0 ? myRank + 1 : null;
         };

         var localKey = function () {
            return "arcAcademy:" + $scope.instance + ":" + ($scope.me.name || "user");
         };

         var loadLocal = function () {
            try {
               var saved = JSON.parse(window.localStorage.getItem(localKey()) || "null");
               if (saved) {
                  saved.completed = parseCompleted(saved.completed);
                  return saved;
               }
            } catch (e) {
               _logger.warn("Could not read the progress saved in this browser", e);
            }
            return emptyProgress();
         };

         var saveLocal = function (p) {
            try {
               var copy = angular.copy(p);
               copy.completed = _.keys(p.completed).join(",");
               window.localStorage.setItem(localKey(), JSON.stringify(copy));
            } catch (e) {
               _logger.warn("Could not save progress in this browser", e);
            }
         };

         var refreshFromCube = function () {
            return loadCube().then(function (users) {
               var mine = _.find(users, { user: $scope.me.name });
               $scope.progress = mine ? rowToProgress(mine) : emptyProgress();
               buildLeaderboard(users);
            });
         };

         var useLocalStorage = function (reason) {
            _logger.warn("Academy progress falls back to this browser:", reason);
            $scope.status.storage = "local";
            $scope.status.storageMessage = reason;
            $scope.progress = loadLocal();
            $scope.leaderboard = [];
         };

         var saveProgress = function () {
            var p = $scope.progress;
            if ($scope.status.storage === "local") {
               saveLocal(p);
               return $q.when();
            }
            $scope.status.saving = true;
            var values = {
               pXP: p.xp,
               pLessons: p.lessons,
               pStreak: p.streak,
               pBestStreak: p.bestStreak,
               pLastDay: p.lastDay,
               pCompleted: _.keys(p.completed).join(","),
               pDisplayName: $scope.me.displayName || $scope.me.name
            };
            var body = { Parameters: _.map(values, function (value, name) { return { Name: name, Value: value }; }) };
            // Keep a copy in this browser too, in case the save fails
            saveLocal(p);
            var write = api("POST", "/Processes('" + odataKey(M.process) + "')/tm1.Execute", body).then(function (r) {
               if (!isOk(r)) { _logger.error("Saving progress failed", errorText(r)); }
            }, function () {
               // A fast write can reject although TM1 saved it: the reload below shows the truth
            });
            return write["finally"](function () {
               return refreshFromCube().catch(function (e) {
                  _logger.error("Reloading progress failed", e);
               })["finally"](function () {
                  $scope.status.saving = false;
               });
            });
         };

         // ---------------------------------------------------------------
         // Course path
         // ---------------------------------------------------------------
         $scope.course = function () {
            return _.find($scope.courses, { id: $scope.view.courseId }) || $scope.courses[0];
         };

         $scope.selectCourse = function (course) {
            $scope.view.courseId = course.id;
         };

         // Selected buttons and progress bars take the product colour of the course on screen:
         // the lesson's course while playing, the selected course on the home page
         var textOn = function (hex) {
            var h = hex.length === 4 ? hex.replace(/^#(.)(.)(.)$/, "#$1$1$2$2$3$3") : hex;
            var r = parseInt(h.substr(1, 2), 16), g = parseInt(h.substr(3, 2), 16), b = parseInt(h.substr(5, 2), 16);
            // Dark text on light colours (such as yellow), white text otherwise
            return (0.299 * r + 0.587 * g + 0.114 * b) > 186 ? "#212529" : "#fff";
         };

         $scope.$watch(function () {
            var c = $scope.lesson ? $scope.lesson.lesson.course : $scope.course();
            return (c && c.color) || "";
         }, function (color) {
            var el = $element[0];
            if (!el || !el.style) { return; }
            if (color) {
               el.style.setProperty("--academy-accent", color);
               el.style.setProperty("--academy-accent-text", textOn(color));
            } else {
               el.style.removeProperty("--academy-accent");
               el.style.removeProperty("--academy-accent-text");
            }
         });

         $scope.isDone = function (lesson) {
            return !!$scope.progress.completed[lesson.id];
         };

         // The next lesson to do: the first one not completed, in course order
         $scope.nextLesson = function (course) {
            course = course || $scope.course();
            if (!course) { return null; }
            return _.find(course.lessons, function (l) { return !$scope.isDone(l); }) || null;
         };

         $scope.courseProgress = function (course) {
            var done = _.filter(course.lessons, $scope.isDone).length;
            return { done: done, total: course.lessons.length, pct: Math.round(100 * done / course.lessons.length) };
         };

         $scope.unitDone = function (unit) {
            return _.every(unit.lessons, $scope.isDone);
         };

         // ---------------------------------------------------------------
         // Search: every word typed must appear in the lesson (title, tip, unit, questions, answers)
         // ---------------------------------------------------------------
         $scope.search = { text: "" };

         var searchWords = function () {
            return String($scope.search.text || "").toLowerCase().split(/\s+/).filter(Boolean);
         };

         $scope.searching = function () {
            return searchWords().length > 0;
         };

         $scope.lessonMatches = function (lesson) {
            var words = searchWords();
            return _.every(words, function (w) { return lesson.searchText.indexOf(w) >= 0; });
         };

         $scope.unitLessons = function (unit) {
            return $scope.searching() ? _.filter(unit.lessons, $scope.lessonMatches) : unit.lessons;
         };

         $scope.matchCount = function () {
            var course = $scope.course();
            return course ? _.filter(course.lessons, $scope.lessonMatches).length : 0;
         };

         $scope.clearSearch = function () {
            $scope.search.text = "";
         };

         // ---------------------------------------------------------------
         // Playing a lesson
         // ---------------------------------------------------------------
         var prepareExercise = function (ex) {
            var item = { ex: ex, attempts: 0, firstTryRight: null };
            if (ex.type === "order") {
               item.pool = shuffle(_.map(ex.items, function (text, i) { return { text: text, index: i, used: false }; }));
               // Make sure the shuffled list is not already in the right order
               if (_.every(item.pool, function (p, i) { return p.index === i; })) { item.pool.reverse(); }
               item.answer = [];
            } else if (ex.type === "match") {
               item.left = _.map(ex.pairs, function (p, i) { return { text: p[0], index: i, matched: false }; });
               item.right = shuffle(_.map(ex.pairs, function (p, i) { return { text: p[1], index: i, matched: false }; }));
               item.pick = null;
               item.wrong = null;
               item.mistakes = 0;
            }
            item.choice = { value: null };
            return item;
         };

         // Every lesson is open: users can start anywhere. "Today's lesson" only suggests the next one.
         $scope.startLesson = function (lesson) {
            if (!lesson) { return; }
            $scope.lesson = {
               lesson: lesson,
               practice: $scope.isDone(lesson),
               queue: _.map(lesson.exercises, prepareExercise),
               total: lesson.exercises.length,
               rightCount: 0,
               mistakes: 0,
               xp: 0,
               current: null,
               state: "intro",   // intro | question | feedback | finished
               feedback: null
            };
            $scope.view.name = "lesson";
         };

         $scope.beginExercises = function () {
            nextExercise();
         };

         var nextExercise = function () {
            var L = $scope.lesson;
            L.current = L.queue.shift() || null;
            L.feedback = null;
            if (!L.current) {
               finishLesson();
               return;
            }
            // A retried exercise starts clean
            if (L.current.attempts > 0) {
               var fresh = prepareExercise(L.current.ex);
               fresh.attempts = L.current.attempts;
               fresh.firstTryRight = false;
               L.current = fresh;
            }
            L.state = "question";
         };

         $scope.progressPct = function () {
            var L = $scope.lesson;
            return L ? Math.round(100 * L.rightCount / L.total) : 0;
         };

         // -- choice, truefalse, fill
         $scope.choose = function (value) {
            if ($scope.lesson.state !== "question") { return; }
            $scope.lesson.current.choice.value = value;
         };

         $scope.fillSentence = function (item) {
            var parts = String(item.ex.q).split("___");
            var word = item.choice.value !== null ? item.ex.options[item.choice.value] : "_____";
            return { before: parts[0], word: word, after: parts.slice(1).join("___"), filled: item.choice.value !== null };
         };

         // -- order
         $scope.orderPick = function (piece) {
            var item = $scope.lesson.current;
            if ($scope.lesson.state !== "question" || piece.used) { return; }
            piece.used = true;
            item.answer.push(piece);
         };

         $scope.orderUnpick = function (piece) {
            var item = $scope.lesson.current;
            if ($scope.lesson.state !== "question") { return; }
            piece.used = false;
            item.answer.splice(item.answer.indexOf(piece), 1);
         };

         // -- match: instant feedback per pair
         $scope.matchPick = function (side, entry) {
            var item = $scope.lesson.current;
            if ($scope.lesson.state !== "question" || entry.matched) { return; }
            if (side === "left") {
               item.pick = entry;
               item.wrong = null;
               return;
            }
            if (!item.pick) { return; }
            if (item.pick.index === entry.index) {
               item.pick.matched = true;
               entry.matched = true;
               item.pick = null;
               if (_.every(item.left, "matched")) { $scope.check(); }
            } else {
               item.mistakes++;
               item.wrong = { left: item.pick, right: entry };
               $timeout(function () { item.wrong = null; }, 700);
            }
         };

         $scope.canCheck = function () {
            var L = $scope.lesson;
            if (!L || L.state !== "question" || !L.current) { return false; }
            var item = L.current;
            switch (item.ex.type) {
               case "order": return item.answer.length === item.ex.items.length;
               case "match": return false; // checks itself when every pair is matched
               default: return item.choice.value !== null;
            }
         };

         var isRight = function (item) {
            var ex = item.ex;
            switch (ex.type) {
               case "choice":
               case "fill":
                  return item.choice.value === ex.answer;
               case "truefalse":
                  return item.choice.value === ex.answer;
               case "order":
                  return _.every(item.answer, function (p, i) { return p.index === i; });
               case "match":
                  return item.mistakes === 0;
            }
            return false;
         };

         var correctAnswerText = function (ex) {
            switch (ex.type) {
               case "choice":
               case "fill":
                  return ex.options[ex.answer];
               case "truefalse":
                  return ex.answer ? "True" : "False";
               case "order":
                  return ex.items.join("  >  ");
               case "match":
                  return _.map(ex.pairs, function (p) { return p[0] + " = " + p[1]; }).join(";  ");
            }
            return "";
         };

         $scope.check = function () {
            var L = $scope.lesson;
            if (!L || L.state !== "question") { return; }
            var item = L.current;
            var right = isRight(item);
            item.attempts++;
            if (item.firstTryRight === null) { item.firstTryRight = right; }

            if (item.ex.type === "match") {
               // Every pair is matched by now, so the exercise is done; mistakes only cost the XP
               L.rightCount++;
               if (item.firstTryRight) { L.xp += L.practice ? M.xpPractice : M.xpCorrect; } else { L.mistakes++; }
               L.feedback = { right: item.mistakes === 0, retry: false, explain: item.ex.explain, answer: null, praise: praise() };
            } else if (right) {
               L.rightCount++;
               if (item.firstTryRight) { L.xp += L.practice ? M.xpPractice : M.xpCorrect; }
               L.feedback = { right: true, retry: false, explain: item.ex.explain, answer: null, praise: praise() };
            } else {
               L.mistakes++;
               // Wrong answers come back at the end of the lesson, as in Duolingo
               L.queue.push(item);
               L.feedback = { right: false, retry: true, explain: item.ex.explain, answer: correctAnswerText(item.ex) };
            }
            L.state = "feedback";
            scrollToFooter();
         };

         // On a small screen the feedback can be below the fold: bring it and Continue into view
         var scrollToFooter = function () {
            $timeout(function () {
               var box = $element[0].querySelector(".academy-footer");
               if (box && box.scrollIntoView) { box.scrollIntoView({ block: "nearest", behavior: "smooth" }); }
            });
         };

         var PRAISE = ["Nice!", "Great job!", "Correct!", "You got it!", "Excellent!", "Spot on!"];
         var praise = function () { return PRAISE[Math.floor(Math.random() * PRAISE.length)]; };

         $scope.goOn = function () {
            if ($scope.lesson && $scope.lesson.state === "feedback") { nextExercise(); }
         };

         // Streak: one finished lesson a day keeps it going
         var bumpStreak = function (L) {
            var p = $scope.progress;
            var t = today();
            L.streakBefore = $scope.currentStreak();
            if (p.lastDay !== t) {
               p.streak = (p.lastDay === yesterday()) ? p.streak + 1 : 1;
               p.lastDay = t;
            }
            p.bestStreak = Math.max(p.bestStreak || 0, p.streak);
            L.streakAfter = p.streak;
            L.streakUp = L.streakAfter > L.streakBefore;
         };

         var finishLesson = function () {
            var L = $scope.lesson;
            var p = $scope.progress;
            var firstTime = !p.completed[L.lesson.id];
            var perfect = L.mistakes === 0;

            L.bonus = 0;
            if (firstTime) { L.bonus += M.xpLessonBonus; }
            if (perfect) { L.bonus += M.xpPerfectBonus; }
            L.xp += L.bonus;
            L.perfect = perfect;

            bumpStreak(L);

            p.xp += L.xp;
            if (firstTime) {
               p.completed[L.lesson.id] = true;
               p.lessons = _.keys(p.completed).length;
            }
            L.firstTime = firstTime;
            L.state = "finished";
            saveProgress();
         };

         $scope.quitLesson = function () {
            $scope.lesson = null;
            $scope.view.name = "home";
         };

         $scope.backHome = function () {
            $scope.lesson = null;
            $scope.view.name = "home";
         };

         // Keyboard, as in Duolingo: Enter checks or continues, 1-9 picks an answer.
         // Returns true when the key was used.
         $scope.keydown = function (event) {
            var L = $scope.lesson;
            if (!L || $scope.view.name !== "lesson") { return false; }
            if (event.keyCode === 13) {
               if (L.state === "intro") { $scope.beginExercises(); }
               else if (L.state === "question" && $scope.canCheck()) { $scope.check(); }
               else if (L.state === "feedback") { $scope.goOn(); }
               else if (L.state === "finished") { $scope.backHome(); }
               else { return false; }
               return true;
            }
            var n = event.keyCode >= 49 && event.keyCode <= 57 ? event.keyCode - 49 : -1;
            if (n >= 0 && L.state === "question" && L.current) {
               var ex = L.current.ex;
               if ((ex.type === "choice" || ex.type === "fill") && n < ex.options.length) { $scope.choose(n); return true; }
               if (ex.type === "truefalse" && n < 2) { $scope.choose(n === 0); return true; }
            }
            return false;
         };

         // Listen on the document: after a click the focus often goes back to <body>,
         // where a key would never reach this page. Only act while this tab is the one shown,
         // and never while the user types in a field.
         var onDocumentKey = function (event) {
            var el = $element[0];
            if (!el || !el.offsetParent) { return; }
            var target = event.target || {};
            var tag = (target.tagName || "").toLowerCase();
            if (tag === "input" || tag === "textarea" || tag === "select" || target.isContentEditable) { return; }
            if (event.ctrlKey || event.altKey || event.metaKey) { return; }
            var used = false;
            $scope.$apply(function () { used = $scope.keydown(event); });
            if (used) { event.preventDefault(); }
         };
         $document.on("keydown", onDocumentKey);
         $scope.$on("$destroy", function () {
            $document.off("keydown", onDocumentKey);
         });

         // ---------------------------------------------------------------
         // Start
         // ---------------------------------------------------------------
         var init = function () {
            $scope.status.loading = true;
            $scope.status.error = null;
            $scope.view.name = "loading";
            // The lessons, the user and the TM1 objects do not depend on each other: load them together
            var objects = ensureObjects().then(function () { return true; }, function (reason) {
               return typeof reason === "string" ? reason : "The " + M.cube + " cube is not available.";
            });
            $q.all([loadLessons(), loadActiveUser(), objects]).then(function (results) {
               var courses = results[0];
               $scope.courses = courses;
               if (!_.find(courses, { id: $scope.view.courseId })) { $scope.view.courseId = courses[0].id; }
               $scope.status.storage = "cube";
               if (results[2] !== true) {
                  useLocalStorage(results[2]);
                  return;
               }
               return refreshFromCube().catch(function (reason) {
                  useLocalStorage(typeof reason === "string" ? reason : "The " + M.cube + " cube could not be read.");
               });
            }).then(function () {
               $scope.view.name = "home";
            }).catch(function (reason) {
               $scope.status.error = typeof reason === "string" ? reason : "Academy could not start.";
               _logger.error("Academy could not start", reason);
               $scope.view.name = "error";
            })["finally"](function () {
               $scope.status.loading = false;
            });
         };

         $scope.reload = init;

         init();

         //Close the tab
         $scope.$on("close-tab", function (event, args) {
            // Event to capture when a user has clicked close on the tab
            if (args.page == M.id && args.instance == $scope.instance) {
               // The page matches this one so close it
               $rootScope.close(args.page, args);
            }
         });

         $scope.$on("login-reload", function (event, args) {
            if (args && args.instance && args.instance !== $scope.instance) { return; }
            init();
         });

      }]
   };
});
