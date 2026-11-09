/* TM1 12 Readiness -- an Arc for TM1 plugin (called "SaaS Migration" up to v0.2.2).
 *
 * Prepares a TM1 v11 database for IBM's Database Migration Utility (migrate_tm1)
 * and checks a live TM1 v12 (PA as a Service) database afterwards:
 * find -> suggest -> apply, one finding at a time or in bulk.
 *
 * Layout, as in calculation-explorer: `saasMigrationCore` is pure (no $http, no
 * DOM) and holds everything worth testing -- the TI tokenizer, the variable
 * data-flow the REMOVE fixer needs, the scanners, the fixers, the rule catalogue
 * and the CSV codec. The directive is the thin I/O layer. `tests/run-tests.js`
 * loads this file under node with `arc` stubbed.
 *
 * Plain ES5. Arc concatenates every plugin's plugin.js into one bundle, so this
 * file declares no top-level `var`: everything lives inside a registration.
 * See tm1-12-readiness/PROJECT-PLAN.md for why each rule looks the way it does --
 * section numbers below (§2.x) point at measurements recorded there. */

arc.run(['$rootScope', 'saasMigrationCore', function ($rootScope, core) {
   /* Renamed from "SaaS Migration" (user, 2026-09-29): TM1 v12 is on
    * PA as a Service and on local installs alike. Internal names -- the core's
    * `saasMigrationCore`, the SAASMIG_ string keys, and the `# SAASMIG` marker
    * that fixes leave in TI code -- stay as they were, so markers already
    * written into models are still found by a search. */
   $rootScope.plugin("tm1Readiness", "TM1 12 Readiness", "page", {
      menu: "tools",
      /* The page heading's own icon (user, 2026-10-06): a checkbox among the
       * Tools did not say "migration", and one icon on the menu and the page
       * lets the eye find the entry it has already seen at the top of the page. */
      icon: "fa-cloud-upload",
      // without a path Arc makes the route /tm-1-readiness/:instance -- it splits the digit off
      path: "/tm1-12-readiness/:instance",
      description: "Find, suggest and apply the fixes a TM1 v11 model needs before IBM's migration to TM1 v12 (PA as a Service).",
      author: "Cubewise",
      url: "https://github.com/meissacw/arc_plugins",
      version: core.VERSION
   });
   /* "Where used" on Arc's tree menu (v0.7.0). Arc 6.0.0's bundle offers
    * menu/process, menu/cube and menu/dimension, and dispatches a menu click by
    * plugin name -- so one plugin id, and one service, per object type: that is
    * how the page learns which kind of object was clicked. */
   [["Process", "menu/process"], ["Cube", "menu/cube"], ["Dimension", "menu/dimension"]].forEach(function (m) {
      $rootScope.plugin("tm1ReadinessWhereUsed" + m[0], "Where used (TM1 12 Readiness)", m[1], {
         icon: "fa-sitemap",
         description: "Every process, chore, cube and rule that uses this " + m[0].toLowerCase() + ", and which of them break on TM1 12.",
         author: "Cubewise",
         version: core.VERSION
      });
   });
}]);

/* Carries a tree-menu click over to the page. Arc drops any state parameter
 * but :instance, so the request cannot travel in the URL: `take` serves a page
 * opened by the click, the broadcast a page already open (calculation-explorer
 * does the same for its menu). */
arc.factory("tm1ReadinessRequest", ['$rootScope', function ($rootScope) {
   var pending = null;
   return {
      set: function (request) { pending = request; $rootScope.$broadcast("tm1-readiness-request", request); },
      take: function (instance) {
         if (pending && pending.instance === instance) { var r = pending; pending = null; return r; }
         return null;
      }
   };
}]);

/* The open project, one per page (v0.14.0). Every plugin tab in Arc is its own
 * directive, so the project lives here, where two tabs on two databases share
 * one folder, one write queue and one status line. Two backends, one shape:
 *
 *  - "folder": a directory the user picked (File System Access API). Arc on
 *    localhost is a secure context, so Edge and Chrome offer the picker; the
 *    handle is kept in IndexedDB, and a new session needs one click to allow
 *    the folder again (requestPermission needs a user gesture).
 *  - "browser": no picker (another browser, or Arc reached as http://<host>,
 *    which is not a secure context). The files live in IndexedDB and the
 *    project travels as one file, downloaded and opened again.
 *
 * Native promises are wrapped in $q so a result lands inside a digest. A
 * window holding a project takes a Web Lock on it, so a second window cannot
 * write the same folder at the same time. */
arc.factory("tm1ReadinessProject", ['$q', '$rootScope', 'saasMigrationCore', function ($q, $rootScope, core) {
   var DB_NAME = "tm1Readiness", CURRENT = "tm1Readiness.project.current", RECENT_KEEP = 10;
   var api = {
      current: null,      // { project, mode, handle, folder, status, savedAt, error }
      recent: [],         // [{ id, name, mode, handle, folder, lastOpened, databases }]
      ready: null
   };

   // ------------------------------------------------------------- IndexedDB
   var dbp = null;
   var idb = function () {
      if (dbp) return dbp;
      dbp = $q(function (resolve, reject) {
         if (!window.indexedDB) { reject(new Error("IndexedDB is not available")); return; }
         var rq = window.indexedDB.open(DB_NAME, 1);
         rq.onupgradeneeded = function () {
            var db = rq.result;
            if (!db.objectStoreNames.contains("projects")) db.createObjectStore("projects", { keyPath: "id" });
            if (!db.objectStoreNames.contains("files")) db.createObjectStore("files");
         };
         rq.onsuccess = function () { resolve(rq.result); };
         rq.onerror = function () { reject(rq.error); };
      });
      return dbp;
   };
   var idbDo = function (store, mode, fn) {
      return idb().then(function (db) {
         return $q(function (resolve, reject) {
            var tx = db.transaction(store, mode), rq = fn(tx.objectStore(store));
            tx.oncomplete = function () { resolve(rq ? rq.result : undefined); };
            tx.onerror = tx.onabort = function () { reject(tx.error); };
         });
      });
   };

   // --------------------------------------------------------------- backends
   var split = function (path) { return String(path).split("/").filter(function (s) { return s; }); };
   var folderBackend = function (root) {
      var dirOf = function (parts, create) {
         var d = $q.when(root);
         parts.forEach(function (p) { d = d.then(function (h) { return h.getDirectoryHandle(p, { create: create }); }); });
         return d;
      };
      var fileOf = function (path, create) {
         var parts = split(path), name = parts.pop();
         return dirOf(parts, create).then(function (d) { return d.getFileHandle(name, { create: create }); });
      };
      return {
         read: function (path) {
            return fileOf(path, false).then(function (h) { return h.getFile(); }).then(function (f) { return f.text(); }, function (e) {
               if (e && e.name === "NotFoundError") return null;
               return $q.reject(e);
            });
         },
         // createWritable writes a swap file and renames it on close: a crash leaves the old file
         write: function (path, text) {
            return fileOf(path, true).then(function (h) { return h.createWritable(); }).then(function (w) {
               return $q.when(w.write(text)).then(function () { return w.close(); });
            });
         },
         append: function (path, text) {
            return fileOf(path, true).then(function (h) {
               return $q.all([h.getFile(), h.createWritable({ keepExistingData: true })]);
            }).then(function (x) {
               var w = x[1];
               return $q.when(w.seek(x[0].size)).then(function () { return w.write(text); }).then(function () { return w.close(); });
            });
         },
         remove: function (path) {
            var parts = split(path), name = parts.pop();
            return dirOf(parts, false).then(function (d) { return d.removeEntry(name); }).catch(function () { });
         },
         list: function (dir) {
            return dirOf(split(dir), false).then(function (d) {
               var it = d.keys(), out = [];
               var next = function () {
                  return $q.when(it.next()).then(function (r) { if (r.done) return out; out.push(r.value); return next(); });
               };
               return next();
            }, function () { return []; });
         }
      };
   };
   var browserBackend = function (id) {
      var key = function (path) { return id + "|" + split(path).join("/"); };
      var self = {
         read: function (path) { return idbDo("files", "readonly", function (s) { return s.get(key(path)); }).then(function (v) { return v === undefined ? null : v; }); },
         write: function (path, text) { return idbDo("files", "readwrite", function (s) { return s.put(String(text), key(path)); }); },
         append: function (path, text) { return self.read(path).then(function (v) { return self.write(path, (v || "") + text); }); },
         remove: function (path) { return idbDo("files", "readwrite", function (s) { return s.delete(key(path)); }); },
         list: function (dir) {
            var prefix = key(dir) + "/";
            return idbDo("files", "readonly", function (s) { return s.getAllKeys(); }).then(function (keys) {
               return (keys || []).filter(function (k) { return k.indexOf(prefix) === 0 && k.slice(prefix.length).indexOf("/") < 0; })
                  .map(function (k) { return k.slice(prefix.length); });
            });
         },
         all: function () {
            var prefix = id + "|";
            return idbDo("files", "readonly", function (s) { return s.getAllKeys(); }).then(function (keys) {
               var out = {}, chain = $q.when();
               (keys || []).filter(function (k) { return k.indexOf(prefix) === 0; }).forEach(function (k) {
                  chain = chain.then(function () { return idbDo("files", "readonly", function (s) { return s.get(k); }).then(function (v) { out[k.slice(prefix.length)] = v; }); });
               });
               return chain.then(function () { return out; });
            });
         }
      };
      return self;
   };

   // ----------------------------------------------------------------- state
   api.supported = function () { return !!(window.isSecureContext && window.showDirectoryPicker); };
   var notify = function () { $rootScope.$broadcast("tm1-readiness-project", api.current); };
   var setStatus = function (status, error) {
      if (!api.current) return;
      var blocked = function (s) { return s === "perm" || s === "missing"; }, was = api.current.status;
      api.current.status = status;
      if (blocked(was) !== blocked(status)) notify();

      api.current.error = error || null;
      if (status === "saved") api.current.savedAt = new Date();
   };
   var failed = function (e) {
      var n = e && e.name;
      setStatus(n === "NotFoundError" ? "missing" : n === "NotAllowedError" || n === "SecurityError" ? "perm" : "error", String(e && e.message || e));
      return $q.reject(e);
   };

   /* Writes are queued: an append to log.jsonl and a rewrite of project.json
    * must not interleave on the same file. */
   var queue = $q.when();
   var io = function (fn) {
      var c = api.current;
      if (!c || !c.backend) return $q.reject(new Error("No project is open"));
      if (c.status === "perm" || c.status === "missing") return $q.reject(new Error(c.status));
      // a write goes to the project it was queued for, even if that one closed meanwhile (a log flush on close)
      var p = queue.then(function () {
         if (api.current === c) setStatus("saving");
         return fn(c.backend);
      }).then(function (v) { if (api.current === c) setStatus("saved"); return v; }, function (e) { return api.current === c ? failed(e) : $q.reject(e); });
      queue = p.catch(function () { });
      return p;
   };
   // resolves once every queued write has landed
   api.idle = function () { return queue; };
   api.isOpen = function () { return !!(api.current && api.current.project && api.current.backend); };
   api.canWrite = function () { return api.isOpen() && api.current.status !== "perm" && api.current.status !== "missing"; };
   api.read = function (path) { return api.isOpen() ? api.current.backend.read(path) : $q.when(null); };
   api.list = function (dir) { return api.isOpen() ? api.current.backend.list(dir) : $q.when([]); };
   api.write = function (path, text) { return io(function (b) { return b.write(path, text); }); };
   // a folder the utility will write into: it may not create one itself (a picked folder only; no-op in the browser)
   api.ensureDir = function (path) {
      if (!api.canWrite() || api.current.mode !== "folder") return $q.when(false);
      var h = api.current.handle, chain = $q.when(h);
      split(path).forEach(function (p) { chain = chain.then(function (d) { return d.getDirectoryHandle(p, { create: true }); }); });
      return chain.then(function () { return true; }, function () { return false; });
   };
   api.append = function (path, text) { return io(function (b) { return b.append(path, text); }); };
   api.remove = function (path) { return io(function (b) { return b.remove(path); }); };
   api.saveManifest = function () {
      if (!api.isOpen()) return $q.reject(new Error("No project is open"));
      var m = api.current.project;
      return api.write("project.json", JSON.stringify(m, null, 2)).then(function () { return remember(api.current); });
   };

   // ------------------------------------------------------------ recent list
   var remember = function (c) {
      var m = c.project;
      var row = { id: m.id, name: m.name, mode: c.mode, handle: c.handle || null, folder: c.folder || null, lastOpened: new Date().toISOString(), databases: m.databases };
      api.recent = core.recentProjects(api.recent, row, RECENT_KEEP);
      try { window.localStorage.setItem(CURRENT, m.id); } catch (e) { }
      return idbDo("projects", "readwrite", function (s) {
         s.clear();
         api.recent.forEach(function (r) { s.put(r); });
      }).catch(function () { });
   };
   api.forget = function (id) {
      api.recent = api.recent.filter(function (r) { return r.id !== id; });
      return idbDo("projects", "readwrite", function (s) { return s.delete(id); }).catch(function () { });
   };

   // ------------------------------------------------------------------ locks
   var release = null, heldId = null;
   var unlock = function () { if (release) release(); release = null; heldId = null; };
   var lock = function (id) {
      // the same project again (Allow access, Find the folder): the lock is already ours
      if (heldId === id) return $q.when(true);
      unlock();
      if (!navigator.locks) return $q.when(true);
      return $q(function (resolve) {
         navigator.locks.request("tm1Readiness.project." + id, { ifAvailable: true }, function (l) {
            if (!l) { resolve(false); return null; }
            heldId = id;
            resolve(true);
            return new Promise(function (r) { release = r; });
         });
      });
   };

   // ------------------------------------------------------------- open/close
   var uid = function () {
      var r = window.crypto && window.crypto.getRandomValues ? window.crypto.getRandomValues(new Uint32Array(2)) : [Math.random() * 4294967296, Date.now()];
      return "p" + Date.now().toString(36) + (r[0] >>> 0).toString(36) + (r[1] >>> 0).toString(36);
   };
   var attach = function (m, mode, handle) {
      return lock(m.id).then(function (got) {
         if (!got) return $q.reject({ code: "locked" });
         api.current = { project: m, mode: mode, handle: handle || null, folder: handle ? handle.name : null,
            backend: mode === "folder" ? folderBackend(handle) : browserBackend(m.id), status: "saved", savedAt: null, error: null };
         return remember(api.current).then(function () { notify(); return api.current; });
      });
   };

   /* The picker, inside the click that asked for it. Resolves with the folder
    * and what is already in it, so the page can say "this is a project" or
    * "this is the plugin's own folder" before anything is written. */
   api.pickFolder = function () {
      return $q.when(window.showDirectoryPicker({ id: "tm1Readiness", mode: "readwrite" })).then(function (handle) {
         var b = folderBackend(handle);
         return $q.all([b.list(""), b.read("project.json")]).then(function (x) {
            return { handle: handle, name: handle.name, names: x[0], projectText: x[1] };
         });
      });
   };

   api.create = function (o) {
      var m = core.newProject({ id: uid(), name: o.name, v11: o.v11, v12: o.v12 });
      return attach(m, o.handle ? "folder" : "browser", o.handle).then(function () {
         return api.saveManifest();
      }).then(function () { return api.current; });
   };

   var openText = function (text, mode, handle) {
      var r = core.readProject(text);
      if (r.error) return $q.reject({ code: r.error, version: r.version });
      return attach(r.project, mode, handle);
   };
   api.openPicked = function (picked) {
      if (picked.projectText === null) return $q.reject({ code: "notproject" });
      return openText(picked.projectText, "folder", picked.handle);
   };

   /* A remembered folder: the permission request must run inside the click,
    * which is why the handle is already in memory (no await before it). */
   api.openRecent = function (row) {
      if (row.mode === "browser") {
         return browserBackend(row.id).read("project.json").then(function (text) {
            if (text === null) return $q.reject({ code: "missing" });
            return openText(text, "browser", null);
         });
      }
      var h = row.handle;
      return $q.when(h.requestPermission({ mode: "readwrite" })).then(function (p) {
         if (p !== "granted") return $q.reject({ code: "denied" });
         return folderBackend(h).read("project.json");
      }).then(function (text) {
         if (text === null) return $q.reject({ code: "notproject" });
         return openText(text, "folder", h);
      }, function (e) { return $q.reject(e && e.code ? e : { code: e && e.name === "NotFoundError" ? "missing" : "error", message: String(e && e.message || e) }); });
   };

   // the bundle file: a project kept in this browser, from a download
   api.importBundle = function (text) {
      var r = core.readProjectBundle(text);
      if (r.error) return $q.reject({ code: r.error, version: r.version });
      var b = browserBackend(r.project.id), chain = $q.when();
      Object.keys(r.files).forEach(function (p) { chain = chain.then(function () { return b.write(p, r.files[p]); }); });
      return chain.then(function () { return attach(r.project, "browser", null); }).then(function () { return api.saveManifest(); });
   };
   api.bundle = function () {
      if (!api.isOpen()) return $q.reject(new Error("No project is open"));
      var c = api.current;
      var out = {};
      // a name that will not read as a file is a folder: walk into it
      var walk = function (dir) {
         return c.backend.list(dir).then(function (names) {
            var chain = $q.when();
            names.forEach(function (n) {
               var p = dir ? dir + "/" + n : n;
               chain = chain.then(function () {
                  return c.backend.read(p).then(function (v) { if (v !== null) out[p] = v; }, function () { return walk(p); });
               });
            });
            return chain;
         });
      };
      var files = c.mode === "browser" ? c.backend.all() : walk("").then(function () { return out; });
      return files.then(function (f) { delete f["project.json"]; return core.projectBundle(c.project, f); });
   };

   api.close = function () {
      unlock();
      api.current = null;
      try { window.localStorage.removeItem(CURRENT); } catch (e) { }
      notify();
   };

   /* A new session: the project that was open comes back, but a folder needs a
    * click to be allowed again. Until then the status is "perm" and nothing is
    * written; the page keeps working as without a project. */
   api.reconnect = function () {
      var c = api.current;
      if (!c || !c.handle) return $q.when();
      return api.openRecent({ id: c.project ? c.project.id : c.id, mode: "folder", handle: c.handle });
   };

   api.ready = idbDo("projects", "readonly", function (s) { return s.getAll(); }).then(function (rows) {
      api.recent = (rows || []).sort(function (a, b) { return a.lastOpened < b.lastOpened ? 1 : -1; });
      var id = null;
      try { id = window.localStorage.getItem(CURRENT); } catch (e) { }
      var row = id && api.recent.filter(function (r) { return r.id === id; })[0];
      if (!row) return;
      if (row.mode === "browser") return api.openRecent(row).catch(function () { });
      return $q.when(row.handle.queryPermission({ mode: "readwrite" })).then(function (p) {
         if (p === "granted") return api.openRecent(row).catch(function () { });
         // shown, not yet usable: the page offers "Allow access to the folder again"
         api.current = { project: null, id: row.id, name: row.name, mode: "folder", handle: row.handle, folder: row.folder, backend: null, status: "perm", savedAt: null, error: null };
         notify();
      });
   }).catch(function () { api.recent = []; });

   return api;
}]);

["Process", "Cube", "Dimension"].forEach(function (type) {
   arc.service("tm1ReadinessWhereUsed" + type, ['$state', 'tm1ReadinessRequest', function ($state, request) {
      // Arc calls execute(instance, name, branch); `name` is the clicked object
      this.execute = function (instance, name) {
         request.set({ instance: instance, whereUsed: { type: type, name: name } });
         $state.go("tm1Readiness", { instance: instance });
      };
   }]);
});

arc.factory("saasMigrationCore", [function () {

   var VERSION = "1.0.2";

   // ---------------------------------------------------------------------------
   // Rule catalogue
   // ---------------------------------------------------------------------------

   /* TI functions TM1 v12 does not have.
    *
    * `v12` is what the v12 compiler said, measured by dry-running
    * `POST /CompileProcess` on a 12.6.4 database with each name in a statement
    * (PROJECT-PLAN §2.4): "unknown" means the compiler rejected the name. The
    * migration utility still carries such a process over -- it reports it among
    * the "Objects processed with problems" -- but it does not compile or run on
    * TM1 12 (user's own migration run, and the utility's README, §2.9). Names whose v12 status is "accepted" are not in this table even when
    * an IBM list calls them unsupported -- the compiler is the authority on what
    * a process may contain; see the REVIEW table below for those. */
   var REMOVED_TI = [
      // [name, fix kind, suggestion key]
      ["AddInfoCubeRestriction", "MANUAL", "sap"],
      ["AllowExternalRequests", "MANUAL", "none"],
      ["AssignClientPassword", "MANUAL", "identity"],
      ["AssociateCAMIDToGroup", "MANUAL", "identity"],
      ["BatchCellIncrement", "REMOVE", "parallel"],
      ["BatchUpdateFinish", "REMOVE", "parallel"],
      ["BatchUpdateFinishWait", "REMOVE", "parallel"],
      ["BatchUpdateStart", "REMOVE", "parallel"],
      ["CGAddPromptValues", "MANUAL", "cognos"],
      ["CGPromptGetNextMember", "MANUAL", "cognos"],
      ["CGPromptSize", "MANUAL", "cognos"],
      ["CreateHierarchyByAttribute", "MANUAL", "none"],
      ["CubeDataReservationAcquire", "MANUAL", "dr"],
      ["CubeDataReservationGet", "MANUAL", "dr"],
      ["CubeDataReservationGetConflicts", "MANUAL", "dr"],
      ["CubeDataReservationRelease", "MANUAL", "dr"],
      ["CubeDataReservationReleaseAll", "MANUAL", "dr"],
      ["CubeDRAcquire", "MANUAL", "dr"],
      ["CubeDRGet", "MANUAL", "dr"],
      ["CubeDRGetConflicts", "MANUAL", "dr"],
      ["CubeDRRelease", "MANUAL", "dr"],
      ["CubeDRReleaseAll", "MANUAL", "dr"],
      ["CubeGetLogChanges", "REMOVE", "logging"],
      ["CubeSaveData", "REMOVE", "persistence"],
      ["CubeSetConnParams", "MANUAL", "sap"],
      ["CubeSetLogChanges", "REMOVE", "logging"],
      ["CubeUnload", "REMOVE", "unload"],
      ["DisableBulkLoadMode", "REMOVE", "parallel"],
      ["EnableBatchCellIncrement", "REMOVE", "parallel"],
      ["EnableBulkLoadMode", "REMOVE", "parallel"],
      // on no IBM list; the 12.6.4 migration utility rejects it (GO_New_Stores migrate.log, plan §2.12)
      ["EnablePersonalWorkspace", "REMOVE", "personalWorkspace"],
      ["ExecuteCommand", "STUB", "command"],
      ["ExecuteJavaN", "MANUAL", "java"],
      ["ExecuteJavaS", "MANUAL", "java"],
      ["LockOff", "REMOVE", "lock"],
      ["LockOn", "REMOVE", "lock"],
      ["RefreshMDXHierarchy", "REMOVE", "mdxHierarchy"],
      ["RemoveCAMIDAssociation", "MANUAL", "identity"],
      ["RemoveCAMIDAssociationFromGroup", "MANUAL", "identity"],
      ["SaveDataAll", "REMOVE", "persistence"],
      ["ServerShutdown", "MANUAL", "shutdown"],
      ["SetChoreVerboseMessages", "REMOVE", "none"],
      ["SetOdbcUnicodeInterface", "REMOVE", "odbc"],
      ["SwapAliasWithPrincipalName", "MANUAL", "localization"],
      ["SubsetFormatStyleSet", "REMOVE", "none"],
      // IBM's v12.4 status list; every one measured unknown to the 12.6.4 compiler
      ["CognosDimension", "MANUAL", "cognos"],
      ["CognosPackage", "MANUAL", "cognos"],
      ["CognosQuery", "MANUAL", "cognos"],
      ["CreateMultiHierarchyTestCubes", "MANUAL", "none"],
      ["CubeSetIsVirtual", "MANUAL", "none"],
      ["CubeSetSAPVariablesClause", "MANUAL", "sap"],
      ["CubeSetSlicerMembers", "MANUAL", "none"],
      ["DataSourceAddSAPHierarchy", "MANUAL", "sap"],
      ["DataSourceDeleteAllSAPHierarchies", "MANUAL", "sap"],
      ["DeleteAllInfoCubeRestrictions", "MANUAL", "sap"],
      ["NWSAPCharacteristic", "MANUAL", "sap"],
      ["NWSAPInfoCube", "MANUAL", "sap"],
      ["ODBOCube", "MANUAL", "odbo"],
      ["ODBODimension", "MANUAL", "odbo"],
      ["ODBOMDXQuery", "MANUAL", "odbo"],
      ["SAPAttributes", "MANUAL", "sap"],
      ["SAPCharacteristic", "MANUAL", "sap"],
      ["SAPCharacteristicTexts", "MANUAL", "sap"],
      ["SAPCurrency", "MANUAL", "sap"],
      ["SAPHierarchy", "MANUAL", "sap"],
      ["SAPInfoCube", "MANUAL", "sap"],
      ["SAPODSInsert", "MANUAL", "sap"],
      ["SAPOpen", "MANUAL", "sap"],
      ["SAPSecurity", "MANUAL", "sap"],
      ["SAPTable", "MANUAL", "sap"],
      ["SetCharacteristicAttributes", "MANUAL", "sap"],
      ["SetCharacteristicHierarchies", "MANUAL", "sap"],
      ["SetInfoCubeCharacteristics", "MANUAL", "sap"],
      ["SetInfoCubeKeyFigures", "MANUAL", "sap"],
      ["SetRoleAuthorizationColumns", "MANUAL", "sap"],
      // not a TM1 function at all (unknown to both compilers); the real name is SecurityRefresh
      ["RefreshSecurity", "REWRITE", "securityRefresh"]
   ];

   var SUGGESTIONS = {
      logging: "Transaction logging is managed by the platform in TM1 v12. Remove the call. " +
         "In v11 this means the process no longer switches logging off during a load, so it logs more and may load more slowly until cutover.",
      persistence: "Persistence is managed by the engine in TM1 v12. Remove the call. " +
         "In v11 the data is then saved at the next scheduled save rather than at the end of this process. " +
         "If the save was used as a synchronisation point, redesign it with RunProcess + WaitForAllJobs after cutover.",
      unload: "CubeUnload was removed in 12.5 and every call fails. Remove the call.",
      parallel: "Bulk load mode and batch updates are obsolete in TM1 v12 (Parallel Interaction). Remove the call; " +
         "after cutover, parallelise with RunProcess.",
      lock: "LockOn/LockOff do not exist in TM1 v12. Remove the call; if serialisation was the intent, use Synchronized() after cutover.",
      odbc: "ODBC goes through the ODBC Data Connector (ODBCIS) in TM1 v12; the unicode switch has no equivalent. Remove the call.",
      command: "ExecuteCommand does not exist in TM1 v12. Replace it with ExecuteHttpRequest calling an external service " +
         "(Azure Function, AWS Lambda, container) that does the work. The stub below is commented out: complete it after cutover, " +
         "because ExecuteHttpRequest does not exist in v11.",
      java: "Java TI is not available in TM1 v12. Rebuild this logic outside TM1 and call it with ExecuteHttpRequest after cutover.",
      cognos: "Cognos package data sources are not supported in TM1 v12. Replace the data source.",
      identity: "Identity is managed by the identity provider in TM1 v12 (IBMid / OIDC). Remove the password and CAM handling; " +
         "manage access in the IdP and with groups.",
      dr: "Data Reservation is not available in TM1 v12. Redesign with PAW workflow or application design.",
      sap: "SAP / InfoCube data-source functions are not available in TM1 v12. Replace the data source.",
      odbo: "ODBO data-source functions are not available in TM1 v12. Replace the data source (ODBC through the ODBC Data Connector, or a file).",
      shutdown: "The database lifecycle belongs to the platform in TM1 v12. Remove the call and check what depended on the shutdown.",
      localization: "SwapAliasWithPrincipalName has no replacement; IBM's direction is localization (translated captions).",
      securityRefresh: "RefreshSecurity is not a TM1 function; the documented and compiled name is SecurityRefresh.",
      mdxHierarchy: "RefreshMDXHierarchy does not exist in TM1 v12 and IBM documents no replacement. Remove the call, and check the MDX that uses this hierarchy after migration. " +
         "In v11 the MDX hierarchy metadata is then refreshed when TM1 next refreshes it rather than here.",
      personalWorkspace: "EnablePersonalWorkspace is unknown to the TM1 v12 compiler: the migration utility reports it as an unknown function. " +
         "Personal workspaces belong to TM1 Applications, which TM1 v12 does not have. Remove the call.",
      none: "Not available in TM1 v12. Remove the call or redesign the logic."
   };

   /* Names an IBM list calls unsupported but the 12.6.4 compiler accepts
    * (§2.4). They do not stop the migration, so they are REVIEW, not BLOCKER. */
   var REVIEW_TI = {
      returnsqltablehandle: "On IBM's v12.4 list of unsupported functions, but the 12.6.4 compiler accepts it, so the process migrates. Test it on TM1 v12.",
      returncsvtablehandle: "On IBM's v12.4 list of unsupported functions, but the 12.6.4 compiler accepts it, so the process migrates. Test it on TM1 v12.",
      encodepassword: "Accepted by the 12.6.4 compiler but undocumented by IBM. Passwords have no place in a SaaS process; review the logic.",
      odbcopenex: "No TM1 v12 note in IBM's docs; the compiler accepts it. ODBC sources must go through the ODBC Data Connector (ODBCIS).",
      ruleloadfromfileex: "Documented by IBM for TM1 v12 but unknown to both the v11.8 and the 12.6.4 compilers. Use RuleLoadFromFile, or PATCH the rules over REST."
   };

   /* Control objects TM1 v12 does not support. A reference to one from
    * TI, rules or MDX BREAKS after migration. Presence on a v12 database proves
    * nothing: a 12.6.4 database still carries }Capabilities and
    * }ClientCAMAssociatedGroups (§2.4) and IBM says both have no effect. */
   var REMOVED_CONTROL = [
      ["}ApplicationSecurity", "Websheets and files move to the content area with no group security."],
      ["}Capabilities", "No effect in TM1 v12; delete it after migration."],
      ["}ClientCAMAssociatedGroups", "CAM is not used in TM1 v12."],
      ["}ClientProperties", "Not in TM1 v12. Used on v11 only, to prepare CloudID before migration."],
      ["}ClientSettings", "Not supported in TM1 v12."],
      ["}ConnectionProperties", "Not supported in TM1 v12."],
      ["}CubeProperties", "The cube does not exist in TM1 v12 (measured). Its settings become REST cube properties: ViewStorageMaxMemory (VMM), ViewStorageMinTime (VMT), CalculationThresholdForStorage, AllowPersistentHolds, Locked, MeasuresDimension, TimeDimension -- set them once on the cube after migration."],
      ["}CubeSecurityProperties", "CellSecurityDefaultValue and CellSecurityMostRestrictive become cube properties."],
      ["}DimensionProperties", "AllLeavesHierarchyName, Locked and DefaultHierarchy become dimension properties."],
      ["}HierarchyProperties", "Not supported in TM1 v12."],
      ["}StatsByChore", "Use the Metrics() endpoint."],
      ["}StatsByClient", "Use the Metrics() endpoint."],
      ["}StatsByCube", "Use the Metrics() endpoint."],
      ["}StatsByCubeByClient", "Use the Metrics() endpoint."],
      ["}StatsByProcess", "Use the Metrics() endpoint."],
      ["}StatsForServer", "Use the Metrics() endpoint."],
      ["}ApplicationsEntries", "Control dimension removed in TM1 v12."]
   ];

   /* Writes to these can be commented out: the object has no TM1 v12
    * replacement, and a CellPut into a cube that does not exist fails the
    * process at run time. The others (}CubeProperties and friends) carry
    * settings that move to REST properties, so they stay MANUAL. */
   // }cubeproperties: 404 on TM1 12 (plan §2.13), so a write fails at run time; the user chose
   // to comment the writes out and set the REST cube property instead (2026-10-03)
   var CONTROL_REMOVABLE = ["}hierarchyproperties", "}clientsettings", "}connectionproperties", "}capabilities",
      "}clientcamassociatedgroups", "}applicationsecurity", "}cubeproperties"];
   var CELL_WRITES = ["cellputs", "cellputn", "cellincrementn", "cellputproportionalspread"];

   var FILE_FUNCTIONS = ["asciioutput", "textoutput", "asciidelete", "asciiappendoutput", "asciioutputopen",
      "fileexists", "wildcardfilesearch", "setoutputescapedoublequote", "ruleloadfromfile", "ruleloadfromfileex"];

   var MDX_REMOVED = [
      ["ANCESTORSALL", "Not supported in TM1 v12."],
      ["TM1ROLLUP", "Not supported in TM1 v12."],
      ["TM1SUBSETBASIS", "Not supported in TM1 v12."],
      ["TM1TUPLESIZE", "Not supported in TM1 v12."]
   ];

   var INVALID_NAME_CHARS = /[\\\/:*?"<>|';,]/;

   var removedByName = {};
   REMOVED_TI.forEach(function (row) {
      removedByName[row[0].toLowerCase()] = { name: row[0], fix: row[1], suggestion: SUGGESTIONS[row[2]] };
   });
   var controlByName = {};
   REMOVED_CONTROL.forEach(function (row) { controlByName[row[0].toLowerCase()] = { name: row[0], note: row[1] }; });

   // ---------------------------------------------------------------------------
   // TI tokenizer
   // ---------------------------------------------------------------------------

   /* Splits one procedure into statements and comment lines.
    *
    * A TI comment is a line whose first non-blank character is `#`. A
    * statement runs to the first `;` outside a single-quoted string, and may
    * span lines. Strings escape a quote by doubling it. Everything downstream
    * matches tokens, never raw text, because the raw text of a real process
    * carries removed function names inside comments and strings. */
   function tokenize(code) {
      var text = code || "";
      var out = [];
      var i = 0, line = 1, n = text.length;
      while (i < n) {
         // skip blank space between statements, counting lines
         var c = text.charAt(i);
         if (c === "\n") { line++; i++; continue; }
         if (c === " " || c === "\t" || c === "\r") { i++; continue; }
         var start = i, startLine = line;
         if (c === "#" && atLineStart(text, i)) {
            var eol = text.indexOf("\n", i);
            if (eol < 0) eol = n;
            out.push({ type: "comment", start: start, end: eol, line: startLine, endLine: startLine, text: text.substring(start, eol) });
            i = eol;
            continue;
         }
         var inString = false, terminated = false;
         while (i < n) {
            var ch = text.charAt(i);
            if (ch === "\n") line++;
            if (inString) {
               if (ch === "'") {
                  if (text.charAt(i + 1) === "'") { i += 2; continue; }
                  inString = false;
               }
               i++;
               continue;
            }
            if (ch === "'") { inString = true; i++; continue; }
            // a comment line in the middle of an unterminated statement belongs to the comment, not the statement
            if (ch === "#" && atLineStart(text, i)) break;
            if (ch === ";") { i++; terminated = true; break; }
            i++;
         }
         var endLine = line;
         var raw = text.substring(start, i);
         // do not count a trailing newline swallowed by a comment break
         out.push({ type: "statement", start: start, end: i, line: startLine, endLine: endLine, text: raw, terminated: terminated });
      }
      out.forEach(function (tok) {
         if (tok.type === "statement") analyse(tok);
      });
      markBlocks(out);
      return out;
   }

   function atLineStart(text, i) {
      var j = i - 1;
      while (j >= 0) {
         var c = text.charAt(j);
         if (c === "\n") return true;
         if (c !== " " && c !== "\t" && c !== "\r") return false;
         j--;
      }
      return true;
   }

   /* The text of a statement with string literals blanked out, so that names
    * inside strings are never taken for calls or variables. Literal contents
    * are kept separately for the checks that want them (paths, cube names). */
   function stripStrings(s) {
      var out = "", literals = [], i = 0, n = s.length;
      while (i < n) {
         var c = s.charAt(i);
         if (c === "'") {
            var j = i + 1, lit = "";
            while (j < n) {
               if (s.charAt(j) === "'") {
                  if (s.charAt(j + 1) === "'") { lit += "'"; j += 2; continue; }
                  break;
               }
               lit += s.charAt(j);
               j++;
            }
            literals.push(lit);
            out += "'" + repeat(" ", j - i - 1) + "'";
            i = j + 1;
            continue;
         }
         out += c;
         i++;
      }
      return { code: out, literals: literals };
   }

   function repeat(ch, k) { var s = ""; while (k-- > 0) s += ch; return s; }

   var KEYWORDS = { "if": 1, "elseif": 1, "else": 1, "endif": 1, "while": 1, "end": 1, "break": 1, "and": 1, "or": 1, "not": 1 };

   /* Fills in, for one statement: the calls it makes (in order, with their
    * literal first argument where there is one), the variable it assigns, the
    * variables it reads, and whether it opens or closes a block. */
   function analyse(tok) {
      var stripped = stripStrings(tok.text);
      var code = stripped.code;
      tok.literals = stripped.literals;
      var body = code.replace(/;\s*$/, "");
      var trimmed = body.replace(/^\s+|\s+$/g, "");
      tok.calls = [];
      tok.reads = [];
      tok.assigns = null;
      tok.keyword = null;

      var kw = /^([A-Za-z]+)\b/.exec(trimmed);
      if (kw && KEYWORDS[kw[1].toLowerCase()] && ["if", "elseif", "else", "endif", "while", "end"].indexOf(kw[1].toLowerCase()) >= 0) {
         tok.keyword = kw[1].toLowerCase();
      }
      var assign = /^([A-Za-z_][A-Za-z0-9_.$]*)\s*=(?!=)/.exec(trimmed);
      var rhs = trimmed;
      if (assign && !tok.keyword) {
         tok.assigns = assign[1].toLowerCase();
         rhs = trimmed.substring(assign[0].length);
      }
      // identifiers followed by `(` are calls; any other identifier is a read
      var re = /([A-Za-z_][A-Za-z0-9_.$]*)(\s*\()?/g, m;
      var seen = {};
      while ((m = re.exec(rhs)) !== null) {
         var name = m[1], lower = name.toLowerCase();
         if (/^[0-9]/.test(name)) continue;
         if (m[2]) {
            tok.calls.push({ name: name, lower: lower, index: m.index, firstLiteral: firstLiteralAfter(rhs, stripped, m.index + m[0].length) });
         } else if (!KEYWORDS[lower]) {
            // a statement that is nothing but a bare name is a zero-argument call (`SaveDataAll;`, §2.1.5)
            if (!tok.assigns && trimmed.toLowerCase() === lower) {
               tok.calls.push({ name: name, lower: lower, index: m.index, firstLiteral: null, bare: true });
            } else if (!seen[lower]) {
               seen[lower] = 1;
               tok.reads.push(lower);
            }
         }
      }
   }

   /* The literal that is the first argument of the call whose `(` ends at
    * `pos`, or null when that argument is not a plain string literal. */
   function firstLiteralAfter(rhs, stripped, pos) {
      var rest = rhs.substring(pos);
      var m = /^\s*'/.exec(rest);
      if (!m) return null;
      // count the literals that occur before this position in the whole statement
      var before = rhs.substring(0, pos + m[0].length - 1);
      var k = (before.match(/'[^']*'/g) || []).length;
      var lit = stripped.literals[k];
      // the argument must be the literal alone (not 'a' | vX)
      var close = rest.indexOf("'", m[0].length);
      var after = close >= 0 ? rest.substring(close + 1) : "";
      if (!/^\s*[,)]/.test(after)) return null;
      return lit === undefined ? null : lit;
   }

   function markBlocks(tokens) {
      var depth = 0;
      tokens.forEach(function (tok) {
         if (tok.type !== "statement") { tok.depth = depth; return; }
         if (tok.keyword === "endif" || tok.keyword === "end") depth = Math.max(0, depth - 1);
         tok.depth = (tok.keyword === "else" || tok.keyword === "elseif") ? Math.max(0, depth - 1) : depth;
         if (tok.keyword === "if" || tok.keyword === "while") depth++;
      });
   }

   // ---------------------------------------------------------------------------
   // Process scanning
   // ---------------------------------------------------------------------------

   var PROCEDURES = ["PrologProcedure", "MetadataProcedure", "DataProcedure", "EpilogProcedure"];
   var PROCEDURE_LABEL = { PrologProcedure: "Prolog", MetadataProcedure: "Metadata", DataProcedure: "Data", EpilogProcedure: "Epilog" };

   function isTM1Applications(name) { return /^\}tp_/i.test(name || ""); }

   /* All findings for one process. `process` is the REST shape
    * (`GET /Processes?$select=Name,PrologProcedure,...,DataSource`). */
   function scanProcess(process, options) {
      var onV12 = !!(options && options.v12);
      var findings = [];
      var name = process.Name;
      PROCEDURES.forEach(function (proc) {
         var tokens = tokenize(process[proc] || "");
         tokens.forEach(function (tok) {
            if (tok.type !== "statement") return;
            tok.calls.forEach(function (call) {
               var removed = removedByName[call.lower];
               if (removed) {
                  findings.push(finding("ti.removed", "BLOCKER", "Process", name, proc, tok, {
                     function: removed.name, fix: removed.fix, suggestion: removed.suggestion
                  }));
               } else if (REVIEW_TI[call.lower]) {
                  findings.push(finding("ti.review", "REVIEW", "Process", name, proc, tok, {
                     function: call.name, fix: "MANUAL", suggestion: REVIEW_TI[call.lower]
                  }));
               }
               if (FILE_FUNCTIONS.indexOf(call.lower) >= 0 && call.firstLiteral !== null) {
                  var p = pathProblem(call.firstLiteral);
                  if (p) findings.push(finding("ti.path", "BREAKS", "Process", name, proc, tok, {
                     function: call.name, path: call.firstLiteral, fix: "MANUAL", suggestion: p
                  }));
               }
               if ((call.lower === "executeprocess" || call.lower === "runprocess") && call.firstLiteral === null) {
                  findings.push(finding("ti.dynamicTarget", "INFO", "Process", name, proc, tok, {
                     function: call.name, fix: "MANUAL",
                     suggestion: "The target process name is computed, so the dependency check cannot follow it."
                  }));
               }
            });
            // DatasourceNameForServer = '...';
            if (tok.assigns === "datasourcenameforserver" && tok.literals.length === 1) {
               var q = pathProblem(tok.literals[0]);
               if (q) findings.push(finding("ti.path", "BREAKS", "Process", name, proc, tok, {
                  function: "DatasourceNameForServer", path: tok.literals[0], fix: "MANUAL", suggestion: q
               }));
            }
            controlRefs(tok.literals).forEach(function (ctl) {
               var removable = isRemovableControlWrite(tok, ctl.name);
               findings.push(finding("control.removed", "BREAKS", "Process", name, proc, tok, {
                  referenced: ctl.name, fix: removable ? "REMOVE" : "MANUAL",
                  suggestion: ctl.note + (removable ? " The write fails at run time in TM1 v12: comment it out. In v11 the setting is then no longer written by this process." : "")
               }));
            });
            if (/\btm1user\b/i.test(stripStrings(tok.text).code) && /tm1user\s*(\(\s*\))?\s*@?=\s*'|'\s*@?=\s*tm1user/i.test(tok.text)) {
               findings.push(finding("ti.tm1user", "REVIEW", "Process", name, proc, tok, {
                  fix: "MANUAL",
                  suggestion: "Compares TM1User with a literal name. Client names change at migration (CloudID), so the literal must follow; prefer a group or attribute test."
               }));
            }
            var split = splitAcrossLines(tok.text);
            if (split) findings.push(finding("ti.splitName", "BLOCKER", "Process", name, proc, tok, {
               fix: "REWRITE", fixedStatement: split,
               suggestion: "A name is split across a line break, with no space on either side. v11 joins the lines of a statement with nothing between them, so it reads one name; " +
                  "TM1 v12 reads two and rejects the statement as a syntax error. Join the lines."
            }));
         });
      });
      var ds = process.DataSource || {};
      if (ds.dataSourceNameForServer && (ds.Type === "ASCII" || !ds.Type)) {
         var r = pathProblem(ds.dataSourceNameForServer);
         /* ON TM1 12 (user, 2026-10-06): nothing to change on v11 -- after the migration the Data
          * files tab uploads the file to TM1 12 and points the process at it (plan §2.13). Not when
          * the process sets its source in code: the tab cannot repoint that one (its setInCode rule),
          * so it stays MANUAL. The finding closes itself: a repointed path is relative, and
          * pathProblem has nothing to say about it on the TM1 12 scan. */
         var inCode = setsDataSourceInCode(process);
         if (r) findings.push({
            rule: "ti.dataSourcePath", severity: "BREAKS", objectType: "Process", object: name,
            procedure: "DataSource", line: null, statement: ds.dataSourceNameForServer,
            path: ds.dataSourceNameForServer, fix: inCode ? "MANUAL" : FIX_ON_TM1_12,
            // the general advice ("move the files...") would contradict "nothing to change", so ON TM1 12 says only why
            // on TM1 12 the same finding is to do now: the Data files tab is where, not later
            suggestion: inCode ? r + " The process sets its data source in code, so the Data files tab cannot repoint it: change the path in the code."
               : onV12 ? PATH_KIND_TEXT[pathKind(ds.dataSourceNameForServer)] + ", which TM1 v12 cannot read. To do now: the Data files tab uploads the file " +
                  "and points the process at it; the finding closes on the next scan."
               : PATH_KIND_TEXT[pathKind(ds.dataSourceNameForServer)] + ", which TM1 v12 cannot read. Nothing to change before the migration: " +
                  "on TM1 12 the Data files tab uploads the file and points the process at it (step 5)."
         });
      }
      if (ds.Type === "ODBC") {
         findings.push({
            rule: "ti.odbc", severity: "REVIEW", objectType: "Process", object: name, procedure: "DataSource",
            line: null, statement: ds.dataSourceNameForServer || "", fix: "MANUAL",
            suggestion: "ODBC sources go through the ODBC Data Connector (ODBCIS) in TM1 v12: install it near the data and point the source at its URL."
         });
      }
      findings.forEach(function (f) { f.tm1Applications = isTM1Applications(name); });
      return findings;
   }

   /* The statement with each line break that sits between two name
    * characters removed, or null when there is none. Measured on 11.8
    * (plan §2.12): `vC = vA` CRLF `B + 1;` compiles and reads vAB, while
    * `vC = vA B + 1;` is "Variable va is undefined"; the 12.6.4 migration
    * utility rejects the first as a syntax error (a }tp_ process of
    * GO_New_Stores). Only the measured shape: no space on either side, and
    * never inside a string literal (stripStrings keeps positions). */
   function splitAcrossLines(text) {
      var code = stripStrings(text).code, out = "", last = 0, found = false, re = /[A-Za-z0-9_$.](\r?\n)(?=[A-Za-z0-9_$.])/g, m;
      while ((m = re.exec(code))) {
         var at = m.index + 1;
         out += text.substring(last, at);
         last = at + m[1].length;
         found = true;
      }
      return found ? (out + text.substring(last)).replace(/^\s+|\s+$/g, "") : null;
   }

   function finding(rule, severity, objectType, object, procedure, tok, extra) {
      var f = {
         rule: rule, severity: severity, objectType: objectType, object: object,
         procedure: procedure, line: tok.line, endLine: tok.endLine, statement: tok.text.replace(/^\s+|\s+$/g, "")
      };
      for (var k in extra) if (extra.hasOwnProperty(k)) f[k] = extra[k];
      return f;
   }

   /* Why a TI file path will not work in TM1 v12, or null. TI file
    * access is confined to the database content area there, and the migration
    * utility ignores directories outside DatabaseDirectory -- the demo model's
    * own loaders read from `../sourcefiles/...` (§2.2). */
   var PATH_KIND_TEXT = { absolute: "An absolute path", unc: "A network (UNC) path", up: "A path that leaves the data directory (`..`)" };
   function pathKind(p) {
      // the same tests as pathProblem, in the same order
      if (/^[A-Za-z]:[\\\/]/.test(p)) return "absolute";
      if (/^\\\\/.test(p)) return "unc";
      return "up";
   }

   function pathProblem(p) {
      if (!p) return null;
      if (/^[A-Za-z]:[\\\/]/.test(p)) return "Absolute path. TM1 v12 confines TI files to the database content area: use a relative path and upload the file to the Files area.";
      if (/^\\\\/.test(p)) return "Network (UNC) path. TM1 v12 has no access to network shares: upload the file to the Files area, or fetch it with ExecuteHttpRequest.";
      if (/(^|[\\\/])\.\.([\\\/]|$)/.test(p)) return "Path leaves the data directory (`..`). The migration utility ignores directories outside DatabaseDirectory and TM1 v12 cannot reach them: move the files under the data directory.";
      return null;
   }

   function isRemovableControlWrite(tok, controlName) {
      if (CONTROL_REMOVABLE.indexOf(controlName.toLowerCase()) < 0) return false;
      return tok.calls.some(function (c) { return CELL_WRITES.indexOf(c.lower) >= 0; });
   }

   function controlRefs(literals) {
      var out = [];
      (literals || []).forEach(function (lit) {
         var c = controlByName[String(lit).toLowerCase()];
         if (c) out.push(c);
      });
      return out;
   }

   // ---------------------------------------------------------------------------
   // Rules scanning
   // ---------------------------------------------------------------------------

   /* Rules functions are identical in v11 and TM1 v12 (IBM), so a
    * rules scan looks only for removed control objects and TM1User literals. */
   function scanRules(cubeName, rules) {
      var findings = [];
      var lines = String(rules || "").split(/\r?\n/);
      lines.forEach(function (text, idx) {
         var t = text.replace(/^\s+/, "");
         if (t.charAt(0) === "#") return;
         var stripped = stripStrings(text);
         controlRefs(stripped.literals).forEach(function (ctl) {
            findings.push({
               rule: "control.removed", severity: "BREAKS", objectType: "Rules", object: cubeName, procedure: "Rules",
               line: idx + 1, statement: t, fix: "MANUAL", suggestion: ctl.note, referenced: ctl.name
            });
         });
      });
      return findings;
   }

   // ---------------------------------------------------------------------------
   // MDX scanning
   // ---------------------------------------------------------------------------

   function normName(s) { return String(s || "").replace(/\s+/g, "").toLowerCase(); }

   /* `ctx.attributes[dim]` and `ctx.subsets[dim]` are arrays of names. TM1
    * compares names without case and without spaces, and so does this. */
   /* `part`: "piece" is one literal of an MDX TI builds by joining strings
    * and variables, so the checks that need the whole expression (brackets,
    * a trailing semicolon) are skipped; "whole" is that joined expression, with
    * each variable as a placeholder, and only those checks run on it. */
   function scanMdx(objectType, objectName, dimension, mdx, ctx, part) {
      var findings = [];
      var text = String(mdx || "");
      var code = text.replace(/"[^"]*"/g, function (s) { return '"' + repeat(" ", s.length - 2) + '"'; });
      ctx = ctx || {};
      function add(rule, severity, fix, suggestion, extra) {
         var f = { rule: rule, severity: severity, objectType: objectType, object: objectName, procedure: "MDX", line: null,
            statement: text, fix: fix, suggestion: suggestion, dimension: dimension };
         for (var k in extra) if (extra.hasOwnProperty(k)) f[k] = extra[k];
         findings.push(f);
      }
      var structure = part !== "piece", references = part !== "whole";
      if (references) referenceChains(code).forEach(function (ch) {
         var parts = ch.parts;
         if (parts.length < 2) return;
         /* `[d].[e]` where e is in d's default hierarchy and in another one.
          * Measured 2026-10-01: v11 takes the default hierarchy; 12.6.4 rejects
          * the whole MDX ("Member name e is ambiguous"), also with `.Children`
          * after it. An element in one hierarchy only resolves on both, and
          * `[d].[d].[e]` is the default on both. So this is checked before the
          * "followed by ." rule below, and the rewrite keeps the v11 result. */
         if (parts.length === 2) {
            var others = otherHierarchiesWith(ctx, parts[0], parts[1]);
            if (others) {
               add("mdx.ambiguousMember", "BREAKS", "REWRITE",
                  "TM1 v12 finds " + parts[1] + " in more than one hierarchy of " + parts[0] + " (" + [parts[0]].concat(others).join(", ") +
                     ") and rejects the whole MDX (\"Member name " + parts[1] + " is ambiguous\"). In v11 it meant the default hierarchy: write [" +
                     parts[0] + "].[" + parts[0] + "].[" + parts[1] + "] for the same result on both.",
                  { match: ch.text, index: ch.index, replacement: "[" + parts[0] + "].[" + parts[0] + "].[" + parts[1] + "]", referenced: parts[1] });
               return;
            }
         }
         /* A chain followed by `.` is a member, a hierarchy or a level
          * (`[d].[h].Members`, `[d].[h].[e].Children`) -- never an attribute or
          * subset reference. Measured on 12.6.4: taking `[d].[h].Members` for an
          * attribute, where an attribute shares the hierarchy's name, turned a
          * working subset into a broken one (PROJECT-PLAN §2.5). */
         if (/^\s*\./.test(code.substring(ch.index + ch.text.length))) return;
         var dim = parts[0];
         var last = parts[parts.length - 1];
         // [d].[x] where x is one of d's hierarchies is a hierarchy, not a reference
         if (parts.length === 2) {
            var hiers = lookup(ctx.hierarchies, dim);
            if (normName(last) === normName(dim) || hiers && hiers.indexOf(normName(last)) >= 0) return;
         }
         var attrs = lookup(ctx.attributes, dim), subs = lookup(ctx.subsets, dim);
         if (attrs && attrs.indexOf(normName(last)) >= 0) {
            var type = attributeType(ctx, dim, last);
            add("mdx.attributeById", "BREAKS", "REWRITE", attributeSuggestion(ch.text, last, type),
               { match: ch.text, index: ch.index, replacement: attributeRewrite(parts, type), attributeType: type || null });
         } else if (subs && subs.indexOf(normName(last)) >= 0) {
            /* If an element has the same name, TM1 12 resolves the member and the
             * expression is fine. The element lists are too big to read for a
             * scan, so the directive checks each candidate with one request and
             * drops the finding when the element exists (`elementCheck`). */
            add("mdx.subsetById", "BREAKS", "REWRITE",
               "TM1 v12 no longer resolves a subset by identifier, and it says nothing: the set comes back empty. Use TM1SubsetToSet.",
               { match: ch.text, index: ch.index, replacement: subsetRewrite(parts),
                  elementCheck: { dimension: dim, hierarchy: parts.length > 2 ? parts[1] : dim, element: last } });
         }
      });
      /* ANCESTORSALL() as a function: 11.8 rejects it as a syntax error, so
       * the MDX already fails today (measured 2026-10-02, plan §2.11). The
       * member property `.AncestorsAll` is what v11 has; see below. TM1ROLLUP,
       * TM1TUPLESIZE and TM1SubsetBasis have rules of their own. */
      if (references && /\bANCESTORSALL\s*\(/i.test(code)) {
         add("mdx.removedFunction", "INFO", "MANUAL", "ANCESTORSALL() is not a function in v11 either (11.8 rejects it as a syntax error), so this MDX fails today already. " +
            "v11 has the member property [d].[h].[e].AncestorsAll instead.", { function: "ANCESTORSALL" });
      }
      if (references) removedFunctionRewrites(objectType, text, code, ctx).forEach(function (r) { add(r.rule, r.severity || "BREAKS", r.fix, r.suggestion, r.extra); });
      /* TM1SubsetBasis() is the element list Architect stored with a recorded
       * expression (the `270,` block of the .sub file). Measured 2026-10-02:
       * REST never shows it (Elements and TM1SubsetToSet give the evaluated
       * set), TI and REST cannot store one, and the migrated subsets on 12.6.4
       * hold none. One finding per call, each MANUAL until the page has read
       * the basis and checked the rewrite (`basisCheck`, resolveSubsetBasis). */
      if (references) {
         // each call, which Arc replaces with the list joined by "," -- the braces around it stay, as in Arc
         var bre = /\bTM1SUBSETBASIS\s*\(\s*\)/ig, bm;
         while ((bm = bre.exec(code)) !== null) {
            add("mdx.subsetBasis", "BREAKS", "MANUAL", basisSuggestion(objectType, null),
               { function: "TM1SUBSETBASIS", match: text.substr(bm.index, bm[0].length), index: bm.index, basisCheck: objectType === "Subset" });
         }
      }
      if (structure && /;\s*$/.test(code)) add("mdx.trailing", "BREAKS", "REWRITE", "TM1 v12 rejects anything after the end of the expression, including a trailing semicolon.", { replacement: text.replace(/;\s*$/, "") });
      if (references && /\bDIMENSION\s+PROPERTIES\b/i.test(code)) add("mdx.dimensionProperties", "BREAKS", "MANUAL", "DIMENSION PROPERTIES after a set expression is a syntax error in TM1 v12.", {});
      if (structure && !balanced(code)) add("mdx.unbalanced", "BREAKS", "MANUAL", "Unbalanced brackets or parentheses are a syntax error in TM1 v12.", {});
      if (references && /\bTM1IGNORE_BADTUPLES\b/i.test(code)) add("mdx.ignoreBadTuples", "INFO", "MANUAL", "TM1IGNORE_BADTUPLES is deprecated in 12.5 and ignored: bad tuples are ignored by default.", {});
      return findings;
   }

   // ---- MDX structure, on string-blanked code ----------------------------------

   /* Matching (), {} and [] positions. A `]]` inside a name is an escaped `]`. */
   function mdxStructure(code) {
      var pair = {}, bstart = {}, bend = {}, stack = [], i = 0;
      while (i < code.length) {
         var c = code.charAt(i);
         if (c === "[") {
            var j = i + 1;
            while (j < code.length) {
               if (code.charAt(j) === "]") { if (code.charAt(j + 1) === "]") { j += 2; continue; } break; }
               j++;
            }
            bstart[j] = i; bend[i] = j; i = j + 1; continue;
         }
         if (c === "(" || c === "{") stack.push(i);
         else if (c === ")" || c === "}") { var o = stack.pop(); if (o !== undefined) { pair[o] = i; pair[i] = o; } }
         i++;
      }
      return { pair: pair, bstart: bstart, bend: bend };
   }

   /* Where the expression that ends at `end` starts: a chain of `[name]`,
    * words, calls and `{…}` joined by dots, read backwards. */
   function exprStart(code, st, end) {
      var k = end - 1, start = end;
      for (;;) {
         while (k >= 0 && /\s/.test(code.charAt(k))) k--;
         if (k < 0) break;
         var c = code.charAt(k), s;
         if (c === "]" && st.bstart[k] !== undefined) s = st.bstart[k];
         else if ((c === ")" || c === "}") && st.pair[k] !== undefined) {
            s = st.pair[k];
            if (c === ")") {
               var w = s - 1;
               while (w >= 0 && /\s/.test(code.charAt(w))) w--;
               var e = w;
               while (w >= 0 && /\w/.test(code.charAt(w))) w--;
               if (w < e) s = w + 1;
            }
         } else if (/\w/.test(c)) { s = k; while (s > 0 && /\w/.test(code.charAt(s - 1))) s--; }
         else break;
         start = s; k = s - 1;
         while (k >= 0 && /\s/.test(code.charAt(k))) k--;
         if (k >= 0 && code.charAt(k) === ".") { k--; continue; }
         break;
      }
      return start;
   }

   /* The top-level arguments between an opening ( or { at `o` and its close. */
   function splitArgs(code, st, o) {
      var c = st.pair[o], args = [], from = o + 1, i = o + 1;
      if (c === undefined) return null;
      while (i < c) {
         var ch = code.charAt(i);
         if ((ch === "(" || ch === "{") && st.pair[i] !== undefined) { i = st.pair[i] + 1; continue; }
         if (ch === "[" && st.bend[i] !== undefined) { i = st.bend[i] + 1; continue; }
         if (ch === ",") { args.push({ start: from, end: i }); from = i + 1; }
         i++;
      }
      args.push({ start: from, end: c });
      return args;
   }

   /* The calls whose parentheses hold `idx`, innermost first. */
   function enclosingCalls(code, st, idx) {
      var out = [];
      Object.keys(st.pair).forEach(function (key) {
         var o = +key, c = st.pair[o];
         if (code.charAt(o) !== "(" || !(o < idx && idx < c)) return;
         var w = o - 1;
         while (w >= 0 && /\s/.test(code.charAt(w))) w--;
         var e = w + 1;
         while (w >= 0 && /\w/.test(code.charAt(w))) w--;
         out.push({ name: code.substring(w + 1, e).toUpperCase(), open: o, close: c, args: splitArgs(code, st, o) });
      });
      return out.sort(function (a, b) { return b.open - a.open; });
   }

   /* The one hierarchy an expression is on, from its names: `[d].[h].[e]`,
    * `[d].[e]` (the default hierarchy, unless [e] is one of d's hierarchies)
    * or a lone `[d]`. Null when it names more than one dimension, or none. */
   function hierarchyOf(code, ctx) {
      var chains = referenceChains(code), dims = {}, first = null;
      chains.forEach(function (ch) { dims[normName(ch.parts[0])] = true; if (!first) first = ch.parts; });
      if (!first) {
         var m = /\[((?:[^\]]|\]\])*)\]/.exec(code);
         if (!m) return null;
         first = [m[1].replace(/\]\]/g, "]")];
         dims[normName(first[0])] = true;
      }
      if (Object.keys(dims).length !== 1) return null;
      var d = first[0], h = d;
      if (first.length >= 3) h = first[1];
      else if (first.length === 2) {
         var hiers = lookup(ctx && ctx.hierarchies, d) || [];
         if (hiers.indexOf(normName(first[1])) >= 0) h = first[1];
      }
      return { dimension: d, hierarchy: h, unique: mdxName(d) + "." + mdxName(h) };
   }

   function mdxName(s) { return "[" + String(s).replace(/\]/g, "]]") + "]"; }

   /* A set, as opposed to a member: `{…}`, a call, `.Members` and friends, or
    * a named set of the query. `[d].[h].CurrentMember` is a hierarchy's own,
    * and fine on both versions. */
   function isSetExpr(x, namedSets) {
      var t = x.replace(/\s+/g, "");
      if (/[\})]$/.test(t)) return true;
      if (/\.(MEMBERS|ALLMEMBERS|CHILDREN|SIBLINGS)$/i.test(t)) return true;
      return !!namedSets[t.toLowerCase()];
   }

   /* The rewrites for the removed functions that have one (plan §2.11, each
    * measured against 11.8 and 12.6.4). `check` asks the page to run the
    * subset's MDX on v11 and the rewrite on the scanned database before it is
    * offered (verifyRewrites). Each entry: { rule, fix, suggestion, extra }. */
   function removedFunctionRewrites(objectType, text, code, ctx) {
      // a stored MDX view runs on its own like a subset, so its rewrite is checked the same way
      var out = [], st = null, inSubset = objectType === "Subset" || objectType === "View";
      var S = function () { return st || (st = mdxStructure(code)); };
      var named = {};
      code.replace(/\bSET\s+(\[(?:[^\]]|\]\])*\]|\w+)\s+AS\b/ig, function (all, n) { named[n.toLowerCase()] = true; return all; });
      var push = function (rule, fix, suggestion, extra) { out.push({ rule: rule, fix: fix, suggestion: suggestion, extra: extra }); };
      var rewriteOrShow = function (rule, suggestion, extra, inTi) {
         // in TI the statement cannot be run before it is offered, so it is shown
         if (!inSubset && inTi === "show") { push(rule, "MANUAL", suggestion + " Rewrite: " + extra.replacement, extra); return; }
         if (inSubset) extra.check = true;
         push(rule, "REWRITE", suggestion, extra);
      };

      /* `.Current` and `Set.CurrentMember`. Inside GENERATE or FILTER over the
       * same set, v11 gives the member being iterated (GENERATE(d.MEMBERS,
       * {d.MEMBERS.Current}) returns every member), which is
       * [d].[h].CurrentMember on both versions. IBM's `.Item(0)` is the first
       * member every time, so it is not offered. Outside an iteration nothing
       * is equal (v11 gave an empty set, or the 2nd member). */
      var cre = /\.\s*(CURRENT\b(?!\s*MEMBER)(?:\s*\.\s*ITEM\s*\(\s*0\s*\))?|CURRENTMEMBER\b)/ig, cm;
      while ((cm = cre.exec(code)) !== null) {
         var isMember = /^CURRENTMEMBER/i.test(cm[1]);
         var xs = exprStart(code, S(), cm.index), xcode = code.substring(xs, cm.index);
         if (!xcode.replace(/\s+/g, "")) continue;
         if (isMember && !isSetExpr(xcode, named)) continue;
         var label = isMember ? "Set.CurrentMember" : ".Current";
         var norm = xcode.replace(/\s+/g, "").toLowerCase(), iter = null;
         enclosingCalls(code, S(), cm.index).some(function (call) {
            if ((call.name !== "GENERATE" && call.name !== "FILTER") || !call.args || call.args.length < 2) return false;
            if (cm.index < call.args[1].start) return false;
            if (code.substring(call.args[0].start, call.args[0].end).replace(/\s+/g, "").toLowerCase() !== norm) return false;
            iter = call;
            return true;
         });
         var hier = null;
         if (iter) {
            var setCode = xcode;
            if (named[norm]) {
               var def = new RegExp("\\bSET\\s+" + norm.replace(/[\[\]\\^$.|?*+(){}]/g, "\\$&") + "\\s+AS\\s+", "i").exec(code);
               setCode = "";
               if (def) {
                  var rest = code.substring(def.index + def[0].length), stop = rest.search(/\b(SET|MEMBER|SELECT)\b/i);
                  setCode = stop < 0 ? rest : rest.substring(0, stop);
               }
            }
            hier = hierarchyOf(setCode, ctx);
         }
         var match = text.substring(xs, cm.index + cm[0].length);
         if (iter && hier) {
            push("mdx.current", "REWRITE", label + " is not supported in TM1 v12. Here it is the member " + iter.name + " is iterating over: v11 gives one per member. " +
               hier.unique + ".CurrentMember is that member on both versions. IBM's advice, .Item(0), would give the first member every time, which changes the result.",
               { match: match, index: xs, replacement: hier.unique + ".CurrentMember", function: label, check: inSubset });
         } else {
            push("mdx.current", "MANUAL", label + " is not supported in TM1 v12. " +
               (iter ? "It names more than one dimension, so there is no single CurrentMember for it. " : "It is not inside a GENERATE or FILTER over the same set, and there v11's result is not the first member: .Item(0), IBM's advice, is not the same. ") +
               "Inside an iteration, write [d].[h].CurrentMember; elsewhere, write the member that is meant.", { match: match, index: xs, function: label });
         }
      }

      /* `m.AncestorsAll`: every ancestor through every parent on v11. On 12.6.4
       * it is an empty set with no error, and an error inside INTERSECT.
       * Ancestors and IsAncestor follow one parent, so they are not equal. A
       * consolidation whose descendants hold m is an ancestor: the same set, in
       * dimension order. A member written with CurrentMember is left alone,
       * because the FILTER would rebind it. */
      var are = /\.\s*ANCESTORSALL\b(?!\s*\()/ig, am;
      while ((am = are.exec(code)) !== null) {
         var ms = exprStart(code, S(), am.index), mcode = code.substring(ms, am.index), mtext = text.substring(ms, am.index).trim();
         var mh = referenceChains(mcode).length && !/CURRENT/i.test(mcode) ? hierarchyOf(mcode, ctx) : null;
         var head = "[member].AncestorsAll (every ancestor, through every parent) is not supported in TM1 v12: alone it returns an empty set with no error, and inside INTERSECT the MDX fails. " +
            "Ancestors and IsAncestor follow one parent only, so they are not the same. ";
         if (!mh) { push("mdx.ancestorsAll", "MANUAL", head + "Write the ancestors as a FILTER over the hierarchy, keeping the consolidations whose DESCENDANTS include the member.", { match: text.substring(ms, am.index + am[0].length), index: ms, function: "ANCESTORSALL" }); continue; }
         var H = mh.unique, rep = "FILTER(TM1SUBSETALL(" + H + "), COUNT(INTERSECT({" + mtext + "}, DESCENDANTS(" + H + ".CurrentMember))) > 0 AND NOT (" + H + ".CurrentMember IS " + mtext + "))";
         rewriteOrShow("mdx.ancestorsAll", head + "The rewrite keeps the consolidations whose descendants include it: the same set on both versions, in dimension order (HIERARCHIZE gives the same order as v11).",
            { match: text.substring(ms, am.index + am[0].length), index: ms, replacement: rep, function: "ANCESTORSALL" }, "show");
      }

      /* TM1ROLLUP(S1, S2): for each member m of S1, m's direct parents (in
       * dimension order) and then m when m is in S2, else m alone; duplicates
       * kept. For a literal S1 that is, per member, the parents FILTERed on
       * "m is in S2", then m: equal in all 8 measured cases on both versions.
       * A computed S1 has no rewrite (Ancestors(m, 1) is one parent, and v11
       * cannot parse an IIF that returns sets). */
      var rre = /\bTM1ROLLUP\s*\(/ig, rm;
      while ((rm = rre.exec(code)) !== null) {
         var ro = rm.index + rm[0].length - 1, rargs = splitArgs(code, S(), ro);
         var rhead = "TM1ROLLUP is not supported in TM1 v12. In v11, TM1ROLLUP(S1, S2) gives, for each member of S1, its parents and then the member when the member is in S2, and the member alone otherwise. ";
         var rmatch = rargs ? text.substring(rm.index, S().pair[ro] + 1) : text.substring(rm.index, rm.index + rm[0].length);
         var items = null, rh = null, s2 = null;
         if (rargs && rargs.length === 2) {
            var a0 = code.substring(rargs[0].start, rargs[0].end), lead = a0.search(/\S/);
            var bo = rargs[0].start + lead;
            if (code.charAt(bo) === "{" && S().pair[bo] !== undefined && !code.substring(S().pair[bo] + 1, rargs[0].end).trim()) {
               var parts = splitArgs(code, S(), bo);
               items = parts.map(function (p) { return { code: code.substring(p.start, p.end).trim(), text: text.substring(p.start, p.end).trim() }; });
               if (!items.every(function (it) { return /^\[(?:[^\]]|\]\])*\](?:\s*\.\s*\[(?:[^\]]|\]\])*\])+$/.test(it.code); })) items = null;
               if (items) {
                  var hs = items.map(function (it) { return hierarchyOf(it.code, ctx); });
                  if (hs.every(function (h) { return h && h.unique.toLowerCase() === hs[0].unique.toLowerCase(); })) rh = hs[0];
               }
            }
            var s2code = code.substring(rargs[1].start, rargs[1].end);
            if (!/CURRENT/i.test(s2code)) s2 = text.substring(rargs[1].start, rargs[1].end).trim();
         }
         if (!items || !rh || s2 === null) {
            push("mdx.rollup", "MANUAL", rhead + "Only a literal first set ({[d].[h].[e], …}) can be rewritten: list its members, each one preceded by its parents when it is in S2.", { match: rmatch, index: rm.index, function: "TM1ROLLUP" });
            continue;
         }
         var RH = rh.unique;
         var rrep = "{" + items.map(function (it) {
            return "FILTER(FILTER(TM1SUBSETALL(" + RH + "), COUNT(INTERSECT({" + it.text + "}, " + RH + ".CurrentMember.CHILDREN)) > 0), COUNT(INTERSECT({" + it.text + "}, " + s2 + ")) > 0), " + it.text;
         }).join(", ") + "}";
         rewriteOrShow("mdx.rollup", rhead + "The rewrite lists that for each member: its parents (a FILTER on the children), kept only when the member is in S2, then the member.",
            { match: rmatch, index: rm.index, replacement: rrep, function: "TM1ROLLUP" }, "show");
      }

      /* TM1TUPLESIZE(x): the number of members in the tuple (measured: 1 for a
       * member, 2 for (m, n)); a set argument is a syntax error on v11. */
      var tre = /\bTM1TUPLESIZE\s*\(/ig, tm;
      while ((tm = tre.exec(code)) !== null) {
         var to = tm.index + tm[0].length - 1, targs = splitArgs(code, S(), to);
         var thead = "TM1TUPLESIZE is not supported in TM1 v12. It is the number of members in a tuple: ";
         var n = null;
         if (targs && targs.length === 1) {
            var tcode = code.substring(targs[0].start, targs[0].end), tl = targs[0].start + tcode.search(/\S/);
            if (code.charAt(tl) === "(" && S().pair[tl] !== undefined && !code.substring(S().pair[tl] + 1, targs[0].end).trim()) n = splitArgs(code, S(), tl).length;
            else if (code.charAt(tl) !== "{" && tcode.trim()) n = 1;
         }
         var tmatch = targs ? text.substring(tm.index, S().pair[to] + 1) : text.substring(tm.index, tm.index + tm[0].length);
         if (n === null) { push("mdx.tupleSize", "MANUAL", thead + "write that count.", { match: tmatch, index: tm.index, function: "TM1TUPLESIZE" }); continue; }
         push("mdx.tupleSize", "REWRITE", thead + "here " + n + ", so the rewrite is the number " + n + ".",
            { match: tmatch, index: tm.index, replacement: String(n), function: "TM1TUPLESIZE", check: inSubset });
      }
      return out;
   }

   /* A rescan without the page's reads (after an Apply, rescanQuiet) keeps
    * what those reads decided, by finding key. A subset-by-name finding the
    * element read dropped stays dropped. A checked rewrite or TM1SubsetBasis
    * finding keeps its verdict and text, and one never checked is MANUAL, so
    * Apply never writes an unchecked rewrite. An element-security finding is
    * kept while its MDX still names that element. Returns the findings. */
   /* Apply is all or nothing per process, and fixProcess refuses one where a
    * statement that must go feeds a later line (canary c05: `vOld =
    * CubeGetLogChanges(...)` read by an IF below -- removing it leaves vOld
    * undefined, PROJECT-PLAN §2.13). Only the detail pane used to know: the list
    * still tagged its findings REMOVE, ticked them, counted them as fixable,
    * and "Apply selected" quietly left the process out (user, 2026-10-06). So
    * the scan asks the fixer once per process, and a refused one's findings
    * become MANUAL everywhere, carrying the lines that block them. */
   function refuseUnfixable(processes, findings, v12) {
      var byName = {}, byProc = {};
      processes.forEach(function (p) { byName[p.Name] = p; });
      findings.forEach(function (f) {
         if (f.objectType !== "Process" || !byName[f.object] || (f.fix !== "REMOVE" && f.fix !== "STUB" && f.fix !== "REWRITE")) return;
         (byProc[f.object] = byProc[f.object] || []).push(f);
      });
      Object.keys(byProc).forEach(function (name) {
         var fs = byProc[name];
         var mdxEdits = fs.filter(function (x) { return x.fix === "REWRITE" && x.fixedStatement; })
            .map(function (x) { return { procedure: x.procedure, statement: x.statement, fixedStatement: x.fixedStatement }; });
         var fix = fixProcess(byName[name], null, { v12: v12, mdxEdits: mdxEdits });
         if (fix.fixable) return;
         fs.forEach(function (f) { f.refusedFix = f.fix; f.fix = "MANUAL"; f.refused = fix.blockers; });
      });
   }

   function carryPageResults(previous, result) {
      var prev = {};
      (previous || []).forEach(function (f) { prev[findingKey(f)] = f; });
      var out = (result.findings || []).filter(function (f) {
         var p = prev[findingKey(f)];
         if (f.elementCheck && !p) return false;
         if (f.basisCheck || f.check) {
            if (p) { f.fix = p.fix; f.suggestion = p.suggestion; if (p.replacement !== undefined) f.replacement = p.replacement; f._checked = p._checked; }
            else f.fix = "MANUAL";
         }
         return true;
      });
      (previous || []).forEach(function (p) {
         if (p.rule !== "mdx.elementSecurity") return;
         var still = (result.elementRefs || []).some(function (r) {
            return r.use && r.use.object === p.object && r.use.statement === p.statement && normName(r.element) === normName(p.referenced);
         });
         if (still) out.push(p);
      });
      return sortFindings(out);
   }

   /* What the page adds to a checked rewrite's suggestion. */
   function checkNote(how, extra) {
      extra = extra || {};
      // a view is compared as its rows and columns, a subset as its elements
      var obj = extra.view ? "view" : "subset", unit = extra.view ? "row and column member" : "element";
      var units = function (n) { return n + " " + unit + (n === 1 ? "" : "s"); };
      switch (how) {
         case "same": return " Checked: the rewritten MDX returns the same " + units(extra.n) + ", in the same order, as the " + obj + " on " + extra.from + ".";
         case "differs": return " Not offered: the rewritten MDX returns " + units(extra.got) + " where the " + obj + " returns " + extra.want + " on " + extra.from + ". Rewrite: " + extra.replacement;
         case "v11fails": return " Not offered: the " + obj + "'s MDX fails on " + extra.from + " too (" + extra.error + "), so there is no result to keep. Rewrite: " + extra.replacement;
         case "fails": return " Not offered: the rewritten MDX fails (" + extra.error + "). Rewrite: " + extra.replacement;
         case "nosource": return " Not offered yet: pick the original v11 database as the comparison database, and the rewrite is checked against it and offered. Rewrite: " + extra.replacement;
         default: return "";
      }
   }

   /* What a TM1SubsetBasis finding says, by what the page could find out:
    * `how` is null (not looked yet, or MDX inside TI, which has no stored
    * basis), "rewrite", "differs", "nosource", "notfound" or "failed". */
   function basisSuggestion(objectType, how, extra) {
      extra = extra || {};
      var head = "TM1SubsetBasis() is not supported in TM1 v12 (IBM): the whole MDX fails. It stood for the element list saved with the subset when its expression was recorded, and TM1 12 keeps no such list. ";
      if (objectType === "View") return head + "An MDX view has no stored list to read it from: replace the call by the set it should be.";
      if (objectType !== "Subset") return head + "MDX written in TI has no stored list (v11 fails it too, \"Cannot resolve TM1 subset\"): replace the call by the set it should be.";
      switch (how) {
         case "rewrite": return head + "The list was read from " + extra.from + (extra.via ? " (" + extra.via + ")" : "") + ": " + extra.count + " element" + (extra.count === 1 ? "" : "s") + ". The rewrite " +
            (extra.count ? "names " + (extra.count === 1 ? "it" : "them") : "uses the empty set {}") + ", and returns the same " +
            extra.result + " element" + (extra.result === 1 ? "" : "s") + " in the same order as the subset does " + (extra.v12 ? "on " + extra.from + "." : "now.");
         case "differs": return head + "The list was read from " + extra.from + ", but the rewrite returns " + extra.got + " element" + (extra.got === 1 ? "" : "s") + " where the subset returns " +
            extra.want + ". Check the subset by hand: replace TM1SubsetBasis() by " + extra.set + ", or by the set it should be.";
         case "nosource": return head + "This database no longer has the list. Pick the original v11 database below, or as the comparison database: the list is read there, as Arc's subset editor reads it, and the rewrite is built from it." +
            (extra.element ? " A guess: an element " + (extra.alias ? "has an alias " : "is named ") + "like the subset (" + extra.element + (extra.alias ? ", alias " + extra.alias : "") +
               "), so the list may have been {" + extra.element + "}." : "");
         case "notfound": return head + "The subset is not on " + extra.from + ", so its list could not be read. Replace TM1SubsetBasis() by the set it should be.";
         case "failed": return head + "Its list could not be read from " + extra.from + " (" + extra.error + "). Replace TM1SubsetBasis() by the set it should be.";
         default: return head + "Replace it by the elements of that list.";
      }
   }

   /* The set that replaces TM1SubsetBasis(): the stored elements, in order,
    * on the subset's hierarchy. An empty list is `{}`, which both versions run
    * (measured: 0 members on v11 and on 12.6.4). */
   function basisSet(dim, hier, elements) {
      var q = function (s) { return "[" + String(s).replace(/\]/g, "]]") + "]"; };
      return "{" + (elements || []).map(function (e) { return q(dim) + "." + q(hier || dim) + "." + q(e); }).join(", ") + "}";
   }

   /* The list as Arc puts it in place of TM1SubsetBasis(): the UniqueNames REST
    * gives, in order, joined by "," (its code: join, then replace). */
   function basisListOf(uniqueNames) { return (uniqueNames || []).join(","); }

   /* How Arc's v11 subset editor reads the stored list (measured 2026-10-02 on
    * 11.8, from its network log): a PATCH of the subset's Expression to
    * `{TM1SubsetBasis()}` with $expand=Elements returns the stored list as
    * Elements, and a second PATCH puts the MDX back. The .sub file kept its
    * `270,` block through that. No TI and no data directory, so it also works
    * where the v11 TI cannot reach its files. */
   var BASIS_ONLY = "{TM1SubsetBasis()}";

   function lookup(map, dim) {
      if (!map) return null;
      var key = normName(dim);
      for (var k in map) if (map.hasOwnProperty(k) && normName(k) === key) return map[k].map(normName);
      return null;
   }

   /* Runs of `[a].[b].[c]` in the (string-blanked) MDX. */
   function referenceChains(code) {
      var out = [], re = /\[[^\]]*\](?:\s*\.\s*\[[^\]]*\])+/g, m;
      while ((m = re.exec(code)) !== null) {
         var parts = [], pr = /\[([^\]]*)\]/g, p;
         while ((p = pr.exec(m[0])) !== null) parts.push(p[1]);
         out.push({ text: m[0], index: m.index, parts: parts });
      }
      return out;
   }

   /* Element security and MDX (IBM, "Element security and MDX evaluation"):
    * TM1 12 applies element security before it evaluates MDX, where v11
    * filtered the result afterwards. An MDX that names an element a user
    * cannot read therefore fails or comes back empty for that user, even
    * though it worked in v11. An empty cell in }ElementSecurity_<dim> is None
    * (IBM, "}ElementSecurity_dimensionname"). The admin groups bypass element
    * security, so they are never affected. */
   var ADMIN_GROUPS = { admin: true, dataadmin: true, securityadmin: true, operationsadmin: true };

   /* The dimensions with element security: one }ElementSecurity_<dim> cube
    * each. Keyed by normName(dim). */
   function securedDimensions(cubes) {
      var out = {};
      (cubes || []).forEach(function (c) {
         var m = /^\}ElementSecurity_(.+)$/.exec(c.Name);
         if (m && m[1].indexOf(":") < 0) out[normName(m[1])] = { dimension: m[1], cube: c.Name };
      });
      return out;
   }

   /* Each element an MDX names on a dimension with element security:
    * `[d].[h].[e]` and `[d].[e]` (also followed by `.Children` and the like),
    * on the dimension's own hierarchy, which is the one }ElementSecurity_<dim>
    * secures. A hierarchy or attribute name is not an element. A subset name may
    * be one too, and then TM1 12 resolves the element (§2.5), so it is kept:
    * whether a name really is an element is read from the database. */
   function securedElementRefs(mdx, secured, ctx) {
      var code = String(mdx || "").replace(/"[^"]*"/g, function (s) { return '"' + repeat(" ", s.length - 2) + '"'; });
      var out = [], seen = {};
      referenceChains(code).forEach(function (ch) {
         var parts = ch.parts, sec = secured[normName(parts[0])];
         if (!sec || parts.length > 3) return;
         var hier = parts.length === 3 ? parts[1] : parts[0], el = parts[parts.length - 1];
         if (normName(hier) !== normName(parts[0])) return;
         if (normName(el) === normName(parts[0])) return;
         var hiers = lookup(ctx.hierarchies, parts[0]) || [], attrs = lookup(ctx.attributes, parts[0]) || [];
         if (parts.length === 2 && hiers.indexOf(normName(el)) >= 0) return;
         if (attrs.indexOf(normName(el)) >= 0) return;
         var key = normName(el);
         if (seen[key]) return;
         seen[key] = true;
         out.push({ dimension: sec.dimension, cube: sec.cube, element: el, reference: ch.text });
      });
      return out;
   }

   /* The findings, once the page has read each secured dimension:
    * `access[cube]` = { groups: the non-admin groups with some right anywhere
    * in the dimension, rights: { normName(element): { group: right } },
    * exists: { normName(element): true } }. A group without a right on the
    * element has None on it (blank is None). A group with no right anywhere in
    * the dimension does not use it, and is left out (user, 2026-10-01). */
   function elementSecurityFindings(refs, access) {
      var out = [];
      refs.forEach(function (r) {
         var a = access[r.cube];
         if (!a) return;
         var key = normName(r.element);
         if (!a.exists[key]) return;
         var rights = a.rights[key] || {};
         var all = a.groups.filter(function (g) { var v = rights[g]; return !v || /^none$/i.test(v); });
         /* A }tp_ group is TM1 Applications security, which the migration removes
          * with the rest of TM1 Applications (§4 F): it is left out, and said so
          * (user, 2026-10-02). When it is the only one, the finding is INFO. */
         var tp = all.filter(function (g) { return isTM1Applications(g); });
         var none = all.filter(function (g) { return !isTM1Applications(g); });
         if (!all.length) return;
         var u = r.use, named = none.length > 4 ? none.slice(0, 4).join(", ") + " and " + (none.length - 4) + " more" : none.join(", ");
         var tpNote = tp.length ? " Left out: " + tp.join(", ") + ", a TM1 Applications group" + (tp.length === 1 ? "" : "s") + ", which the migration removes with TM1 Applications." : "";
         if (!none.length) {
            out.push({
               rule: "mdx.elementSecurity", severity: "INFO", objectType: u.objectType, object: u.object,
               procedure: u.procedure, line: u.line, statement: u.statement, fix: "MANUAL", tm1Applications: !!u.tm1Applications,
               referenced: r.element, dimension: r.dimension, groups: [], tpGroups: tp,
               dimensionName: u.dimensionName, hierarchyName: u.hierarchyName, subsetName: u.subsetName, cubeName: u.cubeName, viewName: u.viewName,
               suggestion: "Names " + r.reference + ", which only TM1 Applications group" + (tp.length === 1 ? "" : "s") + " cannot read (" + tp.join(", ") + "). " +
                  "The migration removes TM1 Applications and its }tp_ groups, so nothing needs to change for them."
            });
            return;
         }
         out.push({
            rule: "mdx.elementSecurity", severity: u.severity, objectType: u.objectType, object: u.object,
            procedure: u.procedure, line: u.line, statement: u.statement, fix: "MANUAL", tm1Applications: !!u.tm1Applications,
            referenced: r.element, dimension: r.dimension, groups: none, tpGroups: tp,
            dimensionName: u.dimensionName, hierarchyName: u.hierarchyName, subsetName: u.subsetName, cubeName: u.cubeName, viewName: u.viewName,
            suggestion: "Names " + r.reference + ", which " + none.length + " group" + (none.length === 1 ? "" : "s") + " cannot read (" + named + ")." + tpNote + " " +
               "TM1 v12 applies element security before the MDX runs, so for their users this " +
               (u.objectType === "Subset" ? "subset fails or comes back empty" : "MDX fails or comes back empty when they run it") +
               "; v11 filtered the result afterwards. Either give those groups READ on " + r.element +
               ", or stop naming it: {DESCENDANTS([" + r.dimension + "].[" + r.dimension + "].MEMBERS)} returns everything a user can see " +
               "(more than the descendants of " + r.element + "), and a FILTER on an attribute that marks the wanted elements keeps the result for everyone." +
               (u.severity === "REVIEW" ? " A process run by an admin is not affected: this matters only when a restricted user runs it." : "")
         });
      });
      return out;
   }

   /* The grant of READ on one element to the groups a finding lists, from a
    * cellset of that element's row across those groups, read with RuleDerived
    * (user, 2026-10-01). A cell a rule sets cannot be written: then nothing is
    * granted and the finding says why. `before` is what a restore writes back. */
   /* Which groups READ on a consolidation would help (user, 2026-10-02): only
    * those with a right (not None) on at least one of its descendants. A group
    * that can read none of them would see the total and nothing under it, so it
    * is left out of the grant. `cells` is the descendants' cellset (rows ×
    * `groups`, row-major), `rows` its row count; an empty one leaves all out. */
   function grantGroups(groups, cells, rows) {
      var grant = [], leftOut = [];
      groups.forEach(function (g, j) {
         var any = false;
         for (var i = 0; i < rows && !any; i++) {
            var c = cells[i * groups.length + j], v = c ? c.Value : null;
            if (v !== null && v !== undefined && v !== "" && !/^none$/i.test(v)) any = true;
         }
         (any ? grant : leftOut).push(g);
      });
      return { grant: grant, leftOut: leftOut };
   }

   function grantPlan(groups, cells) {
      var before = {}, ruleDerived = [];
      groups.forEach(function (g, i) {
         var c = cells[i] || {};
         before[g] = c.Value === null || c.Value === undefined ? "" : String(c.Value);
         if (c.RuleDerived) ruleDerived.push(g);
      });
      return { before: before, ruleDerived: ruleDerived, writable: ruleDerived.length === 0 };
   }

   /* A string or alias attribute is read without TYPED: its value is a string
    * either way (measured on 12.6.4 and v11, 2026-09-30: the same elements with
    * and without it). A numeric one needs TYPED, or the value comes back as a
    * string and `> 0` silently matches nothing (§2.5). With the type unknown,
    * TYPED is kept, because it is right for both. */
   function attributeRewrite(parts, type) {
      var dim = parts[0], hier = parts.length > 2 ? parts[1] : parts[0];
      var typed = type === "String" || type === "Alias" ? "" : ", TYPED";
      return "[" + dim + "].[" + hier + "].CurrentMember.Properties(\"" + parts[parts.length - 1] + "\"" + typed + ")";
   }

   /* The other hierarchies of `dim` that also hold `el`, when its default
    * hierarchy holds it too, or null. `ctx.members[normName(dim)]` maps
    * normName(element) to the hierarchies holding it; it is built from the
    * element lists the scan reads for dimensions with more than one real
    * hierarchy (Leaves left out). A name that is a hierarchy is not a member. */
   function otherHierarchiesWith(ctx, dim, el) {
      var m = ctx.members && ctx.members[normName(dim)];
      if (!m) return null;
      var hs = m[normName(el)];
      if (!hs) return null;
      var others = hs.filter(function (h) { return normName(h) !== normName(dim); });
      return others.length && others.length < hs.length ? others : null;
   }

   /* `ctx.attributeTypes[dim][normName(attr)]` is String, Numeric or Alias. */
   function attributeType(ctx, dim, attr) {
      var map = ctx.attributeTypes;
      if (!map) return null;
      var key = normName(dim);
      for (var k in map) if (map.hasOwnProperty(k) && normName(k) === key) return map[k][normName(attr)] || null;
      return null;
   }

   /* Measured on 12.6.4, 2026-09-30: `[dim].[attr]` does not resolve there at
    * all. The whole expression is rejected with "Expected a member name but
    * found <attr>", so a subset built on it fails; it is not a wrong result. */
   function attributeSuggestion(ref, attr, type) {
      var head = "TM1 v12 does not read " + ref + " as the attribute " + attr +
         ": it rejects the whole MDX (\"Expected a member name but found " + attr + "\"). ";
      if (type === "String" || type === "Alias") {
         return head + "Read the value with .CurrentMember.Properties(\"" + attr + "\") instead; " + attr +
            " is a " + type.toLowerCase() + " attribute, so the comparison is unchanged. In v11 it returns the same elements.";
      }
      if (type === "Numeric") {
         return head + "Read the value with .CurrentMember.Properties(\"" + attr + "\", TYPED) instead. " + attr +
            " is numeric: without TYPED the value comes back as a string, and a numeric comparison silently matches nothing.";
      }
      return head + "Read the value with .CurrentMember.Properties(\"" + attr + "\", TYPED) instead. TYPED matters only for a numeric attribute, and is harmless for a string one.";
   }

   function subsetRewrite(parts) {
      var dim = parts[0], hier = parts.length > 2 ? parts[1] : parts[0];
      return "TM1SubsetToSet([" + dim + "].[" + hier + "], \"" + parts[parts.length - 1] + "\")";
   }

   function balanced(code) {
      var sq = 0, par = 0, br = 0, inBr = false;
      for (var i = 0; i < code.length; i++) {
         var c = code.charAt(i);
         if (inBr) { if (c === "]") { inBr = false; sq--; } continue; }
         if (c === "[") { inBr = true; sq++; }
         else if (c === "]") return false;
         else if (c === "(") par++;
         else if (c === ")") { par--; if (par < 0) return false; }
         else if (c === "{") br++;
         else if (c === "}") { br--; if (br < 0) return false; }
      }
      return sq === 0 && par === 0 && br === 0 && !inBr;
   }

   /* Applies REWRITE findings (attribute / subset by identifier, trailing
    * semicolon) to an MDX expression. Replacements run right to left so the
    * earlier indices stay valid. */
   function fixMdx(mdx, findings) {
      var text = String(mdx || "");
      var edits = findings.filter(function (f) { return f.fix === "REWRITE" && f.match && typeof f.index === "number"; })
         .sort(function (a, b) { return b.index - a.index; });
      edits.forEach(function (f) {
         if (text.substr(f.index, f.match.length) === f.match) text = text.substring(0, f.index) + f.replacement + text.substring(f.index + f.match.length);
      });
      if (findings.some(function (f) { return f.rule === "mdx.trailing"; })) text = text.replace(/;\s*$/, "");
      return text;
   }

   // ---------------------------------------------------------------------------
   // Names
   // ---------------------------------------------------------------------------

   /* Cubes, views, dimensions and subsets whose names contain one of
    * \ / : * ? " < > | ' ; , -- or that are not valid UTF-8 -- are not migrated.
    * A name that arrived through REST as JSON is already decoded, so invalid
    * UTF-8 shows up as U+FFFD. */
   function nameProblem(name) {
      var s = String(name || "");
      var m = INVALID_NAME_CHARS.exec(s);
      if (m) return "contains " + JSON.stringify(m[0]);
      if (s.indexOf("�") >= 0) return "is not valid UTF-8";
      return null;
   }

   function scanName(objectType, name, parent) {
      var p = nameProblem(name);
      if (!p) return [];
      return [{
         rule: "name.invalid", severity: "BLOCKER", objectType: objectType, object: parent ? parent + " / " + name : name,
         procedure: null, line: null, statement: name, fix: "MANUAL",
         suggestion: "The name " + p + ", so the migration utility leaves this " + objectType.toLowerCase() + " out. Rename it (and every reference to it) before migrating."
      }];
   }

   // ---------------------------------------------------------------------------
   // REMOVE fixer
   // ---------------------------------------------------------------------------

   var MARK = "# SAASMIG ";

   /* Comments out every statement that calls a REMOVE-able function, together
    * with its dependency chain, across all four procedures.
    *
    * The chain is the measured reason this is not a line edit (§2.1.10):
    * commenting out `v = CubeGetLogChanges(...)` and leaving the later
    * `CubeSetLogChanges(..., v)` fails to compile with "Variable is undefined".
    * So a variable assigned by a removed statement is tainted, any statement that
    * reads a tainted variable is removed too, and an assignment from clean code
    * ends the taint. TI variables live across Prolog -> Metadata -> Data ->
    * Epilog, so the taint does too.
    *
    * A tainted read inside an IF / ELSEIF / WHILE condition cannot be removed
    * without changing the block structure, so the process is reported as not
    * fixable rather than half-fixed. Returns the new procedures, the removed
    * statements, and `fixable`. Idempotent: commented lines are comment tokens
    * and are never matched again.
    *
    * `skip(procedure, statement)` names statements the user skipped: they stay
    * as they are, and so taint nothing. A skipped statement that reads a
    * variable something else removed would no longer compile, so it blocks the
    * fix instead of being kept broken. */
   function fixRemove(process, ruleFilter, skip) {
      var tainted = {};
      var removed = [];
      var blockers = [];
      var kept = [];
      var result = {};
      PROCEDURES.forEach(function (proc) {
         var code = process[proc] || "";
         var tokens = tokenize(code);
         var cuts = [];
         tokens.forEach(function (tok) {
            if (tok.type !== "statement") return;
            var reason = null;
            for (var i = 0; i < tok.calls.length; i++) {
               var r = removedByName[tok.calls[i].lower];
               if (r && r.fix === "REMOVE" && (!ruleFilter || ruleFilter(r.name))) { reason = r.name; break; }
            }
            if (!reason) {
               controlRefs(tok.literals).forEach(function (ctl) {
                  if (!reason && isRemovableControlWrite(tok, ctl.name) && (!ruleFilter || ruleFilter(ctl.name))) reason = ctl.name + " write";
               });
            }
            var readsTainted = null;
            tok.reads.concat(tok.calls.map(function (c) { return c.lower; })).forEach(function (v) { if (tainted[v]) readsTainted = readsTainted || v; });
            var text = tok.text.replace(/^\s+|\s+$/g, "");
            if (reason && skip && skip(proc, text)) {
               if (readsTainted) blockers.push({ procedure: proc, line: tok.line, statement: text, reason: "skipped, but uses " + tainted[readsTainted] });
               else kept.push({ procedure: proc, line: tok.line, statement: text, reason: reason });
               if (tok.assigns && tainted[tok.assigns]) delete tainted[tok.assigns];
               return;
            }
            if (!reason && readsTainted) reason = "uses " + tainted[readsTainted];
            if (reason) {
               if (tok.keyword) {
                  blockers.push({ procedure: proc, line: tok.line, statement: tok.text.trim ? tok.text.replace(/^\s+|\s+$/g, "") : tok.text, reason: reason });
                  return;
               }
               cuts.push({ tok: tok, reason: reason });
               removed.push({ procedure: proc, line: tok.line, statement: tok.text.replace(/^\s+|\s+$/g, ""), reason: reason });
               if (tok.assigns) tainted[tok.assigns] = tok.assigns;
            } else if (tok.assigns && tainted[tok.assigns]) {
               delete tainted[tok.assigns];
            }
         });
         result[proc] = commentOut(code, cuts);
      });
      return {
         procedures: result,
         removed: removed,
         blockers: blockers,
         kept: kept,
         fixable: blockers.length === 0,
         changed: removed.length > 0
      };
   }

   /* Rewrites each cut statement as comment lines carrying the rule, keeping
    * the original text after the marker so the change reviews as a diff and
    * can be undone by hand.
    *
    * A TI comment is a `#` at the start of a line, so a statement that shares
    * its line with another is first moved onto a line of its own (plan §2.13,
    * found by a canary): left in place, `X; vOK = 1;` would comment out
    * `vOK = 1;` with it, and `vA = 1; X;` would get a `#` in mid-line, which is
    * no comment at all. Only then does the line count change. */
   function commentOut(code, cuts) {
      if (!cuts.length) return code;
      var out = code;
      var nl = /\r\n/.test(code) ? "\r\n" : "\n";
      cuts.slice().sort(function (a, b) { return b.tok.start - a.tok.start; }).forEach(function (cut) {
         var tok = cut.tok;
         var lineStart = out.lastIndexOf("\n", tok.start - 1) + 1;
         var lineIndent = /^[ \t]*/.exec(out.substring(lineStart))[0];
         var before = out.substring(lineStart, tok.start);
         var shared = /\S/.test(before);
         // start at the beginning of the line so indentation stays with the comment
         var ls = shared ? tok.start : lineStart;
         var indent = shared ? lineIndent : before;
         var lineEnd = out.indexOf("\n", tok.end);
         if (lineEnd < 0) lineEnd = out.length;
         var after = /\S/.test(out.substring(tok.end, lineEnd).replace(/\r$/, ""));
         var original = out.substring(tok.start, tok.end);
         var lines = original.split("\n");
         var tag = MARK + cut.reason + ": ";
         var rewritten = lines.map(function (l, k) {
            var cr = /\r$/.test(l) ? "\r" : "";
            var body = l.replace(/\r$/, "");
            return (k === 0 ? indent : "") + tag + body.replace(/^\s+/, "") + cr;
         }).join("\n");
         var rest = out.substring(tok.end);
         if (after) rest = nl + lineIndent + rest.replace(/^[ \t]+/, "");
         out = out.substring(0, ls).replace(shared ? /[ \t]+$/ : /$/, "") + (shared ? nl : "") + rewritten + rest;
      });
      return out;
   }

   /* ExecuteCommand -> a commented ExecuteHttpRequest template beside the
    * commented original. Both stay comments: ExecuteHttpRequest does not exist
    * in v11 (no v12 function is back-ported), so it can only be completed after
    * cutover. */
   function fixStub(process, v12, skip) {
      // on v11 the template waits for cutover; on TM1 12 it can be completed now
      var todo = v12 ? "# SAASMIG TODO: " : "# SAASMIG TODO after cutover: ";
      var result = {}, removed = [], kept = [];
      PROCEDURES.forEach(function (proc) {
         var code = process[proc] || "";
         var cuts = [];
         tokenize(code).forEach(function (tok) {
            if (tok.type !== "statement") return;
            if (tok.calls.some(function (c) { return c.lower === "executecommand"; }) && !tok.keyword) {
               if (skip && skip(proc, tok.text.replace(/^\s+|\s+$/g, ""))) {
                  kept.push({ procedure: proc, line: tok.line, statement: tok.text.replace(/^\s+|\s+$/g, ""), reason: "ExecuteCommand" });
                  return;
               }
               cuts.push({ tok: tok, reason: "ExecuteCommand" });
               removed.push({ procedure: proc, line: tok.line, statement: tok.text.replace(/^\s+|\s+$/g, ""), reason: "ExecuteCommand" });
            }
         });
         if (!cuts.length) { result[proc] = code; return; }
         var out = commentOut(code, cuts);
         // add the template after each statement commented out now -- not after
         // one an earlier run commented, which already has it (idempotence,
         // canary c12, plan §2.13) -- as comments, with
         // the code's own line ending: a bare \n in CRLF code is stored by TM1 as
         // CRLF, so the re-read differed and Apply put the original back (canary
         // c12, plan §2.13)
         out = out.replace(/(# SAASMIG ExecuteCommand: [^\r\n]*;[^\r\n]*)(\r?\n|$)(?![ \t]*# SAASMIG TODO)/g, function (all, line, nl) {
            var eol = nl || (/\r\n/.test(code) ? "\r\n" : "\n");
            return line + eol +
               todo + "ExecuteHttpRequest('POST', 'https://<your-service>/run', '-h Content-Type:application/json', '-d {\"command\":\"...\"}');" + eol +
               todo + "IF(HttpResponseGetStatusCode() <> 200); ProcessError; ENDIF;" + (nl ? nl : "");
         });
         result[proc] = out;
      });
      return { procedures: result, removed: removed, kept: kept, fixable: true, changed: removed.length > 0, manual: true };
   }

   function fixRewriteSecurityRefresh(process, skip) {
      var result = {}, removed = [], kept = [];
      PROCEDURES.forEach(function (proc) {
         var code = process[proc] || "";
         var toks = tokenize(code).filter(function (t) { return t.type === "statement" && t.calls.some(function (c) { return c.lower === "refreshsecurity"; }); });
         toks = toks.filter(function (t) {
            if (!skip || !skip(proc, t.text.replace(/^\s+|\s+$/g, ""))) return true;
            kept.push({ procedure: proc, line: t.line, statement: t.text.replace(/^\s+|\s+$/g, ""), reason: "RefreshSecurity" });
            return false;
         });
         toks.sort(function (a, b) { return b.start - a.start; }).forEach(function (t) {
            var seg = code.substring(t.start, t.end).replace(/\bRefreshSecurity\b/i, "SecurityRefresh");
            code = code.substring(0, t.start) + seg + code.substring(t.end);
            removed.push({ procedure: proc, line: t.line, statement: t.text.replace(/^\s+|\s+$/g, ""), reason: "RefreshSecurity" });
         });
         result[proc] = code;
      });
      return { procedures: result, removed: removed, kept: kept, fixable: true, changed: removed.length > 0 };
   }

   /* Rewrites MDX inside TI: each edit names a procedure, the statement as
    * scanned (trimmed) and the statement to write instead (from the scan's
    * `fixedStatement`). A statement is matched by its text, so a stale edit
    * matches nothing and changes nothing; the whitespace around it is kept. */
   function fixTiMdx(process, edits, skip) {
      var result = {}, removed = [], kept = [];
      PROCEDURES.forEach(function (proc) {
         var code = process[proc] || "";
         var mine = edits.filter(function (e) { return e.procedure === proc; });
         if (!mine.length) { result[proc] = code; return; }
         var toks = tokenize(code).filter(function (t) { return t.type === "statement"; });
         toks.sort(function (a, b) { return b.start - a.start; }).forEach(function (t) {
            var trimmed = t.text.replace(/^\s+|\s+$/g, "");
            var e = mine.filter(function (x) { return x.statement === trimmed; })[0];
            if (!e) return;
            if (skip && skip(proc, trimmed)) { kept.push({ procedure: proc, line: t.line, statement: trimmed, reason: "MDX" }); return; }
            var seg = code.substring(t.start, t.end), at = seg.indexOf(trimmed);
            if (at < 0) return;
            code = code.substring(0, t.start) + seg.substring(0, at) + e.fixedStatement + seg.substring(at + trimmed.length) + code.substring(t.end);
            removed.push({ procedure: proc, line: t.line, statement: trimmed, reason: "MDX" });
         });
         result[proc] = code;
      });
      return { procedures: result, removed: removed, kept: kept, fixable: true, changed: removed.length > 0 };
   }

   /* One entry point for a process: REMOVE chain + stub + rename, in that
    * order, filtered to the functions the caller chose, then the MDX edits
    * in `options.mdxEdits` (fixTiMdx). `options.skip` is
    * the skipped-statement test fixRemove describes; `kept` lists what it
    * left alone. */
   function fixProcess(process, onlyFunctions, options) {
      var v12 = !!(options && options.v12);
      var skip = options && options.skip || null;
      var allow = onlyFunctions ? onlyFunctions.map(function (s) { return s.toLowerCase(); }) : null;
      var ok = function (n) { return !allow || allow.indexOf(n.toLowerCase()) >= 0; };
      var work = copyProcedures(process);
      var removedAll = [], blockers = [], manual = false;
      var a = fixRemove(work, ok, skip);
      blockers = a.blockers;
      removedAll = removedAll.concat(a.removed);
      var kept = a.kept;
      work = merge(work, a.procedures);
      if (ok("ExecuteCommand")) { var b = fixStub(work, v12, skip); removedAll = removedAll.concat(b.removed); kept = kept.concat(b.kept); work = merge(work, b.procedures); manual = b.changed; }
      if (ok("RefreshSecurity")) { var c = fixRewriteSecurityRefresh(work, skip); removedAll = removedAll.concat(c.removed); kept = kept.concat(c.kept); work = merge(work, c.procedures); }
      if (options && options.mdxEdits && options.mdxEdits.length) {
         var d = fixTiMdx(work, options.mdxEdits, skip); removedAll = removedAll.concat(d.removed); kept = kept.concat(d.kept); work = merge(work, d.procedures);
      }
      var changedProcs = PROCEDURES.filter(function (p) { return (work[p] || "") !== (process[p] || ""); });
      return { procedures: work, changedProcedures: changedProcs, removed: removedAll, blockers: blockers, kept: kept,
         fixable: blockers.length === 0, changed: changedProcs.length > 0, needsManualWork: manual };
   }

   function copyProcedures(p) { var o = { Name: p.Name }; PROCEDURES.forEach(function (k) { o[k] = p[k] || ""; }); return o; }
   function merge(base, procs) { var o = copyProcedures(base); PROCEDURES.forEach(function (k) { if (procs[k] !== undefined) o[k] = procs[k]; }); return o; }

   /* The PATCH body for a fixed process: only the procedures that changed
    * (a partial PATCH leaves the others untouched, §2.2 row 0.4). */
   function processPatch(fixResult) {
      var body = {};
      fixResult.changedProcedures.forEach(function (p) { body[p] = fixResult.procedures[p]; });
      return body;
   }

   // ---------------------------------------------------------------------------
   // Line diff (for the preview)
   // ---------------------------------------------------------------------------

   function diffLines(before, after) {
      var a = String(before || "").split(/\r?\n/), b = String(after || "").split(/\r?\n/);
      var n = a.length, m = b.length, i, j;
      var dp = [];
      for (i = 0; i <= n; i++) { dp.push(new Array(m + 1)); for (j = 0; j <= m; j++) dp[i][j] = 0; }
      for (i = n - 1; i >= 0; i--) for (j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      var out = [];
      i = 0; j = 0;
      while (i < n && j < m) {
         if (a[i] === b[j]) { out.push({ op: " ", a: i + 1, b: j + 1, text: a[i] }); i++; j++; }
         else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ op: "-", a: i + 1, text: a[i] }); i++; }
         else { out.push({ op: "+", b: j + 1, text: b[j] }); j++; }
      }
      while (i < n) { out.push({ op: "-", a: i + 1, text: a[i] }); i++; }
      while (j < m) { out.push({ op: "+", b: j + 1, text: b[j] }); j++; }
      return out;
   }

   /* Only the changed lines with `context` lines around them. */
   function diffHunks(before, after, context) {
      var d = diffLines(before, after), keep = [], ctx = context === undefined ? 2 : context;
      d.forEach(function (row, k) {
         if (row.op !== " ") for (var x = Math.max(0, k - ctx); x <= Math.min(d.length - 1, k + ctx); x++) keep[x] = true;
      });
      var out = [], gap = false;
      d.forEach(function (row, k) {
         if (keep[k]) { out.push(row); gap = false; }
         else if (!gap) { out.push({ op: "…" }); gap = true; }
      });
      return out;
   }

   // ---------------------------------------------------------------------------
   // Rules comparisons
   // ---------------------------------------------------------------------------

   /* TM1 stores rules with `\r\n` turned into `\n` (§2.2 row 0.5), so a rule
    * read back after a PATCH never equals what was sent byte for byte. */
   function sameRules(a, b) { return String(a || "").replace(/\r\n/g, "\n") === String(b || "").replace(/\r\n/g, "\n"); }

   // ---------------------------------------------------------------------------
   // CloudID and CSV
   // ---------------------------------------------------------------------------

   function detectSeparator(headerLine) {
      var counts = { ",": 0, ";": 0, "\t": 0 };
      var inQ = false;
      for (var i = 0; i < headerLine.length; i++) {
         var c = headerLine.charAt(i);
         if (c === '"') inQ = !inQ;
         else if (!inQ && counts.hasOwnProperty(c)) counts[c]++;
      }
      var best = ",";
      if (counts[";"] > counts[best]) best = ";";
      if (counts["\t"] > counts[best]) best = "\t";
      return best;
   }

   /* RFC 4180-ish: quoted fields, doubled quotes, CRLF or LF, a leading BOM,
    * and `,` / `;` / tab separators (Excel in many locales saves with `;`). */
   function parseCsv(text) {
      var s = String(text || "").replace(/^﻿/, "");
      var firstLine = s.split(/\r?\n/)[0] || "";
      var sep = detectSeparator(firstLine);
      var rows = [], row = [], field = "", i = 0, n = s.length, inQ = false;
      while (i < n) {
         var c = s.charAt(i);
         if (inQ) {
            if (c === '"') {
               if (s.charAt(i + 1) === '"') { field += '"'; i += 2; continue; }
               inQ = false; i++; continue;
            }
            field += c; i++; continue;
         }
         if (c === '"') { inQ = true; i++; continue; }
         if (c === sep) { row.push(field); field = ""; i++; continue; }
         if (c === "\r") { i++; continue; }
         if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
         field += c; i++;
      }
      if (field !== "" || row.length) { row.push(field); rows.push(row); }
      return { separator: sep, rows: rows.filter(function (r) { return r.some(function (f) { return f !== ""; }); }) };
   }

   function csvField(v) {
      var s = v === null || v === undefined ? "" : String(v);
      return /[",;\r\n\t]/.test(s) || /^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
   }

   /* The export a consultant (or the client) fills in: every client with its
    * current CloudID (usually blank), then context columns. Only the first two
    * columns are read back on import. */
   function cloudIdCsv(clients) {
      var lines = [["Client", "CloudID", "Display name", "Groups"].map(csvField).join(",")];
      clients.forEach(function (c) {
         lines.push([c.name, c.cloudId || "", c.displayName || "", (c.groups || []).join(" | ")].map(csvField).join(","));
      });
      // a BOM so Excel opens UTF-8 names correctly
      return "﻿" + lines.join("\r\n") + "\r\n";
   }

   /* Compares an imported `client,CloudID` file with the model. Nothing is
    * written from here: the directive shows this preview first. */
   function cloudIdImport(csvText, clients, kind) {
      var parsed = parseCsv(csvText);
      var rows = parsed.rows;
      var byName = {};
      clients.forEach(function (c) { byName[normName(c.name)] = c; });
      var start = 0;
      if (rows.length && /^(client|group)$/i.test((rows[0][0] || "").trim()) && /^cloud\s*id$/i.test((rows[0][1] || "").trim())) start = 1;
      var changes = [], unknown = [], unchanged = [], seen = {}, dupClient = [];
      for (var r = start; r < rows.length; r++) {
         var name = (rows[r][0] || "").trim(), cloud = (rows[r][1] || "").trim();
         if (!name) continue;
         var c = byName[normName(name)];
         if (!c) { unknown.push({ row: r + 1, client: name, cloudId: cloud }); continue; }
         if (seen[c.name]) { dupClient.push({ row: r + 1, client: c.name }); continue; }
         seen[c.name] = true;
         if ((c.cloudId || "") === cloud) unchanged.push(c.name);
         else changes.push({ row: r + 1, client: c.name, from: c.cloudId || "", to: cloud });
      }
      var after = {};
      clients.forEach(function (c) { after[c.name] = c.cloudId || ""; });
      changes.forEach(function (ch) { after[ch.client] = ch.to; });
      return {
         separator: parsed.separator, changes: changes, unknown: unknown, unchanged: unchanged, duplicateRows: dupClient,
         validation: validateCloudIds(clients.map(function (c) { return { name: c.name, cloudId: after[c.name], privateObjects: c.privateObjects }; }), kind)
      };
   }

   /* What the migration utility will do with these values (IBM,
    * t_prepare_v11_model_for_migration): once the CloudID element exists, a
    * client with no value is not migrated and its private views and subsets go
    * with it; two clients with the same value would become one. IBM does not
    * specify the value format, so a value that does not look like an email
    * address is a warning, not an error. */
   function validateCloudIds(clients, kind) {
      var blanks = [], dups = [], odd = [], owners = {}, lostPrivate = 0;
      clients.forEach(function (c) {
         var v = (c.cloudId || "").trim();
         if (!v) { blanks.push(c.name); lostPrivate += c.privateObjects || 0; return; }
         var k = v.toLowerCase();
         (owners[k] = owners[k] || []).push(c.name);
         if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) odd.push({ client: c.name, cloudId: v });
      });
      for (var k in owners) if (owners.hasOwnProperty(k) && owners[k].length > 1) dups.push({ cloudId: k, clients: owners[k] });
      // the Admin client's private objects follow its CloudID; the ADMIN group is always created
      var admin = kind === "group" ? null : clients.filter(function (c) { return normName(c.name) === "admin"; })[0];
      return {
         blanks: blanks, duplicates: dups, notEmailLike: odd, privateObjectsLost: lostPrivate,
         adminHasCloudId: admin ? !!(admin.cloudId || "").trim() : null,
         ok: dups.length === 0
      };
   }

   /* The tm1.Update body for one CloudID cell. `}ClientProperties` is
    * dimensioned }Clients x }ClientProperties (§2.2 row 0.6). */
   function cloudIdCell(client, value) {
      return {
         Cells: [{
            "Tuple@odata.bind": [
               "Dimensions('}Clients')/Hierarchies('}Clients')/Elements('" + odataKey(client) + "')",
               "Dimensions('}ClientProperties')/Hierarchies('}ClientProperties')/Elements('CloudID')"
            ]
         }],
         Value: value
      };
   }

   /* Groups work the same way through }GroupProperties, which TM1 does not
    * have: the plugin creates the dimension (with CloudID) and the cube
    * }Groups x }GroupProperties (measured: REST creates both on v11, §2.9).
    * ADMIN, DataAdmin, OperationsAdmin and SecurityAdmin are created on TM1 12
    * whatever the mapping says (the utility's README). */
   var ALWAYS_GROUPS = ["admin", "dataadmin", "operationsadmin", "securityadmin"];

   function groupCloudIdCell(group, value) {
      return {
         Cells: [{
            "Tuple@odata.bind": [
               "Dimensions('}Groups')/Hierarchies('}Groups')/Elements('" + odataKey(group) + "')",
               "Dimensions('}GroupProperties')/Hierarchies('}GroupProperties')/Elements('CloudID')"
            ]
         }],
         Value: value
      };
   }

   function groupCloudIdCsv(groups) {
      var lines = [["Group", "CloudID"].map(csvField).join(",")];
      groups.forEach(function (g) { lines.push([g.name, g.cloudId || ""].map(csvField).join(",")); });
      // a BOM so Excel opens UTF-8 names correctly, as cloudIdCsv does
      return "﻿" + lines.join("\r\n") + "\r\n";
   }

   function isAlwaysGroup(name) { return ALWAYS_GROUPS.indexOf(normName(name)) >= 0; }

   /* An OData key literal: single quotes doubled. Callers still URL-encode
    * the whole path segment when it goes into a URL. */
   function odataKey(s) { return String(s).replace(/'/g, "''"); }

   function path(segments) {
      // segments: [["Processes", name], ["tm1.Compile"]] -> /Processes('..')/tm1.Compile
      return segments.map(function (seg) {
         return seg.length > 1 ? seg[0] + "('" + encodeURIComponent(odataKey(seg[1])) + "')" : seg[0];
      }).map(function (s) { return "/" + s; }).join("");
   }

   // ---------------------------------------------------------------------------
   // Backups
   // ---------------------------------------------------------------------------

   /* A backup file holds the original of every object an Apply touches,
    * written before the PATCH. It downloads silently to the browser's
    * Downloads folder (§2.2 row 0.9). */
   function backupFile(instance, entries, when) {
      var at = when || new Date();
      return {
         kind: "tm1-12-readiness-backup",
         version: VERSION,
         instance: instance,
         created: at.toISOString(),
         entries: entries
      };
   }

   // 2026-09-23T01:02:03.456Z -> 20260923-010203, the stamp every file name here carries
   function fileStamp(when) {
      return (when || new Date()).toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
   }
   function safeName(s) { return String(s).replace(/[^A-Za-z0-9_.-]+/g, "_"); }

   function backupFileName(instance, when) {
      return "tm1-12-readiness-backup-" + safeName(instance) + "-" + fileStamp(when) + ".json";
   }

   var BACKUP_KINDS = ["tm1-12-readiness-backup", "saas-migration-backup"];

   /* What a direct DELETE, or the read after it, got back (user, 2026-10-06: deletes go direct, with
    * guardrails instead of the async route). TM1's own answers carry its OData error body
    * ({"error":{"code":"278",...}}, measured on 11.8 and 12.6.4); a proxy or gateway that gave up does
    * not, and a dropped or timed-out connection has no status at all. So only TM1's own 404 means
    * "not there"; anything that is not TM1 speaking is "unknown", and never read as deleted. */
   function deleteAnswer(r) {
      if (!r || !(r.status > 0)) return "unknown";
      if (r.status >= 200 && r.status < 300) return "ok";
      if (r.status === 401 || r.status === 403) return "auth";
      var tm1 = !!(r.data && typeof r.data === "object" && r.data.error && r.data.error.code !== undefined);
      if (r.status === 404) return tm1 ? "missing" : "unknown";
      return tm1 ? "tm1error" : "unknown";
   }

   function readBackup(text) {
      var data;
      try { data = JSON.parse(text); } catch (e) { return { error: "Not a JSON file." }; }
      // files written before the rename carry the old kind, and still restore
      if (!data || BACKUP_KINDS.indexOf(data.kind) < 0 || !data.entries) return { error: "Not a TM1 12 Readiness backup file." };
      return { backup: data };
   }

   // ---------------------------------------------------------------------------
   // Projects (v0.14.0)
   // ---------------------------------------------------------------------------

   /* A project is a folder the user picks, holding one migration's scans,
    * step status, results, backups and log, so the work can stop and continue
    * later, or move to a colleague (user, 2026-10-05). The folder is reached
    * through the browser's File System Access API -- the plugin cannot write to
    * the Arc server or its logs (no write endpoint exists, PROJECT-PLAN §11).
    * Everything below is the pure half: the manifest, its file names, and the
    * snapshot codec. The I/O is the tm1ReadinessProject factory.
    *
    *    project.json                  the manifest (this section)
    *    log.jsonl                     the action log, one entry per line
    *    skips/<db>.json               skipped findings, per database
    *    scans/scan-<db>-<stamp>.json  the last PROJECT_SCANS_KEPT scans, per database
    *    backups/<backup file>         the same file and name as a downloaded backup
    *    results/                      exports, the v12 compile check, the compare
    *    inputs/migrate-<db>.log       a migrate.log the user read in step 3
    *
    * A backup keeps its download name and content, so one copied out of the
    * folder by hand still restores through readBackup. */
   var PROJECT_KIND = "tm1-12-readiness-project", PROJECT_SCHEMA = 1, PROJECT_SCANS_KEPT = 3;
   // the fix kind done by the plugin after the migration, not on v11 (the tag reads as it is)
   var FIX_ON_TM1_12 = "ON TM1 v12";
   // the value scans saved before the rename carry (user, 2026-10-06): read back as the new one
   var FIX_ON_TM1_12_OLD = ["ON TM1 12"];
   var PROJECT_FILE_KIND = "tm1-12-readiness-project-file", SCAN_KIND = "tm1-12-readiness-scan";

   function newProject(o, when) {
      var at = (when || new Date()).toISOString();
      return migrateProject({
         kind: PROJECT_KIND, schema: PROJECT_SCHEMA, id: o.id, name: String(o.name || "").trim(),
         created: at, updated: at, pluginVersion: VERSION,
         databases: { v11: o.v11 || null, v12: o.v12 || null }
      });
   }

   // fills what an older or hand-edited manifest lacks; running it twice changes nothing
   function migrateProject(m) {
      m.schema = PROJECT_SCHEMA;
      if (!m.databases) m.databases = { v11: null, v12: null };
      if (!m.instances || typeof m.instances !== "object") m.instances = {};
      if (!Array.isArray(m.backups)) m.backups = [];
      if (!Array.isArray(m.scans)) m.scans = [];
      return m;
   }

   /* A project written by a newer plugin is refused rather than opened: an
    * older build that rewrote its manifest could drop what it does not know. */
   function readProject(text) {
      var m;
      try { m = JSON.parse(text); } catch (e) { return { error: "json" }; }
      if (!m || m.kind !== PROJECT_KIND || !m.id) return { error: "kind" };
      if (m.schema > PROJECT_SCHEMA) return { error: "newer", version: m.pluginVersion || "" };
      return { project: migrateProject(m) };
   }

   function touch(m, when) { m.updated = (when || new Date()).toISOString(); m.pluginVersion = VERSION; return m; }

   // the step status of one database: savedData, cmdCopied, migrateLog, compare, v12check
   function projectNote(m, instance, patch, when) {
      var i = m.instances[instance] || (m.instances[instance] = { steps: {} });
      for (var k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) {
         if (patch[k] === undefined || patch[k] === null) delete i.steps[k]; else i.steps[k] = patch[k];
      }
      return touch(m, when);
   }

   /* The project folder's full path on the v11 host (user, 2026-10-06). The browser knows a picked
    * folder by its name only, so the path is typed once and kept in the manifest, where it travels
    * with the project. With it, the utility's output goes to <path>\migration -- inside the folder the
    * plugin can read, so the log is read from there without a file pick. */
   var PROJECT_OUTPUT_DIR = "migration";
   function projectSetHostPath(m, path, when) {
      var p = String(path || "").replace(/^\s+|\s+$/g, "").replace(/^"|"$/g, "").replace(/[\\\/]+$/, "");
      if (p) m.hostPath = p; else delete m.hostPath;
      return touch(m, when);
   }
   function projectOutputDir(m) {
      return m && m.hostPath ? m.hostPath + (/^[A-Za-z]:|\\/.test(m.hostPath) ? "\\" : "/") + PROJECT_OUTPUT_DIR : null;
   }

   function projectAddBackup(m, b, when) {
      m.backups.unshift({ file: b.file, instance: b.instance, at: b.at, count: b.count });
      return touch(m, when);
   }

   function scanFileName(instance, when) { return "scan-" + safeName(instance) + "-" + fileStamp(when) + ".json"; }

   /* Records a scan and returns the files that fall out of the kept window --
    * the caller deletes those. Newest first. */
   function projectAddScan(m, s, when) {
      m.scans.unshift({ file: s.file, instance: s.instance, at: s.at, findings: s.findings, blockers: s.blockers });
      var kept = 0, drop = [];
      m.scans = m.scans.filter(function (x) {
         if (x.instance !== s.instance) return true;
         if (++kept <= PROJECT_SCANS_KEPT) return true;
         drop.push(x.file); return false;
      });
      touch(m, when);
      return drop;
   }
   function latestScan(m, instance) {
      for (var i = 0; i < m.scans.length; i++) if (m.scans[i].instance === instance) return m.scans[i];
      return null;
   }

   /* A scan result as a file. processByName and the two groups are derived,
    * so they are left out and rebuilt; non-enumerable caches never reach JSON. */
   var SCAN_DERIVED = { processByName: 1, appsGroup: 1, bedrockGroup: 1, fromProject: 1 };
   function scanSnapshot(result) {
      var out = { kind: SCAN_KIND, version: VERSION };
      for (var k in result) if (Object.prototype.hasOwnProperty.call(result, k) && !SCAN_DERIVED[k]) out[k] = result[k];
      return out;
   }
   /* A scan read back is for reading only: Apply builds its preview from the
    * code the scan captured, and the model may have changed since. The page
    * refuses every write while `fromProject` is set, until a scan again. */
   function scanFromSnapshot(text) {
      var s;
      try { s = JSON.parse(text); } catch (e) { return null; }
      if (!s || s.kind !== SCAN_KIND || !s.model || !Array.isArray(s.findings)) return null;
      delete s.kind; delete s.version;
      s.at = new Date(s.at);
      s.fromProject = true;
      var renamed = false;
      s.findings.forEach(function (f) { if (FIX_ON_TM1_12_OLD.indexOf(f.fix) >= 0) { f.fix = FIX_ON_TM1_12; renamed = true; } });
      if (renamed || !s.summary || s.summary.onTm112 === undefined) s.summary = summarise(s.findings);
      s.appsGroup = tm1ApplicationsGroup(s.findings);
      s.bedrockGroup = bedrockGroup(s.findings);
      s.processByName = {};
      (s.model.processes || []).forEach(function (p) { s.processByName[p.Name] = p; });
      return s;
   }

   function logLine(e) {
      return JSON.stringify({ at: (e.at instanceof Date ? e.at.toISOString() : e.at), instance: e.instance || "", kind: e.kind, text: String(e.text) }) + "\n";
   }
   // a line cut short by a crash mid-append is dropped, not fatal
   function parseLogLines(text) {
      var out = [];
      String(text || "").split(/\r?\n/).forEach(function (l) {
         if (!l.trim()) return;
         try { var e = JSON.parse(l); if (e && e.at && e.kind) out.push({ at: new Date(e.at), kind: e.kind, text: e.text, instance: e.instance || "" }); } catch (x) { }
      });
      return out;
   }
   /* The browser's log and a project's, as one list newest first: a project
    * opened on another machine brings its history with it. */
   function mergeLogs(a, b, keep) {
      var seen = {}, out = [];
      a.concat(b).forEach(function (e) {
         var k = new Date(e.at).getTime() + "\u0001" + e.kind + "\u0001" + e.text;
         if (!seen[k]) { seen[k] = 1; out.push(e); }
      });
      out.sort(function (x, y) { return new Date(y.at) - new Date(x.at); });
      if (keep && out.length > keep) out.length = keep;
      return out;
   }

   // the recent list: newest first, one row per project, at most `keep`
   function recentProjects(list, entry, keep) {
      var out = [entry].concat((list || []).filter(function (r) { return r.id !== entry.id; }));
      return out.slice(0, keep || 10);
   }

   /* The plugin's own install folder is refused: a reinstall replaces it, and
    * Arc serves its files over HTTP, backups included. */
   function isPluginFolder(names) {
      var has = {};
      (names || []).forEach(function (n) { has[String(n).toLowerCase()] = 1; });
      return !!(has["plugin.js"] && has["template.html"] && has["translate-en.json"]);
   }

   /* One file holding a whole project, for a browser without folder access,
    * and for "Download project file". */
   function projectBundle(m, files) {
      return JSON.stringify({ kind: PROJECT_FILE_KIND, version: VERSION, project: m, files: files || {} });
   }
   function readProjectBundle(text) {
      var b;
      try { b = JSON.parse(text); } catch (e) { return { error: "json" }; }
      if (!b || b.kind !== PROJECT_FILE_KIND || !b.project) return { error: "kind" };
      var p = readProject(JSON.stringify(b.project));
      if (p.error) return p;
      return { project: p.project, files: b.files || {} };
   }

   // ---------------------------------------------------------------------------
   // Dependencies -- objects the migration removes, and who still uses them
   // ---------------------------------------------------------------------------

   /* A process is dropped by the utility when it has any BLOCKER. An object is
    * "deprecated" when it will not exist after migration; the scan never marks
    * anything in v11 (user, PROJECT-PLAN §9 Q2). */
   function droppedProcesses(findings) {
      var out = {};
      findings.forEach(function (f) { if (f.objectType === "Process" && f.severity === "BLOCKER") out[f.object] = true; });
      return out;
   }

   /* Edges from process code and chores to the processes they run, with the
    * line. Computed targets are kept as unresolved edges, never dropped. */
   function processEdges(processes, chores) {
      var edges = [];
      processes.forEach(function (p) {
         PROCEDURES.forEach(function (proc) {
            tokenize(p[proc] || "").forEach(function (tok) {
               if (tok.type !== "statement") return;
               tok.calls.forEach(function (c) {
                  if (c.lower === "executeprocess" || c.lower === "runprocess") {
                     edges.push({ fromType: "Process", from: p.Name, procedure: proc, line: tok.line, statement: tok.text.replace(/^\s+|\s+$/g, ""),
                        toType: "Process", to: c.firstLiteral, unresolved: c.firstLiteral === null });
                  }
               });
            });
         });
      });
      (chores || []).forEach(function (ch) {
         (ch.Tasks || []).forEach(function (t, k) {
            var target = t.Process && t.Process.Name;
            edges.push({ fromType: "Chore", from: ch.Name, procedure: "Task " + (k + 1), line: null, statement: target || "", toType: "Process", to: target || null, unresolved: !target });
         });
      });
      return edges;
   }

   /* Edges from TI and rules to control objects the migration removes. */
   function controlEdges(findings) {
      return findings.filter(function (f) { return f.rule === "control.removed"; }).map(function (f) {
         return { fromType: f.objectType === "Rules" ? "Cube rules" : f.objectType, from: f.object, procedure: f.procedure, line: f.line,
            statement: f.statement, toType: "Control object", to: f.referenced || f.object, removedReason: f.suggestion };
      });
   }

   /* The report D exists for: every surviving object that uses an object the
    * migration removes. A dropped process that calls another dropped process is
    * not listed -- it is gone anyway. */
   /* The migration carries such a process over and it fails to compile on
    * TM1 12 (§2.9); the wording says which side of the migration this is. */
   function usesRemoved(edges, dropped, v12) {
      var out = [];
      edges.forEach(function (e) {
         if (e.toType !== "Process" || e.unresolved) return;
         var target = findName(dropped, e.to);
         if (!target) return;
         if (e.fromType === "Process" && findName(dropped, e.from)) return;
         out.push({
            rule: "dep.usesRemoved", severity: "BREAKS", objectType: e.fromType, object: e.from, procedure: e.procedure, line: e.line,
            statement: e.statement, fix: "MANUAL", referenced: target,
            suggestion: "Runs process '" + target + "', which " + (v12 ? "does not compile on TM1 v12" : "will not compile on TM1 v12 after the migration") +
               ". Fix that process first (the fix usually clears this), or remove the call."
         });
      });
      return out;
   }

   function findName(map, name) {
      if (!name) return null;
      var k = normName(name);
      for (var n in map) if (map.hasOwnProperty(n) && normName(n) === k) return n;
      return null;
   }

   /* The suggestions are written for v11, where a fix changes v11 until
    * cutover. On a TM1 12 database there is no cutover: the fix is what makes
    * the process compile. So the v11-only sentences go, and "after cutover"
    * means now (user, 2026-09-29). */
   function v12Suggestion(text) {
      return String(text)
         .replace("The stub below is commented out: complete it after cutover, because ExecuteHttpRequest does not exist in v11.",
            "The stub below is commented out: complete it and uncomment it, since ExecuteHttpRequest exists on TM1 12.")
         .replace(/\s*In v11\b[^.]*\./g, "")
         .replace(/;?\s*after cutover,\s*/g, "; ")
         .replace(/\s+after (cutover|migration)/g, "")
         .replace(/\s{2,}/g, " ")
         .replace(/^\s+|\s+$/g, "");
   }

   // ---------------------------------------------------------------------------
   // Summary
   // ---------------------------------------------------------------------------

   var SEVERITY_ORDER = { BLOCKER: 0, BREAKS: 1, REVIEW: 2, INFO: 3 };

   /* Findings to act on (not INFO, not skipped) by the object they are on, in a fixed
    * order (user, 2026-10-05). These are every type the scan reports; anything else
    * would land under "Other", which stays hidden while it is empty. tm1s.cfg is not
    * here: its items are step 3's, not findings. `keep` filters further (step 2's Others). */
   var OBJECT_TYPES = ["Process", "Rules", "Subset", "View", "Chore", "Cube", "Dimension"];
   function findingsByType(findings, isSkipped, keep) {
      var by = {};
      (findings || []).forEach(function (f) {
         if (f.severity === "INFO" || (isSkipped && isSkipped(f)) || (keep && !keep(f))) return;
         var k = OBJECT_TYPES.indexOf(f.objectType) >= 0 ? f.objectType : "Other";
         by[k] = by[k] || { type: k, n: 0, fixable: 0, manualBlockers: 0 };
         by[k].n++;
         if (f.fix === "REMOVE" || f.fix === "REWRITE" || f.fix === "STUB") by[k].fixable++;
         else if (f.severity === "BLOCKER") by[k].manualBlockers++;
      });
      return OBJECT_TYPES.concat(["Other"]).map(function (k) { return by[k] || { type: k, n: 0, fixable: 0, manualBlockers: 0 }; });
   }

   function summarise(findings) {
      var s = { total: findings.length, bySeverity: { BLOCKER: 0, BREAKS: 0, REVIEW: 0, INFO: 0 }, fixable: 0, onTm112: 0, dropped: 0, droppedOutsideApps: 0 };
      findings.forEach(function (f) {
         s.bySeverity[f.severity] = (s.bySeverity[f.severity] || 0) + 1;
         if (f.fix === "REMOVE" || f.fix === "REWRITE" || f.fix === "STUB") s.fixable++;
         if (f.fix === FIX_ON_TM1_12) s.onTm112++;
      });
      var d = droppedProcesses(findings);
      for (var k in d) if (d.hasOwnProperty(k)) { s.dropped++; if (!isTM1Applications(k)) s.droppedOutsideApps++; }
      return s;
   }

   function sortFindings(findings) {
      return findings.slice().sort(function (a, b) {
         return (SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]) ||
            String(a.object).localeCompare(String(b.object)) ||
            ((a.line || 0) - (b.line || 0));
      });
   }

   /* `isSkipped`, when given, adds a column saying which findings the user
    * skipped: the export is the whole list, skipped ones included. */
   function findingsCsv(findings, isSkipped) {
      var cols = ["severity", "rule", "objectType", "object", "procedure", "line", "function", "fix", "statement", "suggestion"];
      var lines = [cols.concat(isSkipped ? ["skipped"] : []).join(",")];
      findings.forEach(function (f) {
         lines.push(cols.map(function (c) { return csvField(f[c]); }).concat(isSkipped ? [isSkipped(f) ? "yes" : ""] : []).join(","));
      });
      return "﻿" + lines.join("\r\n") + "\r\n";
   }

   /* What identifies a finding across rescans, for the skip list. Not the line
    * number: a fix elsewhere in the same procedure moves it. The statement text
    * is the anchor, and `match` tells apart two MDX findings on one subset. */
   function findingKey(f) {
      return [f.objectType, f.object, f.rule, f.procedure || "", f.statement || "",
         f.function || f.referenced || f.path || "", f.match || ""].join("\u0001");
   }

   /* The Arc page that opens a finding's object, as a ui-router state and its
    * parameters (less :instance), or null where Arc has no page for it. The
    * state names and URLs were read from Arc 6.0.0's own $state.get(). */
   function objectLink(f) {
      switch (f.objectType) {
         case "Process": return { state: "process", params: { name: f.object } };
         case "Chore": return { state: "chore", params: { name: f.object } };
         case "Cube": case "Rules": case "Cube rules": return { state: "cube", params: { name: f.object } };
         case "Dimension": return { state: "dimension", params: { name: f.object, hierarchy: f.object } };
         case "Subset":
            return f.dimensionName && f.subsetName ? { state: "subset", params: { name: f.dimensionName, hierarchy: f.hierarchyName || f.dimensionName, subset: f.subsetName } } : null;
         case "View":
            return f.cubeName && f.viewName ? { state: "view", params: { name: f.cubeName, view: f.viewName } } : null;
      }
      return null;
   }

   // ---------------------------------------------------------------------------
   // Whole-model scan
   // ---------------------------------------------------------------------------

   /* `model` is what the directive reads, one request each (§2.2):
    *    processes  GET /Processes?$select=Name,PrologProcedure,...,DataSource,Parameters,Variables
    *    cubes      GET /Cubes?$select=Name,Rules
    *    dimensions GET /Dimensions?$select=Name&$expand=Hierarchies($select=Name;
    *                  $expand=Subsets($select=Name,Expression),ElementAttributes($select=Name,Type))
    *    views      GET /Cubes?$select=Name&$expand=Views($select=Name)
    *    chores     GET /Chores?$expand=Tasks($expand=Process($select=Name))
    * Every part is optional. Returns the findings (TM1 Applications included,
    * each flagged), the summary, and the D report. */
   function scanModel(model, options) {
      var v12 = !!(options && options.v12);
      var findings = [];
      var processes = model.processes || [];
      processes.forEach(function (p) { findings = findings.concat(scanProcess(p, { v12: v12 })); });
      (model.cubes || []).forEach(function (c) {
         findings = findings.concat(scanName("Cube", c.Name));
         if (c.Rules) findings = findings.concat(scanRules(c.Name, c.Rules));
      });
      var attributes = {}, attributeTypes = {}, subsets = {}, hierarchies = {};
      (model.dimensions || []).forEach(function (d) {
         hierarchies[d.Name] = (d.Hierarchies || []).map(function (h) { return h.Name; });
         (d.Hierarchies || []).forEach(function (h) {
            if (h.Name === d.Name || !attributes[d.Name]) {
               attributes[d.Name] = (h.ElementAttributes || []).map(function (a) { return a.Name; });
               attributeTypes[d.Name] = {};
               (h.ElementAttributes || []).forEach(function (a) { if (a.Type) attributeTypes[d.Name][normName(a.Name)] = a.Type; });
            }
            subsets[d.Name] = (subsets[d.Name] || []).concat((h.Subsets || []).map(function (s) { return s.Name; }));
         });
      });
      var members = {}, he0 = model.hierarchyElements || {};
      for (var hd in he0) if (he0.hasOwnProperty(hd)) {
         var mm = members[normName(hd)] = {};
         (he0[hd] || []).forEach(function (h) {
            (h.Elements || []).forEach(function (e) { var k = normName(e.Name); (mm[k] = mm[k] || []).push(h.Name); });
         });
      }
      var ctx = { attributes: attributes, attributeTypes: attributeTypes, subsets: subsets, hierarchies: hierarchies, members: members };
      var secured = securedDimensions(model.cubes), elementRefs = [];
      var addRefs = function (mdx, use) {
         securedElementRefs(mdx, secured, ctx).forEach(function (r) { r.use = use; elementRefs.push(r); });
      };
      (model.dimensions || []).forEach(function (d) {
         findings = findings.concat(scanName("Dimension", d.Name));
         (d.Hierarchies || []).forEach(function (h) {
            (h.Subsets || []).forEach(function (s) {
               var label = h.Name === d.Name ? d.Name : d.Name + ":" + h.Name;
               scanName("Subset", s.Name, label).forEach(function (f) {
                  f.dimensionName = d.Name; f.hierarchyName = h.Name; f.subsetName = s.Name;
                  findings.push(f);
               });
               if (s.Expression) {
                  addRefs(s.Expression, { severity: "BREAKS", objectType: "Subset", object: label + " / " + s.Name, procedure: "MDX", line: null,
                     statement: s.Expression, dimensionName: d.Name, hierarchyName: h.Name, subsetName: s.Name });
                  scanMdx("Subset", label + " / " + s.Name, d.Name, s.Expression, ctx).forEach(function (f) {
                     f.dimensionName = d.Name; f.hierarchyName = h.Name; f.subsetName = s.Name;
                     findings.push(f);
                  });
               }
            });
         });
      });
      /* An MDX view's MDX goes through the subset checks (issue #4, 2026-10-09).
       * Until then only view names were read, and an MDX view the demo model
       * did not have -- FILTER on [Retailers].[Caption_Default] -- returned 10
       * rows on 11.8 and failed on 12.6.4 ("Expected a member name but found
       * Caption_Default") with nothing reported. A native view has no MDX. */
      (model.views || []).forEach(function (c) {
         (c.Views || []).forEach(function (v) {
            var label = c.Name + " / " + v.Name;
            var place = function (f) { f.cubeName = c.Name; f.viewName = v.Name; findings.push(f); };
            scanName("View", v.Name, c.Name).forEach(place);
            if (!v.MDX) return;
            addRefs(v.MDX, { severity: "BREAKS", objectType: "View", object: label, procedure: "MDX", line: null,
               statement: v.MDX, cubeName: c.Name, viewName: v.Name });
            scanMdx("View", label, null, v.MDX, ctx).forEach(place);
         });
      });
      // MDX strings built in TI (SubsetCreateByMDX / ViewCreateByMDX): the literal parts
      processes.forEach(function (p) {
         PROCEDURES.forEach(function (proc) {
            tokenize(p[proc] || "").forEach(function (tok) {
               if (tok.type !== "statement") return;
               var stmt = tok.text.replace(/^\s+|\s+$/g, "");
               joinedAncestorsAll(stmt).forEach(function (f) {
                  f.objectType = "Process"; f.object = p.Name; f.procedure = proc; f.line = tok.line; f.statement = stmt;
                  f.tm1Applications = isTM1Applications(p.Name);
                  findings.push(f);
               });
               if (!tok.calls.some(function (c) { return c.lower === "subsetcreatebymdx" || c.lower === "viewcreatebymdx"; })) return;
               var statement = tok.text.replace(/^\s+|\s+$/g, "");
               var place = function (f) {
                  f.procedure = proc; f.line = tok.line; f.statement = statement;
                  f.tm1Applications = isTM1Applications(p.Name);
                  findings.push(f);
               };
               /* Each argument that holds MDX, as TI joins it. An MDX built from
                * strings and variables (`'{[d].[' | sEl | ']}'`) was scanned one
                * literal at a time, and every piece had unbalanced brackets on its
                * own: a false BREAKS on working code (user, 2026-10-01). The pieces
                * are now checked for references only, and the brackets on the
                * joined MDX with each variable as a placeholder. */
               var pieces = [];
               /* Only the MDX argument: SubsetCreateByMDX(subset, MDX, ...) and
                * ViewCreateByMDX(cube, view, MDX, ...) -- measured with dry-run
                * compiles on v11 and 12.6.4, 2026-10-01: a 2-argument
                * ViewCreateByMDX is rejected. A subset name that looks like MDX
                * (`'[Month].[No]'`) was scanned, and rewritten, as MDX. */
               callSites(tok.text, /\b(SubsetCreateByMDX|ViewCreateByMDX)\s*\(/ig).forEach(function (site) {
                  var mdxArg = site.args[site.fn.toLowerCase() === "subsetcreatebymdx" ? 1 : 2];
                  if (!mdxArg) return;
                  [mdxArg].forEach(function (arg) {
                     var ops = concatOperands(arg.text);
                     if (!ops.some(function (o) { return o.literal !== null && /[\[\{]/.test(o.literal); })) return;
                     var whole = ops.length === 1 && ops[0].literal !== null;
                     if (!whole) {
                        var joined = ops.map(function (o) { return o.literal !== null ? o.literal : "x"; }).join("");
                        scanMdx("Process", p.Name, null, joined, ctx, "whole").forEach(function (f) {
                           f.fix = "MANUAL";
                           f.suggestion += " Checked on the MDX as TI joins it, with each variable part left out.";
                           place(f);
                        });
                     }
                     ops.forEach(function (o) {
                        var lit = o.literal;
                        if (lit === null || !/[\[\{]/.test(lit)) return;
                        // a process usually runs as an admin, which element security does not touch
                        addRefs(lit, { severity: "REVIEW", objectType: "Process", object: p.Name, procedure: proc, line: tok.line,
                           statement: statement, tm1Applications: isTM1Applications(p.Name) });
                        // .AncestorsAll is found on the joined chain (joinedAncestorsAll), which sees the whole member
                        var found = scanMdx("Process", p.Name, null, lit, ctx, whole ? null : "piece").filter(function (f) { return f.rule !== "mdx.ancestorsAll"; });
                        if (!found.length) return;
                        var fixedMdx = found.some(function (f) { return f.fix === "REWRITE"; }) ? fixMdx(lit, found) : null;
                        pieces.push({ literal: lit, fixed: fixedMdx !== lit ? fixedMdx : null, found: found });
                     });
                  });
               });
               /* One corrected statement for the whole statement, with every
                * piece's rewrite in it. Built per piece, each finding carried a
                * statement with only its own piece fixed, and Apply wrote the
                * first: `(… [d].[Numeric] >= ' | v1 | ') and ([d].[Numeric] <= ' |
                * v2 | ')` kept the second reference (user, 2026-10-01). Literals are
                * replaced in place, as TI writes them (' doubled); one that is not
                * MDX, like the subset name, is left alone. When the statement cannot
                * be rebuilt, every finding in it stays MANUAL. A chain split across
                * literals (`'[' | sDim | '].[Attr]'`) is never seen whole, so it is
                * not a finding at all. */
               var byLiteral = {}, any = false;
               pieces.forEach(function (pc) { if (pc.fixed) { byLiteral["=" + pc.literal] = pc.fixed; any = true; } });
               var fixedStatement = null;
               if (any) {
                  var n = 0;
                  var rebuilt = statement.replace(/'((?:[^']|'')*)'/g, function (all, body) {
                     var fixed = byLiteral["=" + body.replace(/''/g, "'")];
                     if (fixed === undefined) return all;
                     n++;
                     return "'" + fixed.replace(/'/g, "''") + "'";
                  });
                  if (n) fixedStatement = rebuilt;
               }
               pieces.forEach(function (pc) {
                  pc.found.forEach(function (f) {
                     f.fix = f.fix === "REWRITE" && !!fixedStatement ? "REWRITE" : "MANUAL";
                     if (pc.fixed) { f.fixedMdx = pc.fixed; f.fixedStatement = fixedStatement; }
                     place(f);
                  });
               });
            });
         });
      });
      /* MDX assembled across statements. A finding the per-statement scan already
       * made on the same line (a piece written in the call itself) is not repeated. */
      var seenTi = {};
      findings.forEach(function (f) { if (f.objectType === "Process" && f.procedure) seenTi[[f.object, f.procedure, f.line, f.rule, f.match || ""].join("\u0001")] = true; });
      processes.forEach(function (p) {
         crossStatementMdx(p, ctx).forEach(function (f) {
            if (!seenTi[[f.object, f.procedure, f.line, f.rule, f.match || ""].join("\u0001")]) findings.push(f);
         });
      });
      // element-type conflicts, for the dimensions the directive read elements of
      var he = model.hierarchyElements || {};
      for (var dn in he) if (he.hasOwnProperty(dn)) findings = findings.concat(elementTypeConflicts(dn, he[dn]));
      refuseUnfixable(processes, findings, v12);
      var dropped = droppedProcesses(findings);
      var edges = processEdges(processes, model.chores);
      var uses = usesRemoved(edges, dropped, v12);
      uses.forEach(function (u) { u.tm1Applications = u.objectType === "Process" && isTM1Applications(u.object); });
      findings = findings.concat(uses);
      findings.forEach(function (f) {
         f.deprecated = f.objectType === "Process" && !!dropped[f.object];
         if (f.tm1Applications === undefined) f.tm1Applications = false;
         f.bedrock = f.objectType === "Process" && !!bedrockKind(f.object);
         if (v12 && f.suggestion) f.suggestion = v12Suggestion(f.suggestion);
      });
      return {
         findings: sortFindings(findings),
         summary: summarise(findings),
         dropped: dropped,
         edges: edges,
         usesRemoved: uses,
         elementRefs: elementRefs
      };
   }

   /* One grouped row for TM1 Applications (}tp_*): 125 of the demo model's 159
    * processes are these, and TM1 Applications does not exist in TM1 Database
    * 12, so the decision is to retire the application, not to fix each process. */
   function tm1ApplicationsGroup(findings) {
      var procs = {}, n = 0, blockers = 0;
      findings.forEach(function (f) {
         if (!f.tm1Applications) return;
         n++;
         if (f.severity === "BLOCKER") blockers++;
         procs[f.object] = true;
      });
      if (!n) return null;
      return {
         rule: "apps.tm1Applications", severity: "REVIEW", objectType: "TM1 Applications", object: "}tp_* processes",
         procedure: null, line: null, fix: "MANUAL", count: n, blockers: blockers, processes: Object.keys(procs).length,
         statement: Object.keys(procs).length + " processes, " + n + " findings (" + blockers + " BLOCKER)",
         suggestion: "TM1 Applications (Contributor) does not exist in TM1 v12. Decide whether the application is retired: " +
            "if so, delete its }tp_* objects before migrating (the TM1 Applications tab does it, after a backup) rather than fixing them one by one."
      };
   }

   /* The same for Bedrock: a Bedrock process is not fixed finding by finding
    * but replaced by its Bedrock 5 release, on the TM1 12 database. */
   function bedrockGroup(findings) {
      var procs = {}, n = 0, blockers = 0;
      findings.forEach(function (f) {
         if (!f.bedrock) return;
         n++;
         if (f.severity === "BLOCKER") blockers++;
         procs[f.object] = true;
      });
      if (!n) return null;
      return {
         rule: "bedrock.group", severity: "REVIEW", objectType: "Bedrock", object: "}bedrock.* processes",
         procedure: null, line: null, fix: "MANUAL", count: n, blockers: blockers, processes: Object.keys(procs).length,
         statement: Object.keys(procs).length + " processes, " + n + " findings (" + blockers + " BLOCKER)",
         suggestion: "Bedrock processes are not fixed one by one: Bedrock 5 is the release for TM1 v12. " +
            "On the TM1 12 database, the Bedrock tab upgrades them to Bedrock 5 and deletes the ones nothing uses."
      };
   }

   /* The body for a dry-run compile of a (possibly unsaved) process: the
    * procedures plus the real Parameters and Variables, because without them
    * every parameter and data variable reads as undefined. The data source is
    * sent as None so a file source that does not exist on the target is not
    * what fails. */
   function compileBody(process, procedures) {
      var src = procedures || process;
      return {
         Process: {
            Name: process.Name,
            PrologProcedure: src.PrologProcedure || "",
            MetadataProcedure: src.MetadataProcedure || "",
            DataProcedure: src.DataProcedure || "",
            EpilogProcedure: src.EpilogProcedure || "",
            Parameters: process.Parameters || [],
            Variables: process.Variables || [],
            DataSource: { Type: "None" }
         }
      };
   }

   // ---------------------------------------------------------------------------
   // tm1s.cfg
   // ---------------------------------------------------------------------------

   /* The 149 parameters IBM lists as not supported in TM1 v12
    * (c_pae_deprecated_features.html). The REST ActiveConfiguration returns
    * nested JSON, not these names (§2.2 row 0.8), so the check reads the file. */
   var CFG_UNSUPPORTED = ("AdminHost AdminSvrSSLCertID AdminSvrSSLCertAuthority AdminSvrSSLCertRevList AdminSvrSSLExportKeyID " +
      "AllowedInvalidXNLogRecLimit ApplyMaximumViewSizeToEntireTransaction CAMPortalVariableFile CAMSSLCertificate CAMUseSSL " +
      "CacheFriendlyMalloc CheckCAMClientAlias ClientCAMURI ClientExportSSLSvrCert ClientExportSSLSvrKeyID " +
      "ClientMessageListenerAcceptsTm1TopConnections ClientMessagePortNumber ClientPingCAMPassport ClientPropertiesSyncInterval " +
      "ClientVersionMaximum ClientVersionMinimum ClientVersionPrecision CognosTM1InterfacePath CreateNewCAMClients DebugDatabaseLock " +
      "DefaultMeasuresDimension DHFile-512 DHFile-1024 DHFile-2048 DisableExecuteCommandTI DisableMemoryCache " +
      "DistributedPlanningOutputDir Downtime EnableBatchCellIncrement EnableODBCProxy EnableNewHierarchyCreation " +
      "EnableSandboxTransactionLog EncryptData ExcelWebPublishEnabled ExportAdminSvrSSLCert ExportSvrSSLCert " +
      "HTTPRequestEntityMaxSizeInKB HTTPOriginAllowList HTTPOriginWhitelist HTTPHostUri HTTPPortNumber HTTPSessionTimeoutMinutes " +
      "IdleConnectionTimeOutSeconds IndexStoreDirectory IntegratedSecurityMode IPAddress IPVersion JavaClassPath JavaJVMPath " +
      "JavaJVMArgs KeepPrivateSubsetsLoaded LDAPHost LDAPPasswordFile LDAPPasswordKeyFile LDAPPort LDAPSearchBase LDAPSearchField " +
      "LDAPSkipSSLCertVerification LDAPSkipSSLCRLVerification LDAPUseServerAccount LDAPVerifyCertServerName LDAPVerifyServerSSLCert " +
      "LDAPWellKnownUserName LicenseMetricTime LicenseMetricProductName LicenseMetricProductVersion LicenseMetricProductReleaseID " +
      "LoadPrivateSubsetsOnStartup LoadPublicViewsAndSubsetsAtStartup LockPagesInMemory LogReleaseLineCount LogMemoryAllocation " +
      "MaskUserNameInServerTools MaximumLoginAttempts MaximumSynchAttempts MaximumViewSize MaxUDCCacheSize MemoryCacheMaxBlockSize " +
      "MemoryWarningLevelKb MemoryWarningLevelMsg MinBreatherThreadCount MDXAggregateForceSetAlgorithm " +
      "MDXSelectCalculatedMemberInputs MessageCompression MTQ.EnableParallelFacetQuery NetRecvBlockingWaitLimitSeconds " +
      "NetRecvMaxClientIOWaitWithinAPIsSeconds NWSapCharacteristicRowcount NWSapCharacteristicMethod NWSapInfoCubeExtractMethod " +
      "ODBCCatalogName ODBCDataSource ODBCLibraryPath ODBCPassword ODBCUserName OracleErrorForceRowStatus " +
      "OracleErrorUnicodeDateCharacterWorkaround ParallelInteraction PasswordMinimumLength PasswordSource PerformanceMonitorOn " +
      "PerfMonIsActive PooledMemoryMaxLimit PooledMemoryWarningThreshold PortNumber ProfileBasedOptimization ProgressMessage " +
      "PullInvalidationSubsets RawStoreDirectory ReceiveProgressResponseTimeoutSecs RulesOverwriteCellsOnLoad RunningInBackground " +
      "Savetime SecurityPackageName ServerCAMURI ServerCAMURIRetryAttempts ServerLogging ServerName ServicePrincipalName " +
      "SkipLoadingAliases SkipSSLCAMHostCheck SliceApprovalDimension SliceCubeThreads SSLCertAuthority SSLCertificate " +
      "SSLCertificateID SSLCertRevocationFile SSLPrivateKeyPwdFile SSLPwdKeyFile StartupChores SubsetElementBreatherCount " +
      "SvrSSLExportKeyID SyncUnitSize TM1ConnectorforSAP TrackMemoryPools TransactionLogSearchOptimization UseCognosMDXEngine " +
      "UseLocalCopiesForPublicDynamicSubsets UseSQLFetch UseSQLFetchScroll UseSQLExtendedFetch UseSSL VersionedListControlDimensions " +
      "WANProxyHost").split(" ");

   var CFG_NOTES = {
      maximumviewsize: "Replaced by MaximumSingleQueryMemorySizeMB and MaximumGlobalQueryMemorySizeMB (both default 0, off).",
      disablesandboxing: "Removed in 12.5: sandboxing cannot be turned off.",
      loadpublicviewsandsubsetsatstartup: "IBM lists it both as supported and as not supported; review.",
      supportprotocoltlsv13: "On IBM's supported list, but its own page says it does not apply to TM1 12; review.",
      startupchores: "Chores are rebuilt and scheduled in PAW.",
      integratedsecuritymode: "Identity comes from the identity provider (IBMid / OIDC).",
      httpportnumber: "PA as a Service owns the endpoint.",
      portnumber: "PA as a Service owns the endpoint.",
      databasedirectory: null
   };

   /* `GET /StaticConfiguration` is the server's tm1s.cfg as nested JSON, and a
    * parameter the file does not set comes back null (measured on GO_New_Stores
    * 11.8.027: 14 non-null leaves, every other one null). So the check needs no
    * file: flatten the JSON, keep what is set, and give each leaf its tm1s.cfg
    * name. The leaf name is the cfg name unless it is listed here; under
    * Access.LDAP the cfg name is the leaf with an `LDAP` prefix. */
   var CFG_REST_NAMES = {
      "Access.Network.NetRecvBlockingWaitLimit": "NetRecvBlockingWaitLimitSeconds",
      "Access.Network.NetRecvMaxClientIOWaitWithinAPIs": "NetRecvMaxClientIOWaitWithinAPIsSeconds",
      "Access.Network.IdleConnectionTimeOut": "IdleConnectionTimeOutSeconds",
      "Access.Network.ReceiveProgressResponseTimeout": "ReceiveProgressResponseTimeoutSecs",
      "Access.SSL.Enable": "UseSSL",
      "Access.SSL.CertificateID": "SSLCertificateID",
      "Access.SSL.CertAuthority": "SSLCertAuthority",
      "Access.SSL.CertRevocationFile": "SSLCertRevocationFile",
      "Access.SSL.ClientExportServerKeyID": "ClientExportSSLSvrKeyID",
      "Access.CAM.ClientURI": "ClientCAMURI",
      "Access.CAM.ServerURIs": "ServerCAMURI",
      "Access.CAM.PortalVariableFile": "CAMPortalVariableFile",
      "Access.LDAP.Enable": "PasswordSource",
      "Access.CAPI.Port": "PortNumber",
      "Access.CAPI.ClientMessagePort": "ClientMessagePortNumber",
      "Access.HTTP.Port": "HTTPPortNumber",
      "Access.HTTP.SessionTimeout": "HTTPSessionTimeoutMinutes",
      "Access.HTTP.RequestEntityMaxSizeInKB": "HTTPRequestEntityMaxSizeInKB",
      "Access.HTTP.OriginAllowList": "HTTPOriginAllowList",
      "Administration.PerfMonActive": "PerfMonIsActive",
      "Administration.DownTime": "Downtime",
      "Administration.DebugLog.LoggingDirectory": "LoggingDirectory",
      "Administration.ServerLog.Enable": "ServerLogging",
      "Administration.AuditLog.Enable": "AuditLogOn",
      "Administration.AuditLog.UpdateInterval": "AuditLogUpdateInterval",
      "Administration.AuditLog.MaxFileSizeKilobytes": "AuditLogMaxFileSize",
      "Administration.AuditLog.MaxQueryMemoryKilobytes": "AuditLogMaxQueryMemory",
      "Administration.EventLog.Enable": "EventLogging",
      "Administration.EventLog.ScanFrequency": "EventScanFrequency",
      "Administration.TopLog.Enable": "TopLogging",
      "Administration.TopLog.ScanMode": "TopScanMode",
      "Administration.TopLog.ScanFrequency": "TopScanFrequency",
      "Administration.Java.ClassPath": "JavaClassPath",
      "Administration.Java.JVMPath": "JavaJVMPath",
      "Administration.Java.JVMArgs": "JavaJVMArgs",
      "Performance.Memory.MaximumViewSizeMB": "MaximumViewSize",
      "Performance.MTCubeLoad.Enabled": "MTCubeLoad",
      "Performance.MTFeeders.Enabled": "MTFeeders",
      "Performance.MTQ.NumberOfThreadsToUse": "MTQ",
      "Performance.Locking.SubsetElementLockBreathing": "SubsetElementBreatherCount",
      "Performance.JobQueuing.Enable": "JobQueuing"
   };

   /* The REST configuration in the shape parseCfg returns. A `false` on an
    * `Enable` leaf is not counted as set: SSL and LDAP report false on a server
    * whose file names neither, so it is the default, not a line in the file. */
   function cfgFromRest(json) {
      var params = {}, order = [];
      var walk = function (obj, path) {
         Object.keys(obj || {}).forEach(function (k) {
            if (k.charAt(0) === "@" || (!path && k === "ServerName")) return;   // ServerName also sits under Administration
            var v = obj[k], p = path ? path + "." + k : k;
            if (v && typeof v === "object" && !Array.isArray(v)) return walk(v, p);
            if (v === null || v === "" || (Array.isArray(v) && !v.length) || (v === false && k === "Enable")) return;
            var name = CFG_REST_NAMES[p] || (/^Access\.LDAP\./.test(p) ? "LDAP" + k : k);
            var key = name.toLowerCase();
            if (params[key]) return;
            params[key] = { name: name, value: Array.isArray(v) ? v.join(",") : String(v), line: null, path: p };
            order.push(key);
         });
      };
      walk(json, "");
      return { params: params, order: order };
   }

   /* key = value lines under [TM1S]; `#` and `;` start comments. */
   function parseCfg(text) {
      var params = {}, order = [];
      String(text || "").replace(/^﻿/, "").split(/\r?\n/).forEach(function (line, i) {
         var l = line.replace(/^\s+|\s+$/g, "");
         if (!l || l.charAt(0) === "#" || l.charAt(0) === ";" || l.charAt(0) === "[") return;
         var eq = l.indexOf("=");
         if (eq < 0) return;
         var k = l.substring(0, eq).replace(/\s+$/, ""), v = l.substring(eq + 1).replace(/^\s+/, "");
         params[k.toLowerCase()] = { name: k, value: v, line: i + 1 };
         order.push(k.toLowerCase());
      });
      return { params: params, order: order };
   }

   /* `input` is the file's text, or what cfgFromRest returned. */
   function checkCfg(input) {
      var cfg = typeof input === "string" ? parseCfg(input) : input, findings = [];
      var unsupported = {};
      CFG_UNSUPPORTED.forEach(function (n) { unsupported[n.toLowerCase()] = n; });
      cfg.order.forEach(function (k) {
         var p = cfg.params[k];
         if (unsupported[k] || k === "disablesandboxing" || k === "supportprotocoltlsv13") {
            var review = k === "loadpublicviewsandsubsetsatstartup" || k === "supportprotocoltlsv13";
            findings.push({ rule: "cfg.unsupported", severity: review ? "REVIEW" : "INFO", objectType: "tm1s.cfg", object: p.name,
               procedure: null, line: p.line, statement: p.name + "=" + p.value, fix: "CONFIG",
               suggestion: CFG_NOTES[k] || "Not supported in TM1 v12; on PA as a Service, configuration is set in PA Administration." });
         }
      });
      if (!cfg.params.databasedirectory) {
         findings.push({ rule: "cfg.databaseDirectory", severity: "BLOCKER", objectType: "tm1s.cfg", object: "DatabaseDirectory",
            procedure: null, line: null, statement: "", fix: "CONFIG",
            suggestion: "The migration utility needs DatabaseDirectory in tm1s.cfg (relative to the cfg file)." });
      }
      return { findings: findings, count: cfg.order.length,
         databaseDirectory: cfg.params.databasedirectory ? cfg.params.databasedirectory.value : null,
         blocked: findings.some(function (f) { return f.severity === "BLOCKER"; }),
         review: findings.some(function (f) { return f.severity === "REVIEW"; }),
         unsupported: findings.filter(function (f) { return f.rule === "cfg.unsupported"; }).length };
   }

   // ---------------------------------------------------------------------------
   // migrate.log
   // ---------------------------------------------------------------------------

   /* The utility's --input is the folder that holds tm1s.cfg, which REST does
    * not name. `/Configuration` gives DataBaseDirectory resolved against it
    * ("…\GO_New_Stores\configuration\../datafiles") and StaticConfiguration the
    * file's own value ("../datafiles"), so the folder is what precedes the
    * file's value. An absolute DataBaseDirectory in the file leaves no trace of
    * the folder: then the command says so instead of guessing. */
   function migrateCommand(fileDir, resolvedDir, serverName) {
      var norm = function (s) { return String(s || "").replace(/\//g, "\\").toLowerCase(); };
      var cfgDir = null, f = norm(fileDir), r = norm(resolvedDir);
      if (f && r.length > f.length + 1 && r.slice(-f.length) === f && r.charAt(r.length - f.length - 1) === "\\")
         cfgDir = String(resolvedDir).slice(0, resolvedDir.length - f.length - 1);
      var name = serverName || "model";
      return { cfgDir: cfgDir, name: name, command: migrateCommandLine(cfgDir, name) };
   }

   /* The command with the two folders the user may type (user, 2026-10-06): where the utility is
    * (its bin64) and where the .tgz and the log go. Typed, not picked: they are on the v11 host,
    * which a browser cannot see. A Windows folder (a drive or a backslash) joins with "\", any
    * other with "/". With neither, the command is as before: run from bin64, outputs beside it. */
   function migrateCommandLine(cfgDir, name, dirs) {
      var clean = function (d) { return String(d || "").replace(/^\s+|\s+$/g, "").replace(/^"|"$/g, "").replace(/[\\\/]+$/, ""); };
      var join = function (dir, file) { return dir ? dir + (/^[A-Za-z]:|\\/.test(dir) ? "\\" : "/") + file : file; };
      var tool = clean(dirs && dirs.utility), out = clean(dirs && dirs.output);
      var exe = tool ? "\"" + join(tool, "migrate_tm1") + "\"" : "migrate_tm1";
      return exe + " --input \"" + (cfgDir || "<folder containing tm1s.cfg>") + "\" --output \"" + join(out, name + ".tgz") +
         "\" --log-to-file \"" + join(out, name + "-migrate.log") + "\"";
   }

   /* The utility's log is JSON lines ({"level","message",...}, logger
    * TM1.Migration). Read against a real 12.6.4 run on GO_New_Stores (plan
    * §2.12), which corrected three assumptions the IBM example had allowed:
    *  - `processes` is only what TM1 12 will not compile (an error line with
    *    `process` and `errors`). `ErroredProcess` in the summary lists the
    *    processes whose data-source file was not found -- they migrate and
    *    compile, and only need the file -- so it goes to `dataSource`.
    *  - the file written by --log-to-file ends at "was migrated [with
    *    problems]" and never carries "Backup file successfully created!" or
    *    "Migration has been successfully completed!": those go to the console
    *    only, on runs that did write the backup. So `finished` is read from the
    *    model line, and `backup` is null in every log file seen so far.
    *  - the warnings worth a line of their own are few and known (`notes`);
    *    the rest are counted.
    * Tolerant still: a line that does not parse is kept as text. */
   var GROUP_CLOUDID_NOTE = "}GroupProperties was not found, so groups migrate without a CloudID. Create it on the CloudID tab (Groups) if your groups need one.";
   var LOG_NOTES = [
      [/^Unable to find the dimension file/i, "dimension", function (o) { return /^\}GroupProperties$/i.test(o) ? GROUP_CLOUDID_NOTE : null; }],
      [/^unable to open file during cube load/i, "cube", function (o) { return /^\}GroupProperties$/i.test(o) ? GROUP_CLOUDID_NOTE : null; }],
      [/^Feeder file error|^Existing feeder files cannot be migrated/i, null, function () {
         return "The feeder files are in an old format and are not migrated: TM1 12 rebuilds the feeders from the rules, so a rule-calculated cell that only the old feeder files kept fed drops out of NON EMPTY views (on GO_New_Stores, 120 New Store Index cells, whose rule has no feeder). Check that every rule that needs one has a feeder before cutover. (Saving data on 11.8 did not rewrite the files, despite the utility README, step 8.)"; }]
   ];

   function parseMigrateLog(text) {
      var out = { lines: 0, errors: [], warnings: [], processes: {}, dataSource: {}, notes: [], summary: [], warnCounts: {},
         failedCubes: [], unknownFiles: [], subsetElements: [], unparsed: 0, completed: false, finished: null, backup: null, memory: null };
      var noted = {};
      var note = function (s) { if (s && !noted[s]) { noted[s] = true; out.notes.push(s); } };
      String(text || "").split(/\r?\n/).forEach(function (line) {
         if (!/\S/.test(line)) return;
         out.lines++;
         var j;
         try { j = JSON.parse(line); } catch (e) { out.unparsed++; if (/error/i.test(line)) out.errors.push({ message: line.slice(0, 400) }); return; }
         var level = String(j.level || "").toLowerCase(), msg = String(j.message || "");
         if (/successfully completed/i.test(msg)) { out.completed = true; out.finished = out.finished || "clean"; }
         var fin = /^Model .* was migrated( with problems)?/i.exec(msg);
         if (fin) { out.completed = true; out.finished = fin[1] ? "problems" : "clean"; }
         if (/^Backup file successfully created/i.test(msg)) out.backup = { file: j.file || null, sizeKB: j["size(KB)"] || null };
         if (/^Memory used/i.test(msg)) out.memory = msg;
         if (/^\d+ (\w+ )?Objects? (in total )?successfully migrated$/i.test(msg) || /^\d+ Objects processed with problem/i.test(msg)) out.summary.push(msg);
         if (j.process && j.errors) {
            out.processes[j.process] = (out.processes[j.process] || []).concat(j.errors.map(function (e) {
               return { region: e.region, type: e.type, line: e.line, details: e.details };
            }));
         }
         var ds = /^Process (.+?) processed with errors: (.*)$/.exec(msg);
         if (ds) out.dataSource[j.name || ds[1]] = ds[2];
         (j.ErroredProcess || []).forEach(function (p) { if (!out.processes[p] && !out.dataSource[p]) out.dataSource[p] = ""; });
         (j.FailedCube || []).forEach(function (c) { out.failedCubes.push(c); });
         if (/Unknown file/i.test(msg) && j.file) out.unknownFiles.push(j.file);
         if (level === "error") out.errors.push({ message: msg, process: j.process || null });
         else if (level === "warn" || level === "warning") {
            out.warnings.push({ message: msg });
            /* A static subset whose stored list names an element the dimension no longer has (measured on
             * GO_New_Stores, 2026-10-06: }Cubes subsets of deleted _BAK_ cubes, and language subsets of
             * Assumptions naming a missing element). v11 already drops it when it loads the subset, so TM1
             * 12 gets the subset as v11 shows it: nothing to do, but worth saying why. */
            if (/^Subset element not found/i.test(msg)) { out.subsetElements.push({ dimension: j.dimension || "", subset: j.subset || "", element: j.name || "" }); return; }
            if (!ds && !/Objects processed with problem/i.test(msg)) {
               var known = LOG_NOTES.filter(function (n) { return n[0].test(msg); })[0];
               var told = known && known[2] ? known[2](known[1] ? j[known[1]] : null) : null;
               if (told) note(told);
               else out.warnCounts[msg] = (out.warnCounts[msg] || 0) + 1;
            }
         }
      });
      return out;
   }

   /* What a read log means for the user, in one line and a short list (user, 2026-10-06: "Read log
    * doesn't summarize if he needs to do something or is clear to go"). `stop` keeps step 4 waiting,
    * `todo` is for the user before or after it, `after` is done by the plugin on TM1 12 (Data files),
    * `fine` says why a warning needs nothing. Ready = no stop; the page shows the rest as a list. */
   function migrateVerdict(log, compare, extra) {
      var items = [], n = function (k, one, many) { return k + " " + (k === 1 ? one : many); };
      var procs = Object.keys(log.processes || {}), ds = Object.keys(log.dataSource || {});
      var loose = (log.errors || []).filter(function (e) { return !e.process; });
      if (!log.finished) items.push({ kind: "stop", text: "The run did not finish: the log stops before the model's last line. Run the command again and read the new log." });
      if ((log.failedCubes || []).length) items.push({ kind: "stop", text: n(log.failedCubes.length, "cube", "cubes") + " did not migrate: " + log.failedCubes.slice(0, 5).join(", ") + ". Fix them on v11 and convert again." });
      if (loose.length) items.push({ kind: "stop", text: n(loose.length, "error line", "error lines") + " not tied to a process: read them in the log before step 4." });
      if (procs.length) items.push({ kind: "todo", text: procs.length === 1
         ? "1 process will not compile on TM1 12 (listed below). It migrates as it is: fix it on v11 and convert again, or with Apply on TM1 12."
         : procs.length + " processes will not compile on TM1 12 (listed below). They migrate as they are: fix them on v11 and convert again, or with Apply on TM1 12." });
      if (compare && compare.notPredicted.length) items.push({ kind: "todo", text: n(compare.notPredicted.length, "process", "processes") + " the scan did not predict: " + compare.notPredicted.slice(0, 5).join(", ") + ". Scan again: something changed since the scan." });
      if (ds.length) items.push({ kind: "after", text: ds.length === 1
         ? "1 process needs its data file on TM1 12: the Data files tab uploads it and points the process at it (step 5)."
         : ds.length + " processes need their data files on TM1 12: the Data files tab uploads them and points each process at its file (step 5)." });
      // the feeder note is to do: measured, cells without a feeder drop out of NON EMPTY on TM1 12 (plan §2.13)
      (log.notes || []).forEach(function (t) { items.push({ kind: /CloudID tab|NON EMPTY/.test(t) ? "todo" : "fine", text: t }); });
      if ((log.subsetElements || []).length) {
         var subs = log.subsetElements, ex = subs[0];
         var where = " (" + ex.dimension + " / " + ex.subset + (subs.length > 1 ? ", and " + (subs.length - 1) + " more" : "") + ")";
         items.push({ kind: "fine", text: subs.length === 1
            ? "1 subset lists an element its dimension no longer has" + where + ". v11 already leaves it out, so TM1 12 gets the subset as v11 shows it now: nothing to do. To tidy up, re-save or delete it on v11."
            : subs.length + " subsets list an element their dimension no longer has" + where + ". v11 already leaves those out, so TM1 12 gets the subsets as v11 shows them now: nothing to do. To tidy up, re-save or delete them on v11." });
      }
      // read from the project's migration folder, the plugin can look for the .tgz itself
      if (log.finished && !log.backup && extra && extra.tgz === true) items.push({ kind: "fine", text: "The .tgz file is in the project's migration folder." });
      else if (log.finished && !log.backup && extra && extra.tgz === false) items.push({ kind: "todo", text: "No .tgz file in the project's migration folder: check where the utility wrote it, or run it again." });
      else if (log.finished && !log.backup) items.push({ kind: "todo", text: "Check that the .tgz file was written: the utility says so on the console only, never in the log." });
      var stops = items.filter(function (i) { return i.kind === "stop"; }).length, todos = items.filter(function (i) { return i.kind === "todo" || i.kind === "after"; }).length;
      return { level: stops ? "stop" : todos ? "todo" : "ready", stops: stops, todos: todos, items: items };
   }

   /* The log's verdict against the scan's: a process the utility dropped
    * that the scan did not predict is the case that matters. */
   function compareLog(log, findings) {
      var predicted = droppedProcesses(findings);
      var dropped = Object.keys(log.processes);
      return {
         dropped: dropped,
         notPredicted: dropped.filter(function (p) { return !findName(predicted, p); }),
         predictedNotInLog: Object.keys(predicted).filter(function (p) { return dropped.map(normName).indexOf(normName(p)) < 0; })
      };
   }

   // ---------------------------------------------------------------------------
   // Fix catalogue: what each automated fix has been shown to do
   // ---------------------------------------------------------------------------

   /* One record per fix rule, from FIX-VALIDATION-PLAN pass 1 (plan §2.13).
    * Levels: L0 detected by the scan, the utility and the TM1 12 compiler;
    * L1 the fixed process compiles and runs on v11 with no new failure; L2 the
    * utility no longer reports it; L3 it compiles on TM1 12; L4 it runs on TM1
    * 12 with the same status as on v11; L5 the same result as v11 -- cube data
    * compared, a canary's own assertion, or, for an effect the platform takes
    * over, "argued" with the source named. "model" evidence is GO_New_Stores'
    * own processes; "canary" is a small process written for the variant,
    * counted only after it compiled and ran on v11. A record holds for the
    * versions in `verifiedWith` and is shown as unverified for any other
    * utility or TM1 12 build. Demo data only. */
   var FIX_VERIFIED_WITH = { plugin: "0.6.0", utility: "12.6.4", tm1v12: "12.6.4", tm1v11: "11.8.02700.4", model: "GO_New_Stores", date: "2026-10-03" };
   var FIX_CATALOGUE = [
      { id: "ti.removed:cubesetlogchanges", fix: "REMOVE", level: 5, evidence: "model", fixtures: ["19 GO_New_Stores imports", "canaries c01 c04 c07 c08"],
        l5: "cube data equal on 8 of 8 comparable cubes; logging itself is platform-managed (argued: IBM, transaction logging in TM1 v12)" },
      { id: "ti.removed:cubegetlogchanges", fix: "REMOVE", level: 5, evidence: "model", fixtures: ["GO_New_Stores imports", "canary c04"],
        l5: "removed with its dependency chain; a variable it set that is read in a condition is refused, not half-fixed (canary c05)" },
      { id: "ti.removed:refreshmdxhierarchy", fix: "REMOVE", level: 5, evidence: "model", fixtures: ["GO_New_Stores imports", "canaries c18 c19"],
        l5: "cube data and every dimension's element count equal; the refresh is the engine's on TM1 12 (argued: IBM documents no replacement)" },
      { id: "control.removed:}hierarchyproperties", fix: "REMOVE", level: 5, evidence: "model", fixtures: ["19 GO_New_Stores imports", "canary c16"],
        l5: "the cube is 404 on TM1 12 (measured); dimensions equal after the imports ran on both" },
      { id: "control.removed:}cubeproperties", fix: "REMOVE", level: 5, evidence: "model", fixtures: ["6 GO_New_Stores imports"],
        l5: "the cube is 404 on TM1 12 (measured); cube data equal", followUp: "Set the cube's MeasuresDimension (and any other setting the write carried) once as a REST cube property on TM1 12." },
      { id: "ti.dataSourcePath", fix: "DATAFILES", level: 5, evidence: "model", fixtures: ["28 GO_New_Stores imports"],
        l5: "28 files uploaded byte for byte; the same run statuses as v11, and import_SalesPlan, which aborts on v11 for a D:\\ file, completes", followUp: "Done on TM1 12 by the Data files tab." },
      { id: "ti.removed:cubesavedata", fix: "REMOVE", level: 4, evidence: "canary", fixtures: ["canary c09"], l5: "persistence is the engine's on TM1 12 (argued: IBM)" },
      { id: "ti.removed:lockon", fix: "REMOVE", level: 4, evidence: "canary", fixtures: ["canary c10"] },
      { id: "ti.removed:lockoff", fix: "REMOVE", level: 4, evidence: "canary", fixtures: ["canary c10"] },
      { id: "ti.removed:batchupdatestart", fix: "REMOVE", level: 4, evidence: "canary", fixtures: ["canary c11"] },
      { id: "ti.removed:batchupdatefinish", fix: "REMOVE", level: 4, evidence: "canary", fixtures: ["canary c11"] },
      { id: "ti.removed:enablepersonalworkspace", fix: "REMOVE", level: 4, evidence: "canary", fixtures: ["canary c13", "found in }tp_initialize_session by the utility"] },
      { id: "ti.removed:executecommand", fix: "STUB", level: 4, evidence: "canary", fixtures: ["canary c12"],
        followUp: "The process runs, but without the command: complete the ExecuteHttpRequest stub after cutover." },
      { id: "ti.splitName", fix: "REWRITE", level: 5, evidence: "canary", fixtures: ["canary c14", "found in }tp_incr_deploy_application_security by the utility"],
        l5: "the canary asserts the joined name's value at run time, and completed on v11 and TM1 12" },
      { id: "tm1Applications.delete", fix: "DELETE", level: 2, evidence: "model", fixtures: ["168 GO_New_Stores }tp_ objects"],
        l5: "the utility reports no }tp_ process after the delete", followUp: "9 cubes refuse a cell read even to Admin: they are backed up without cells, behind an extra tick." }
   ];
   var fixCatalogueById = {};
   FIX_CATALOGUE.forEach(function (r) { fixCatalogueById[r.id.toLowerCase()] = r; });

   /* The catalogue record behind a finding, or null. */
   function fixEvidence(f) {
      if (!f) return null;
      var key = f.rule === "ti.removed" ? "ti.removed:" + String(f.function || "").toLowerCase()
         : f.rule === "control.removed" ? "control.removed:" + String(f.referenced || "").toLowerCase()
         : f.rule === "ti.dataSourcePath" ? "ti.dataSourcePath" : f.rule;
      return fixCatalogueById[String(key).toLowerCase()] || null;
   }

   // ---------------------------------------------------------------------------
   // Where used (Arc's tree menu: process, cube, dimension)
   // ---------------------------------------------------------------------------

   var SEVERITY_RANK = { BLOCKER: 4, BREAKS: 3, REVIEW: 2, INFO: 1 };

   /* Every place the scanned model refers to a process, cube or dimension by
    * name, with the referring object's worst finding -- so "where used" also
    * says which users break on TM1 12. Read from the scan's own model, so it
    * costs no request:
    *  - TI: ExecuteProcess / RunProcess targets (a process), any statement
    *    with a string literal equal to the name (a cube or dimension: CellPutN,
    *    DimensionElementInsert, ViewCreate ...), and the process's data source;
    *  - chores: their tasks (a process);
    *  - cubes: their dimensions (a dimension), and rule or feeder lines with
    *    a string literal equal to the name (DB('Cube', ...), ATTRS('Dim', ...)).
    * Names compare without case, as TM1 does. A computed name (`'x' | v`) is
    * not followed, and the panel says so. A cube's own rules are not a use of
    * that cube. */
   function whereUsed(model, findings, type, name) {
      var low = String(name || "").toLowerCase(), refs = [];
      var worst = {};
      (findings || []).forEach(function (f) {
         var k = f.objectType + "\u0001" + String(f.object).toLowerCase();
         if (!worst[k] || SEVERITY_RANK[f.severity] > SEVERITY_RANK[worst[k]]) worst[k] = f.severity;
      });
      var add = function (r) {
         var objType = r.fromType === "Cube" ? "Rules" : r.fromType;
         r.status = worst[objType + "\u0001" + String(r.from).toLowerCase()] || worst[r.fromType + "\u0001" + String(r.from).toLowerCase()] || null;
         refs.push(r);
      };
      (model.processes || []).forEach(function (p) {
         if (type === "Process" && String(p.Name).toLowerCase() === low) return;
         PROCEDURES.forEach(function (proc) {
            tokenize(p[proc] || "").forEach(function (tok) {
               if (tok.type !== "statement") return;
               var text = tok.text.replace(/^\s+|\s+$/g, "");
               if (type === "Process") {
                  tok.calls.forEach(function (c) {
                     if ((c.lower === "executeprocess" || c.lower === "runprocess") && c.firstLiteral !== null && String(c.firstLiteral).toLowerCase() === low)
                        add({ fromType: "Process", from: p.Name, where: PROCEDURE_LABEL[proc] + " " + tok.line, how: c.name, statement: text });
                  });
                  return;
               }
               // a literal inside a | chain builds another name: not a use of this one
               var chained = function (l) {
                  var q = "'" + String(l).replace(/'/g, "''").replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "'";
                  return new RegExp("\\|\\s*" + q + "|" + q + "\\s*\\|", "i").test(tok.text);
               };
               if ((tok.literals || []).some(function (l) { return String(l).toLowerCase() === low && !chained(l); })) {
                  // name the function, not IF / WHILE: those only say it is a condition
                  var fn = tok.calls.filter(function (c) { return !/^(if|elseif|while)$/.test(c.lower); })[0];
                  add({ fromType: "Process", from: p.Name, where: PROCEDURE_LABEL[proc] + " " + tok.line,
                     how: fn ? fn.name + (tok.keyword ? " (in a condition)" : "") : tok.keyword ? "condition" : "assignment", statement: text });
               }
            });
         });
         var ds = p.DataSource || {};
         if (ds.dataSourceNameForServer && String(ds.dataSourceNameForServer).toLowerCase() === low &&
            ((type === "Cube" && ds.Type === "TM1CubeView") || (type === "Dimension" && ds.Type === "TM1DimensionSubset"))) {
            add({ fromType: "Process", from: p.Name, where: "Data source", how: ds.Type === "TM1CubeView" ? "view " + (ds.dataSourceNameForClient || "") : "subset " + (ds.dataSourceNameForClient || ""), statement: "" });
         }
      });
      if (type === "Process") {
         (model.chores || []).forEach(function (ch) {
            (ch.Tasks || []).forEach(function (tk, k) {
               var target = tk.Process && tk.Process.Name;
               if (target && String(target).toLowerCase() === low) add({ fromType: "Chore", from: ch.Name, where: "Task " + (k + 1), how: "runs it", statement: "" });
            });
         });
      }
      if (type === "Cube" || type === "Dimension") {
         (model.cubes || []).forEach(function (c) {
            if (type === "Dimension" && (c.Dimensions || []).some(function (d) { return String(d.Name).toLowerCase() === low; })) {
               add({ fromType: "Cube", from: c.Name, where: "Structure", how: "dimension of the cube", statement: "" });
            }
            if (type === "Cube" && String(c.Name).toLowerCase() === low) return;
            var feeders = false;
            String(c.Rules || "").split(/\r?\n/).forEach(function (line, i) {
               if (/^\s*FEEDERS\s*;/i.test(line)) feeders = true;
               if (/^\s*#/.test(line)) return;
               var m, re = /'((?:[^']|'')*)'/g;
               while ((m = re.exec(line)) !== null) {
                  if (m[1].replace(/''/g, "'").toLowerCase() === low) {
                     add({ fromType: "Cube", from: c.Name, where: (feeders ? "Feeder" : "Rule") + " line " + (i + 1), how: /\bDB\s*\(/i.test(line) ? "DB()" : "named in a rule", statement: line.replace(/^\s+|\s+$/g, "") });
                     break;
                  }
               }
            });
         });
      }
      return refs;
   }

   /* The references grouped by referring object, in first-seen order, so one
    * process with thirty statements is one row with thirty lines under it. */
   function groupWhereUsed(refs) {
      var out = [], at = {};
      (refs || []).forEach(function (r) {
         var k = r.fromType + "\u0001" + String(r.from).toLowerCase();
         if (!at.hasOwnProperty(k)) { at[k] = out.length; out.push({ fromType: r.fromType, from: r.from, status: r.status, refs: [] }); }
         out[at[k]].refs.push(r);
      });
      out.forEach(function (g, i) {
         var hows = [];
         g.refs.forEach(function (r) { if (hows.indexOf(r.how) < 0) hows.push(r.how); });
         g.hows = hows;
         g.order = i;
      });
      // TM1's own control objects (}ElementAttributes_, }ICube_ ...) after the model's
      return out.sort(function (a, b) { return (/^\}/.test(a.from) - /^\}/.test(b.from)) || (a.order - b.order); });
   }

   // ---------------------------------------------------------------------------
   // Diagnostics log: technical trace for support, model details scrubbed
   // ---------------------------------------------------------------------------

   /* The user picks one mode before anything is recorded (user, 2026-10-03):
    * "off"; "pseudonym" -- each name becomes a stable token such as Process#3,
    * so steps on one object can still be followed; "removed" -- a name
    * becomes its type; "full" -- kept as is. Free text (TM1 error messages,
    * log lines) is scrubbed too: quoted strings, file paths, and the names of
    * the model's processes, cubes, dimensions and chores. Short names (under
    * four characters) are only scrubbed where they are quoted, because "All"
    * or "Sep" would otherwise eat ordinary words. The pseudonym map stays in
    * the browser; it is never part of the download. */
   var DIAG_MODES = ["off", "pseudonym", "removed", "full"];

   function diagIndex(model, extra) {
      var idx = {};
      var put = function (type, n) { if (n) idx[String(n).toLowerCase()] = { type: type, name: String(n) }; };
      (model && model.processes || []).forEach(function (p) { put("Process", p.Name); });
      (model && model.cubes || []).forEach(function (c) { put("Cube", c.Name); });
      (model && model.dimensions || []).forEach(function (d) {
         put("Dimension", d.Name);
         (d.Hierarchies || []).forEach(function (h) { (h.Subsets || []).forEach(function (s) { if (!idx[String(s.Name).toLowerCase()]) put("Subset", s.Name); }); });
      });
      (model && model.chores || []).forEach(function (c) { put("Chore", c.Name); });
      (extra || []).forEach(function (e) { put(e.type, e.name); });
      return idx;
   }

   function diagScrubber(mode, index, map) {
      map = map || { next: {}, tokens: {} };
      map.next = map.next || {}; map.tokens = map.tokens || {};
      index = index || {};
      var name = function (type, n) {
         if (n === null || n === undefined || n === "") return n;
         if (mode === "full") return n;
         if (mode === "removed") return type || "Object";
         var k = (type || "Object") + "\u0001" + String(n).toLowerCase();
         if (!map.tokens[k]) { map.next[type || "Object"] = (map.next[type || "Object"] || 0) + 1; map.tokens[k] = (type || "Object") + "#" + map.next[type || "Object"]; }
         return map.tokens[k];
      };
      var known = Object.keys(index).filter(function (k) { return k.length >= 4 && index[k].type !== "Subset"; })
         .sort(function (a, b) { return b.length - a.length; });
      var escape = function (s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); };
      var text = function (s) {
         if (s === null || s === undefined) return s;
         s = String(s);
         if (mode === "full") return s;
         // quoted strings: a known name becomes its token, anything else is dropped
         s = s.replace(/'((?:[^']|'')*)'|"((?:[^"\\]|\\.)*)"/g, function (all, a, b) {
            var inner = a !== undefined ? a.replace(/''/g, "'") : b, hit = index[String(inner).toLowerCase()];
            var q = a !== undefined ? "'" : "\"";
            return q + (hit ? name(hit.type, hit.name) : (inner === "" ? "" : "…")) + q;
         });
         // file paths
         s = s.replace(/[A-Za-z]:[\\\/][^\s'";,]*|\\\\[^\s'";,]+|(?:\.\.?[\\\/])+[^\s'";,]*/g, "<path>");
         // unquoted names of processes, cubes, dimensions and chores
         known.forEach(function (k) {
            var re = new RegExp("(^|[^A-Za-z0-9_#])(" + escape(index[k].name) + ")(?![A-Za-z0-9_])", "gi");
            s = s.replace(re, function (all, pre) { return pre + name(index[k].type, index[k].name); });
         });
         return s;
      };
      return { mode: mode, name: name, text: text, map: map };
   }

   /* A scan's shape for diagnostics: counts by severity and by rule, never a
    * name. A rule's `function` is added only where it is a TM1 function: some
    * rules keep a model's variable there (mdx.subsetById holds the variable
    * that names the subset), which leaked into the first live trace. */
   function diagScanSummary(findings) {
      var bySeverity = {}, byRule = {};
      (findings || []).forEach(function (f) {
         bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
         var k = f.rule + (f.function && /^ti\.(removed|review|dynamicTarget)$/.test(f.rule) ? ":" + f.function : "");
         byRule[k] = (byRule[k] || 0) + 1;
      });
      return { bySeverity: bySeverity, byRule: byRule };
   }

   /* One diagnostics record: fields scrubbed by kind, never the code. */
   function diagEntry(scrubber, kind, fields, at) {
      var e = { at: (at || new Date()).toISOString(), kind: kind };
      var f = fields || {};
      Object.keys(f).forEach(function (k) {
         var v = f[k];
         if (v === undefined) return;
         if (k === "object" && v && typeof v === "object") e.object = { type: v.type, name: scrubber.name(v.type, v.name) };
         else if (k === "database") e.database = scrubber.name("Database", v);
         else if (k === "user") e.user = scrubber.mode === "full" ? v : scrubber.name("User", v);
         else if (typeof v === "string") e[k] = scrubber.text(v);
         else e[k] = v;
      });
      return e;
   }

   // ---------------------------------------------------------------------------
   // Data-source files (TM1 12)
   // ---------------------------------------------------------------------------

   /* Where each process's data-source file goes in the TM1 12 Files area, and
    * the path the process reads it from afterwards (user, 2026-10-03: one
    * folder for uploaded files, and inside it one sub-folder per place the file
    * used to be read from). Measured on 12.6.4 (plan §2.13): a process reads
    * `Imports/translation files/x.txt` -- forward slashes, relative to the Files
    * root -- and a wrong path aborts it.
    *  - a relative path keeps its folders without the `..` / `.` steps:
    *    `../translation files/x.txt` -> `<root>/translation files/x.txt`;
    *  - an absolute or UNC path keeps the longest tail of its folders that a
    *    relative path in the same model already uses (the same folder, reached
    *    another way), otherwise its last folder: D:\...\sourcefiles\common\x.csv
    *    -> `<root>/sourcefiles/common/x.csv` when ../sourcefiles/common is used;
    *  - a bare file name goes straight under the root;
    *  - a path already under the root is left alone ("inPlace").
    * Two different original folders that would land on one sub-folder each
    * keep one more parent folder, until they differ. Only an ASCII source has
    * a file. A path set in the process's code (DatasourceNameForServer = ...)
    * overrides the property, so such a process is listed and not updated. */
   function splitFilePath(p) {
      var s = String(p || "").replace(/\\/g, "/");
      var kind = /^\/\//.test(s) ? "unc" : /^[A-Za-z]:\//.test(s) ? "absolute" : /^\//.test(s) ? "rooted" : "relative";
      var parts = s.replace(/^\/\/[^\/]+\/[^\/]+\//, "").replace(/^[A-Za-z]:\//, "").replace(/^\/+/, "").split("/").filter(function (x) { return x !== ""; });
      var file = parts.pop() || "";
      var up = parts.some(function (x) { return x === ".."; });
      return { kind: kind, up: up, dirs: parts.filter(function (x) { return x !== ".." && x !== "."; }), file: file };
   }

   // a process that assigns DatasourceNameForServer/Client in its code: the Data files tab leaves its source alone
   function setsDataSourceInCode(p) {
      return PROCEDURES.some(function (k) {
         return tokenize(p[k] || "").some(function (tok) { return tok.type === "statement" && /^datasourcenamefor(server|client)$/.test(tok.assigns || ""); });
      });
   }

   function dataFilePlan(processes, options) {
      var root = String(options && options.root || "Imports").replace(/^\/+|\/+$/g, "");
      var rootLow = root.toLowerCase();
      var rows = [];
      (processes || []).forEach(function (p) {
         var ds = p.DataSource || {};
         if (ds.Type !== "ASCII" || !ds.dataSourceNameForServer) return;
         var setInCode = setsDataSourceInCode(p);
         var sp = splitFilePath(ds.dataSourceNameForServer);
         rows.push({ process: p.Name, original: ds.dataSourceNameForServer, kind: sp.kind, up: sp.up, dirs: sp.dirs, file: sp.file, setInCode: setInCode,
            inPlace: sp.kind === "relative" && !sp.up && sp.dirs.length > 0 && sp.dirs[0].toLowerCase() === rootLow });
      });
      // the folders relative paths already use, for the absolute ones to join
      var known = {};
      rows.forEach(function (r) { if (r.kind === "relative" && !r.inPlace && r.dirs.length) known[r.dirs.join("/").toLowerCase()] = r.dirs; });
      rows.forEach(function (r) {
         if (r.inPlace || r.kind === "relative") { r.folder = r.inPlace ? r.dirs.slice(1) : r.dirs; r.origin = ("relative:" + r.folder.join("/")).toLowerCase(); return; }
         var best = null;
         for (var k = r.dirs.length; k > 0 && !best; k--) {   // the longest tail first
            var tail = r.dirs.slice(r.dirs.length - k).join("/").toLowerCase();
            if (known[tail]) best = known[tail];
         }
         r.folder = best || r.dirs.slice(-1);
         // matched to a folder a relative path uses: the same place, so the same origin
         r.origin = best ? ("relative:" + best.join("/")).toLowerCase() : (r.kind + ":" + r.dirs.join("/")).toLowerCase();
      });
      // two different original folders on one sub-folder: add parents until they differ
      var origin = function (r) { return r.origin; };
      for (var round = 0; round < 8; round++) {
         var bySub = {}, clash = false;
         rows.forEach(function (r) { if (r.inPlace) return; var k = r.folder.join("/").toLowerCase(); (bySub[k] = bySub[k] || {})[origin(r)] = true; });
         rows.forEach(function (r) {
            if (r.inPlace) return;
            var k = r.folder.join("/").toLowerCase();
            if (Object.keys(bySub[k]).length > 1 && r.folder.length < r.dirs.length) {
               r.folder = r.dirs.slice(r.dirs.length - r.folder.length - 1);
               clash = true;
            }
         });
         if (!clash) break;
      }
      rows.forEach(function (r) {
         r.target = r.inPlace ? r.original.replace(/\\/g, "/") : [root].concat(r.folder, [r.file]).join("/");
         r.folderPath = r.inPlace ? r.dirs : [root].concat(r.folder);
         delete r.dirs; delete r.origin;
      });
      return rows;
   }

   /* The picked file for each plan row: by file name, ignoring case; when
    * several picked files share the name, the one whose folder path (a folder
    * pick's webkitRelativePath) ends with the row's sub-folder. Ambiguity is
    * never guessed: such a row gets no file and says why. */
   function matchDataFiles(rows, files) {
      return rows.map(function (r) {
         var same = (files || []).filter(function (f) { return String(f.name).toLowerCase() === r.file.toLowerCase(); });
         if (!same.length) return { file: null, why: "missing" };
         if (same.length > 1) {
            var tail = r.folder.join("/").toLowerCase();
            same = same.filter(function (f) {
               var dir = String(f.relPath || "").replace(/\\/g, "/").toLowerCase().split("/").slice(0, -1).join("/");
               return tail && (dir === tail || dir.slice(-(tail.length + 1)) === "/" + tail);
            });
         }
         return same.length === 1 ? { file: same[0], why: null } : { file: null, why: "ambiguous" };
      });
   }

   /* What the Data files table shows, one entry per row, with the last
    * upload's outcome joined on (user, v0.7.3: the outcome used to be a second
    * list above the table, 23 lines tall, which pushed the table down to its
    * 160px minimum and hid the one row that needed action among the green).
    * status: done | attention | ready | missing.
    *
    * `server` is what the Files area holds, read from TM1 12 (user, v0.8.1:
    * "this stays if I changed the folder or even started and scan the
    * model" -- a session's upload result is forgotten on a rescan, the server
    * is not). Keys are filesKey() paths, values {size, updated}. With it:
    *  - a process reading a Files-area file that is there is done, whatever
    *    the Upload-to folder now says;
    *  - one reading a Files-area path with no file there needs attention,
    *    unless a file was picked for it;
    *  - a picked file whose size differs from the one already at the target
    *    is a conflict: attention, and the row offers Compare.
    * Without it (v11, or before the read), the session's picks and result
    * decide, as before. Only a ready row can be ticked. keepOrder (a v11
    * database, where nothing is picked) leaves the plan order alone. */
   function filesKey(p) { return String(p || "").replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase(); }
   // the Files-area path a process reads now, or null when TM1 12 cannot resolve it there
   function filesCurrent(row) {
      if (row.kind !== "relative" || row.up) return null;
      var sp = splitFilePath(row.original);
      return sp.dirs.concat([sp.file]).join("/");
   }
   function dataFileView(rows, matches, results, filter, keepOrder, server) {
      var byProcess = {}, counts = { all: 0, ready: 0, missing: 0, attention: 0, done: 0 };
      (results || []).forEach(function (x) { if (x.process) byProcess[x.process.toLowerCase()] = x; });
      var all = (rows || []).map(function (r, i) {
         var m = matches ? matches[i] : null, res = byProcess[r.process.toLowerCase()] || null, picked = m && m.file, status, live = null;
         if (r.setInCode) status = "attention";
         else if (server) {
            var cur = filesCurrent(r), curFile = cur ? server[filesKey(cur)] : null, there = server[filesKey(r.target)] || null;
            live = { reads: curFile ? { path: cur, size: curFile.size, updated: curFile.updated } : null, readsMissing: cur && !curFile ? cur : null,
               there: there, conflict: !!(picked && there && there.size !== picked.size) };
            status = live.conflict ? "attention" : live.reads ? "done" : picked ? "ready" : live.readsMissing ? "attention" : "missing";
         }
         else if (res) status = (res.change === "updated" || res.change === "unchanged") && (res.file === "uploaded" || res.file === "same") ? "done" : "attention";
         else status = picked ? "ready" : "missing";
         if (res && (res.change === "failed" || res.file === "failed")) status = "attention";
         counts.all++; counts[status]++;
         return { row: r, match: m, result: res, status: status, live: live };
      });
      var order = { attention: 0, missing: 1, ready: 2, done: 3 };
      var shown = all.filter(function (x) { return !filter || filter === "all" || x.status === filter; });
      // needs attention first, the rest in plan order: the row to act on is never below the fold
      if (!keepOrder) shown = shown.map(function (x, i) { return { x: x, i: i }; })
         .sort(function (a, b) { return order[a.x.status] - order[b.x.status] || a.i - b.i; })
         .map(function (o) { return o.x; });
      // the conflicts whatever the filter shows: the note above the table names and opens them
      return { rows: shown, counts: counts, conflicts: all.filter(function (x) { return x.live && x.live.conflict; }),
         failed: (results || []).filter(function (x) { return !x.process && x.error; }).map(function (x) { return x.error; }) };
   }

   /* The folders whose listing answers every row's question: where each
    * process reads now (when that is in the Files area) and where its file
    * would go. One GET per folder instead of one per file. */
   function dataFileFolders(rows) {
      var seen = {}, out = [];
      (rows || []).forEach(function (r) {
         [filesCurrent(r), r.target].forEach(function (p) {
            if (!p) return;
            var parts = String(p).replace(/\\/g, "/").split("/").filter(Boolean);
            parts.pop();
            var k = parts.join("/").toLowerCase();
            if (!seen[k]) { seen[k] = true; out.push(parts); }
         });
      });
      return out;
   }

   // ---- comparing two text files (user, v0.8.1) ----

   /* A data file's encoding, from its bytes: a byte-order mark first, then
    * whether it is valid UTF-8; otherwise Windows-1252, which is what a TM1 v11
    * on Windows wrote by default. Measured: GO_New_Stores' translation files
    * are UTF-16LE with a BOM. */
   function detectEncoding(b) {
      if (b.length >= 2 && b[0] === 0xFF && b[1] === 0xFE) return "utf-16le";
      if (b.length >= 2 && b[0] === 0xFE && b[1] === 0xFF) return "utf-16be";
      if (b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) return "utf-8";
      for (var i = 0; i < b.length; i++) {
         var c = b[i], n = c < 0x80 ? 0 : (c & 0xE0) === 0xC0 ? 1 : (c & 0xF0) === 0xE0 ? 2 : (c & 0xF8) === 0xF0 ? 3 : -1;
         if (n < 0) return "windows-1252";
         for (var k = 1; k <= n; k++) if (i + k >= b.length || (b[i + k] & 0xC0) !== 0x80) return "windows-1252";
         i += n;
      }
      return "utf-8";
   }

   /* Line diff for data files, which can be thousands of lines (diffLines
    * above is sized for process code): common head and tail trimmed, then an
    * LCS on the middle in a typed array.
    * When the middle is too big for the browser (rows x columns over
    * `limit`), only the first differing line and the counts are returned.
    * ops: {op: "=", "-" or "+", a: line in the first file, b: line in the
    * second, text}. */
   function fileLineDiff(a, b, limit) {
      var n = a.length, m = b.length, pre = 0, suf = 0, ops = [], i, j;
      while (pre < n && pre < m && a[pre] === b[pre]) pre++;
      while (suf < n - pre && suf < m - pre && a[n - 1 - suf] === b[m - 1 - suf]) suf++;
      var A = a.slice(pre, n - suf), B = b.slice(pre, m - suf);
      if (A.length * B.length > (limit || 4000000)) return { tooBig: true, firstDiff: pre + 1, removed: A.length, added: B.length, ops: [] };
      var cols = B.length + 1, L = new Uint32Array((A.length + 1) * cols);
      for (i = A.length - 1; i >= 0; i--)
         for (j = B.length - 1; j >= 0; j--)
            L[i * cols + j] = A[i] === B[j] ? L[(i + 1) * cols + j + 1] + 1 : Math.max(L[(i + 1) * cols + j], L[i * cols + j + 1]);
      for (i = 0; i < pre; i++) ops.push({ op: "=", a: i + 1, b: i + 1, text: a[i] });
      i = 0; j = 0;
      var removed = 0, added = 0;
      while (i < A.length || j < B.length) {
         if (i < A.length && j < B.length && A[i] === B[j]) { ops.push({ op: "=", a: pre + i + 1, b: pre + j + 1, text: A[i] }); i++; j++; }
         else if (j >= B.length || (i < A.length && L[(i + 1) * cols + j] >= L[i * cols + j + 1])) { ops.push({ op: "-", a: pre + i + 1, b: null, text: A[i] }); i++; removed++; }
         else { ops.push({ op: "+", a: null, b: pre + j + 1, text: B[j] }); j++; added++; }
      }
      for (i = 0; i < suf; i++) ops.push({ op: "=", a: n - suf + i + 1, b: m - suf + i + 1, text: a[n - suf + i] });
      return { tooBig: false, removed: removed, added: added, ops: ops };
   }

   /* The changed lines with `context` unchanged lines around each, long
    * unchanged runs folded into {gap: n}, and at most `maxLines` lines. */
   function fileDiffHunks(ops, context, maxLines) {
      var c = context === undefined ? 3 : context, keep = [], out = [], shown = 0, i;
      for (i = 0; i < ops.length; i++) if (ops[i].op !== "=") for (var k = Math.max(0, i - c); k <= Math.min(ops.length - 1, i + c); k++) keep[k] = true;
      var gap = 0, cut = false;
      for (i = 0; i < ops.length; i++) {
         if (!keep[i]) { gap++; continue; }
         if (gap) { out.push({ gap: gap }); gap = 0; }
         if (maxLines && shown >= maxLines) { cut = true; break; }
         out.push(ops[i]); shown++;
      }
      if (gap && !cut) out.push({ gap: gap });
      return { lines: out, cut: cut };
   }

   /* The REST path of a Files entry: "Imports/a b/x.txt" ->
    * /Contents('Files')/Contents('Imports')/Contents('a%20b')/Contents('x.txt') */
   function filesPath(parts) {
      return path([["Contents", "Files"]].concat(parts.map(function (x) { return ["Contents", x]; })));
   }

   // ---------------------------------------------------------------------------
   // Element-type conflicts
   // ---------------------------------------------------------------------------

   /* An element that is a leaf in one hierarchy and consolidated in another
    * rejects its dimension, and the utility stops at the first such dimension
    * (IBM, t_prepare_v11_model_for_migration). `hierarchies` is
    * [{Name, Elements:[{Name, Type}]}]. */
   function elementTypeConflicts(dimension, hierarchies) {
      var seen = {}, out = [];
      (hierarchies || []).forEach(function (h) {
         (h.Elements || []).forEach(function (e) {
            var k = normName(e.Name);
            (seen[k] = seen[k] || []).push({ hierarchy: h.Name, type: e.Type, name: e.Name });
         });
      });
      for (var k in seen) if (seen.hasOwnProperty(k)) {
         var list = seen[k];
         var c = list.filter(function (x) { return x.type === "Consolidated"; }), leaf = list.filter(function (x) { return x.type !== "Consolidated"; });
         if (c.length && leaf.length) {
            out.push({ rule: "dim.typeConflict", severity: "BLOCKER", objectType: "Dimension", object: dimension, procedure: null, line: null,
               statement: list[0].name + ": " + list.map(function (x) { return x.hierarchy + " = " + x.type; }).join(", "), fix: "MANUAL",
               suggestion: "This element is consolidated in one hierarchy and a leaf in another. The migration utility rejects the dimension and stops. Rename it in one hierarchy, or make the types agree." });
         }
      }
      return out;
   }

   // ---------------------------------------------------------------------------
   // v11 <-> v12 compare
   // ---------------------------------------------------------------------------

   /* What exists in the v11 model and not in the v12 one. Names compare
    * without case and spaces, as TM1 compares them. */
   function compareModels(v11, v12) {
      function names(list) { var o = {}; (list || []).forEach(function (x) { o[normName(x.Name)] = x.Name; }); return o; }
      function missing(a, b) { var A = names(a), B = names(b); return Object.keys(A).filter(function (k) { return !B[k]; }).map(function (k) { return A[k]; }).sort(); }
      return {
         processes: missing(v11.processes, v12.processes),
         cubes: missing((v11.cubes || []).filter(function (c) { return c.Name.charAt(0) !== "}"; }), v12.cubes),
         dimensions: missing((v11.dimensions || []).filter(function (d) { return d.Name.charAt(0) !== "}"; }), v12.dimensions),
         chores: missing(v11.chores, v12.chores)
      };
   }

   /* TM1's compile messages put the useful part on the lines after the first:
    * "Syntax error on or before: \n('x', 1);\n equal sign not found". */
   function compileMessage(m) {
      return String(m || "").replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "").slice(0, 240);
   }

   // ---------------------------------------------------------------------------
   // TM1 Applications (}tp_*) clean-up
   // ---------------------------------------------------------------------------

   /* "TM1 Applications" means every }tp_* object (user, 2026-09-29), and with
    * them the control objects TM1 keeps on their behalf, which carry "}tp_"
    * after a prefix of their own: }ElementAttributes_}tp_config,
    * }CellSecurity_}tp_application_root_permissions, }Subsets_}tp_tasks}<guid>.
    * GO_New_Stores has 125 processes, 7 cubes, 17 dimensions and 19 such control
    * objects, some of them orphans of per-application objects that are already
    * gone (PROJECT-PLAN §2.6). */
   function isTpControl(name) { return !isTM1Applications(name) && /\}tp_/i.test(name || ""); }

   /* The order a delete has to run in: a chore before the processes it runs,
    * a cube before its dimensions, and the control objects last, because TM1
    * removes most of them with their parent and only orphans are left. */
   var TP_ORDER = { Chore: 0, Process: 1, View: 2, Subset: 3, Cube: 4, Dimension: 5 };

   function tpKey(item) { return item.type + "|" + (item.parent ? item.parent + "|" : "") + item.name; }

   /* What the clean-up would delete, and what outside TM1 Applications still
    * points into it. `model` is the scan's (cubes carry their Dimensions). */
   function tpInventory(model) {
      var items = [], uses = [];
      var tp = isTM1Applications;
      (model.chores || []).forEach(function (ch) {
         var tasks = ch.Tasks || [];
         var tpTasks = tasks.filter(function (t) { return t.Process && tp(t.Process.Name); });
         // a chore whose every task runs a }tp_ process is empty once they are gone
         if (tp(ch.Name) || tasks.length && tpTasks.length === tasks.length) items.push({ type: "Chore", name: ch.Name });
         else tpTasks.forEach(function (t) {
            uses.push({ objectType: "Chore", object: ch.Name, where: "Task", statement: t.Process.Name, referenced: t.Process.Name });
         });
      });
      (model.processes || []).forEach(function (p) {
         if (tp(p.Name)) { items.push({ type: "Process", name: p.Name }); return; }
         PROCEDURES.forEach(function (proc) {
            tokenize(p[proc] || "").forEach(function (tok) {
               if (tok.type !== "statement") return;
               var seen = {};
               (tok.literals || []).forEach(function (lit) {
                  if (!/^\}tp_/i.test(lit) || seen[lit.toLowerCase()]) return;
                  seen[lit.toLowerCase()] = true;
                  uses.push({ objectType: "Process", object: p.Name, where: PROCEDURE_LABEL[proc] + " " + tok.line,
                     statement: tok.text.replace(/^\s+|\s+$/g, ""), referenced: lit });
               });
            });
         });
      });
      (model.views || []).forEach(function (c) {
         if (tp(c.Name) || isTpControl(c.Name)) return;
         (c.Views || []).forEach(function (v) { if (tp(v.Name)) items.push({ type: "View", name: v.Name, parent: c.Name }); });
      });
      (model.dimensions || []).forEach(function (d) {
         if (tp(d.Name) || isTpControl(d.Name)) return;
         (d.Hierarchies || []).forEach(function (h) {
            (h.Subsets || []).forEach(function (s) {
               if (tp(s.Name)) items.push({ type: "Subset", name: s.Name, parent: d.Name, hierarchy: h.Name });
               else if (/\[\s*\}tp_/i.test(s.Expression || "")) {
                  uses.push({ objectType: "Subset", object: d.Name + " / " + s.Name, where: "MDX", statement: s.Expression, referenced: "}tp_" });
               }
            });
         });
      });
      (model.cubes || []).forEach(function (c) {
         if (tp(c.Name)) { items.push({ type: "Cube", name: c.Name }); return; }
         if (isTpControl(c.Name)) { items.push({ type: "Cube", name: c.Name, control: true }); return; }
         if (c.Name.charAt(0) !== "}") {
            (c.Dimensions || []).forEach(function (d) {
               if (tp(d.Name)) uses.push({ objectType: "Cube", object: c.Name, where: "Dimensions", statement: d.Name, referenced: d.Name });
            });
         }
         String(c.Rules || "").split(/\r?\n/).forEach(function (text, i) {
            if (/^\s*#/.test(text)) return;
            stripStrings(text).literals.forEach(function (lit) {
               if (/^\}tp_/i.test(lit)) uses.push({ objectType: "Rules", object: c.Name, where: "Rules " + (i + 1), statement: text.replace(/^\s+/, ""), referenced: lit });
            });
         });
      });
      (model.dimensions || []).forEach(function (d) {
         if (tp(d.Name)) items.push({ type: "Dimension", name: d.Name });
         else if (isTpControl(d.Name)) items.push({ type: "Dimension", name: d.Name, control: true });
      });
      items.forEach(function (i) { i.key = tpKey(i); });
      return { items: tpDeleteOrder(items), uses: uses, counts: countBy(items, "type") };
   }

   function tpDeleteOrder(items) {
      return items.slice().sort(function (a, b) {
         return (TP_ORDER[a.type] - TP_ORDER[b.type]) || ((a.control ? 1 : 0) - (b.control ? 1 : 0)) || String(a.name).localeCompare(String(b.name));
      });
   }

   function countBy(list, key) {
      var o = {};
      list.forEach(function (x) { o[x[key]] = (o[x[key]] || 0) + 1; });
      return o;
   }

   /* REST path of an inventory item, and the read that captures everything a
    * restore needs. A dimension is read with its elements, edges, attributes and
    * subsets; its attribute values and a cube's cells are read separately
    * (`cubeDataMdx`). */
   function objectPath(item) {
      switch (item.type) {
         case "Chore": return path([["Chores", item.name]]);
         case "Process": return path([["Processes", item.name]]);
         case "View": return path([["Cubes", item.parent], ["Views", item.name]]);
         case "Subset": return path([["Dimensions", item.parent], ["Hierarchies", item.hierarchy || item.parent], ["Subsets", item.name]]);
         case "Cube": return path([["Cubes", item.name]]);
         case "Dimension": return path([["Dimensions", item.name]]);
      }
      return null;
   }

   function definitionPath(item) {
      var p = objectPath(item);
      switch (item.type) {
         case "Chore": return p + "?$expand=Tasks($expand=Process($select=Name))";
         case "Subset": return p + "?$select=Name,Expression&$expand=Elements($select=Name)";
         case "Cube": return p + "?$select=Name,Rules&$expand=Dimensions($select=Name)";
         case "Dimension": return p + "?$select=Name&$expand=Hierarchies($select=Name;$expand=Elements($select=Name,Type)," +
            "Edges($select=ParentName,ComponentName,Weight),ElementAttributes($select=Name,Type),Subsets($select=Name,Expression;$expand=Elements($select=Name)))";
      }
      return p;
   }

   function mdxName(s) { return "[" + String(s).replace(/\]/g, "]]") + "]"; }

   /* Every non-empty leaf cell of a cube, on one axis. Meant for the small
    * cubes TM1 Applications and attribute cubes are; the caller caps it. */
   function cubeDataMdx(cube, dimensions) {
      var sets = dimensions.map(function (d) { return "{TM1FILTERBYLEVEL({TM1SUBSETALL(" + mdxName(d) + "." + mdxName(d) + ")}, 0)}"; });
      return "SELECT NON EMPTY " + sets.join(" * ") + " ON 0 FROM " + mdxName(cube);
   }

   /* The rows of a one-axis cellset read with
    * $expand=Axes($expand=Tuples($expand=Members($select=Name))),Cells($select=Value,RuleDerived).
    * A rule-derived cell is left out: the rules come back with the cube and
    * calculate it again, and writing it would be refused. */
   function cellsetRows(data) {
      var tuples = data && data.Axes && data.Axes[0] ? data.Axes[0].Tuples || [] : [];
      var cells = data && data.Cells || [];
      return tuples.map(function (t, i) {
         var c = cells[i] || {};
         return { row: (t.Members || []).map(function (m) { return m.Name; }).concat([c.Value === undefined ? null : c.Value]), ruled: !!c.RuleDerived };
      }).filter(function (x) { var v = x.row[x.row.length - 1]; return !x.ruled && v !== null && v !== "" && v !== 0; })
         .map(function (x) { return x.row; });
   }

   /* The body of one `tm1.Update` that writes many cells: an array of
    * {Cells:[{Tuple@odata.bind}], Value}, the shape TM1py sends. */
   function cellUpdates(dimensions, rows) {
      return rows.map(function (r) {
         return {
            Cells: [{ "Tuple@odata.bind": dimensions.map(function (d, k) {
               return "Dimensions('" + odataKey(d) + "')/Hierarchies('" + odataKey(d) + "')/Elements('" + odataKey(r[k]) + "')";
            }) }],
            Value: r[r.length - 1]
         };
      });
   }

   function stripOdata(o) {
      var out = {};
      for (var k in o) if (o.hasOwnProperty(k) && k.charAt(0) !== "@" && k.indexOf("@odata") < 0) out[k] = o[k];
      return out;
   }

   /* Restore bodies for what a delete backed up. A dimension comes back in
    * three steps -- structure, then attributes, then values -- because POST
    * /Dimensions does not take attributes inline. The Leaves hierarchy is
    * TM1's own and is never posted. */
   function dimensionCreateBody(def) {
      return {
         Name: def.Name,
         Hierarchies: (def.Hierarchies || []).filter(function (h) { return !/^leaves$/i.test(h.Name); }).map(function (h) {
            return {
               Name: h.Name,
               Elements: (h.Elements || []).map(function (e) { return { Name: e.Name, Type: e.Type }; }),
               Edges: (h.Edges || []).map(function (e) { return { ParentName: e.ParentName, ComponentName: e.ComponentName, Weight: e.Weight }; })
            };
         })
      };
   }

   function cubeCreateBody(def) {
      var body = { Name: def.Name, "Dimensions@odata.bind": (def.Dimensions || []).map(function (d) { return "Dimensions('" + odataKey(d.Name) + "')"; }) };
      if (def.Rules) body.Rules = def.Rules;
      return body;
   }

   function subsetCreateBody(def) {
      if (def.Expression) return { Name: def.Name, Expression: def.Expression };
      return { Name: def.Name, "Elements@odata.bind": (def.Elements || []).map(function (e) { return "Elements('" + odataKey(e.Name) + "')"; }) };
   }

   /* A chore comes back inactive: activating it is the user's decision, and a
    * restore should not start a schedule. */
   function choreCreateBody(def) {
      return {
         Name: def.Name, StartTime: def.StartTime, DSTSensitive: def.DSTSensitive, Active: false,
         ExecutionMode: def.ExecutionMode, Frequency: def.Frequency,
         Tasks: (def.Tasks || []).map(function (t) {
            return { "Process@odata.bind": "Processes('" + odataKey(t.Process ? t.Process.Name : "") + "')", Parameters: t.Parameters || [] };
         })
      };
   }

   // ---------------------------------------------------------------------------
   // Bedrock -- upgrade to Bedrock 5, or delete when unused
   // ---------------------------------------------------------------------------

   /* Bedrock 5 (github.com/cubewise-code/bedrock-5) is the release for TM1
    * v12. Its installer asset `installation_files/assets/bedrock.json`
    * holds all 97 processes as REST bodies, `{data:[{Name, PrologProcedure, ...,
    * Parameters, Variables, UIData, VariablesUIData, HasSecurityAccess}]}`, and
    * raw.githubusercontent.com serves it to Arc's page with CORS (§2.7). The
    * bundled copy is the same file at the commit named here. */
   var BEDROCK_SOURCES = {
      github: "https://raw.githubusercontent.com/cubewise-code/bedrock-5/main/installation_files/assets/bedrock.json",
      bundled: "__/plugins/tm1-12-readiness/bedrock/bedrock.json",
      bundledCommit: "8d4b10c2798e5c2786bd853fb5251b48f2b04e22",
      bundledDate: "2026-06-01"
   };

   /* "}bedrock." is Bedrock 4 and 5; "bedrock." without the brace is Bedrock 3
    * (user, 2026-09-29). A process called just "Bedrock" is neither. */
   function bedrockKind(name) {
      if (/^\}bedrock\./i.test(name || "")) return "v4";
      if (/^bedrock\./i.test(name || "")) return "v3";
      return null;
   }

   /* The version the code says it is. Informational only, because the text is
    * not reliable in either direction (§2.7): 14 of Bedrock 5's own processes
    * do not contain "bedrock-5" (two still say "Ver 4"), and 88 of the 91
    * processes in its v11 package do. Whether a process IS Bedrock 5 is decided
    * by comparing it with the Bedrock 5 code (`sameProcessCode`). */
   function bedrockStatedVersion(p) {
      var text = PROCEDURES.map(function (k) { return p[k] || ""; }).join("\n");
      if (/bedrock-5/i.test(text)) return "5";
      var m = /\bVer(?:sion)?\.?\s*:?\s*(\d+(?:\.\d+)*)/i.exec(text);
      return m ? m[1] : null;
   }

   /* TM1 regenerates the block between the "Generated Statements" markers
    * itself, so it is left out of the comparison; so are line endings. */
   function normCode(s) {
      return String(s || "").replace(/\r\n/g, "\n")
         .replace(/(#\*{4}Begin: Generated Statements\*{3})[\s\S]*?(#\*{4}End: Generated Statements\*{4})/g, "$1$2")
         .replace(/[ \t]+$/gm, "");
   }

   function sameProcessCode(a, b) {
      if (!a || !b) return false;
      for (var i = 0; i < PROCEDURES.length; i++) if (normCode(a[PROCEDURES[i]]) !== normCode(b[PROCEDURES[i]])) return false;
      var pa = (a.Parameters || []).map(paramSig).join("|"), pb = (b.Parameters || []).map(paramSig).join("|");
      return pa === pb;
   }
   function paramSig(p) { return String(p.Name).toLowerCase() + ":" + p.Type + ":" + JSON.stringify(p.Value); }

   /* The Bedrock 5 set, from the installer file (or a bare array). */
   function bedrockReference(json) {
      var list = json && json.data ? json.data : json;
      if (!list || !list.length || !list.every(function (p) { return p && bedrockKind(p.Name) === "v4" && typeof p.PrologProcedure === "string"; })) {
         return { error: "Not a Bedrock 5 installer file." };
      }
      var byName = {};
      list.forEach(function (p) { byName[p.Name.toLowerCase()] = p; });
      return { byName: byName, count: list.length, names: list.map(function (p) { return p.Name; }) };
   }

   /* Bedrock 3 name -> the Bedrock 5 process that does its job, from the
    * b3shell folder of github.com/cubewise-code/bedrock, where each Bedrock 3
    * name is a shell that calls its Bedrock 4 successor (§2.7). The parameters
    * differ, so a caller cannot be rewritten automatically -- only told. */
   var BEDROCK3_MAP = {
      "bedrock.chore.dayinmonth.run": "chore.execution.check", "bedrock.chore.dayofweek.run": "chore.execution.check",
      "bedrock.chore.timeofday.run": "chore.execution.check", "bedrock.cube.clone": "cube.clone", "bedrock.cube.create": "cube.create",
      "bedrock.cube.data.clear": "cube.data.clear", "bedrock.cube.data.clear.all": "cube.data.clear", "bedrock.cube.data.copy": "cube.data.copy",
      "bedrock.cube.data.copy.intercube": "cube.data.copy.intercube", "bedrock.cube.data.copy.intracube": "cube.data.copy",
      "bedrock.cube.data.export": "cube.data.export", "bedrock.cube.data.importfromfile": "cube.data.import",
      "bedrock.cube.data.viewexporttofile": "cube.data.export", "bedrock.cube.delete": "cube.delete",
      "bedrock.cube.dimension.replace": "cube.dimension.replace", "bedrock.cube.rule.processfeeders": "cube.rule.processfeeders",
      "bedrock.cube.rule.unload": "cube.rule.manage", "bedrock.cube.view.create": "cube.view.create", "bedrock.cube.view.delete": "cube.view.delete",
      "bedrock.cube.view.publish": "cube.view.publish", "bedrock.cube.viewandsubsets.create": "cube.viewandsubsets.create",
      "bedrock.cube.viewandsubsets.delete": "cube.viewandsubsets.delete", "bedrock.dim.allconsols.delete": "hier.consol.delete",
      "bedrock.dim.allelements.delete": "hier.element.delete", "bedrock.dim.attr.delete": "dim.attr.delete",
      "bedrock.dim.attr.importfromfile": "dim.attr.importfromfile", "bedrock.dim.attr.insert": "dim.attr.create",
      "bedrock.dim.attr.swapalias": "dim.attr.swapalias", "bedrock.dim.clone": "dim.clone", "bedrock.dim.clonefromsubset": "hier.create.fromsubset",
      "bedrock.dim.clonefromsubset.flat": "hier.create.fromsubset", "bedrock.dim.create": "hier.create", "bedrock.dim.destroy": "dim.delete",
      "bedrock.dim.element.component.add": "hier.element.move", "bedrock.dim.element.component.delete": "hier.element.move",
      "bedrock.dim.element.create": "hier.element.create", "bedrock.dim.element.delete": "hier.element.delete",
      "bedrock.dim.element.move": "hier.element.move", "bedrock.dim.emptyconsols.delete": "hier.emptyconsols.delete",
      "bedrock.dim.export": "hier.export", "bedrock.dim.hierarchy.create.fromattribute": "hier.create.fromattribute",
      "bedrock.dim.hierarchy.unwind.all": "hier.unwind", "bedrock.dim.hierarchy.unwind.consolidation": "hier.unwind",
      "bedrock.dim.import": "hier.import", "bedrock.dim.sub.clone": "hier.sub.clone", "bedrock.dim.sub.create": "hier.sub.create",
      "bedrock.dim.sub.create.all": "hier.sub.create.all", "bedrock.dim.sub.create.attribute.all": "hier.sub.create.attribute.all",
      "bedrock.dim.sub.create.attribute.leaf": "hier.sub.create.attribute.leaf", "bedrock.dim.sub.create.byelement": "hier.sub.create.byelement",
      "bedrock.dim.sub.create.bylevel": "hier.sub.create.bylevel", "bedrock.dim.sub.create.bymdx": "hier.sub.create.bymdx",
      "bedrock.dim.sub.create.consolidation.all": "hier.sub.create.consolidation.all",
      "bedrock.dim.sub.create.consolidation.leaf": "hier.sub.create.consolidation.leaf", "bedrock.dim.sub.create.leaf": "hier.sub.create.leaf",
      "bedrock.dim.sub.create.orphans": "hier.sub.create.orphans", "bedrock.dim.sub.create.toplevelhierarchy": "hier.sub.create.toplevelhierarchy",
      "bedrock.dim.sub.delete": "hier.sub.delete", "bedrock.dim.sub.exclude": "hier.sub.exclude", "bedrock.dim.sub.exporttofile": "hier.sub.exporttofile",
      "bedrock.security.client.clone": "security.client.clone", "bedrock.security.client.create": "security.client.create",
      "bedrock.security.client.delete": "security.client.delete", "bedrock.security.client.group.assign": "security.client.group.assign",
      "bedrock.security.client.password.reset": "security.client.password.reset",
      "bedrock.security.cube.cellsecurity.create": "security.cube.cellsecurity.create",
      "bedrock.security.cube.cellsecurity.destroy": "security.cube.cellsecurity.destroy", "bedrock.security.group.create": "security.group.create",
      "bedrock.security.group.delete": "security.group.delete", "bedrock.security.object.assign": "security.object.assign",
      "bedrock.security.refresh": "security.refresh", "bedrock.server.datadir.backup": "server.dir.backup",
      "bedrock.server.datadir.listcontents": "server.dir.listcontents", "bedrock.server.deleteallpersistentfeeders": "server.deleteallpersistentfeeders",
      "bedrock.server.savedataall": "server.savedataall", "bedrock.server.wait": "server.wait", "bedrock.server.writetomessagelog": "server.writetomessagelog"
   };

   function bedrock5Name(name) {
      var k = String(name || "").toLowerCase();
      if (bedrockKind(k) === "v4") return k;
      return BEDROCK3_MAP[k] ? "}bedrock." + BEDROCK3_MAP[k] : null;
   }

   /* What Bedrock 5 did to the parameters of Bedrock 4, measured by comparing
    * its v11 package with the v12 one (§2.7): `r` were removed, `d` are the
    * Bedrock 4 defaults that changed. Every process also gained pJson, which
    * needs nothing from a caller. Used when the installed process can no longer
    * say what its old defaults were -- it is already Bedrock 5, or missing. */
   var BEDROCK4_PARAMS = {
      "cube.data.clear": { d: [["pSuppressConsolStrings", 0]] },
      "cube.data.copy": { r: ["pStringPrefix", "pStringSuffix"], d: [["pSuppressConsolStrings", 0], ["pDelim", ","]] },
      "cube.data.copy.intercube": { d: [["pSuppressConsolStrings", 0], ["pDelim", ","]] },
      "cube.data.export": { d: [["pSuppressConsolStrings", 0], ["pDelim", ","], ["pCharacterSet", ""]] },
      "cube.data.import": { d: [["pDelim", ","]] },
      "cube.dimension.add": { d: [["pDimIndex", 1], ["pIncludeRules", 2]] },
      "cube.dimension.delete": { d: [["pIncludeData", 1], ["pIncludeRules", 2]] },
      "cube.dimension.replace": { d: [["pIncludeRules", 0]] },
      "cube.view.create": { d: [["pSuppressConsolStrings", -1]] },
      "cube.view.delete": { d: [["pView", "}bedrock*"]] },
      "cube.viewandsubsets.create": { d: [["pLogOutput", 1], ["pSub", ""]] },
      "cube.viewandsubsets.delete": { d: [["pSub", ""]] },
      "dim.attr.create": { d: [["pAttrType", ""]] },
      "dim.attr.importfromfile": { d: [["pDelim", ","]] },
      "hier.create.fromrollup": { d: [["pUnwind", 2]] },
      "hier.create.fromrollup.aliasswap": { d: [["pUnwind", 2]] },
      "hier.element.create": { d: [["pEleType", ""]] },
      "hier.element.delete": { d: [["pEle", ""]] },
      "hier.elements.validate": { d: [["pHier", "*"]] },
      "hier.export": { d: [["pDelim", ","], ["pCharacterSet", ""]] },
      "hier.export.script": { d: [["pTgtFile", ""], ["pCharacterSet", ""]] },
      "hier.import": { d: [["pDelim", ","], ["pUnwind", 1]] },
      "hier.leaves.orphan.check": { d: [["pHier", "*"]] },
      "hier.sub.create.consolidation.all": { d: [["pConsol", ""]] },
      "hier.sub.create.consolidation.leaf": { d: [["pConsol", ""]] },
      "hier.sub.delete": { d: [["pSub", "}Bedrock*"]] },
      "hier.sub.exporttofile": { d: [["pDelim", ","], ["pCharacterSet", ""]] },
      "security.client.clone": { d: [["pMode", "REPLACE"]] },
      "security.evaluate.mdx": { d: [["pDelim", ","]] },
      "security.evaluate.mdx.private": { d: [["pDelim", ","]] },
      "security.object.assign": { d: [["pSecurityRefresh", "No"]] },
      "server.dir.backup": { d: [["pSrcDir", "."]] },
      "server.util.string.validate": { d: [["pLogOutput", 1], ["pUndesirableFileSystem", "/|\\>\"<:?*"], ["pUndesirable1st", "'+-[]@!{}%"],
         ["pChanges", "\\,B Slash&/,F Slash&|, &-,Minus&+,Plus&>,greater than&<,less than"]] },
      "server.writetomessagelog": { d: [["pLevel", ""]] }
   };

   /* What a caller of `callee` has to change when it moves to Bedrock 5:
    * parameters it may no longer pass, and defaults it relied on that changed.
    * The old defaults come from the installed process while it is still the
    * old one, else from the table. Names compare without case, as TM1's do. */
   function bedrockParamChanges(calleeLower, installed, reference) {
      var ref = reference && reference.byName[calleeLower];
      if (!ref) return null;
      var now = {};
      (ref.Parameters || []).forEach(function (p) { now[p.Name.toLowerCase()] = p; });
      var old = [];
      if (installed && !sameProcessCode(installed, ref)) {
         old = (installed.Parameters || []).map(function (p) { return { name: p.Name, value: p.Value }; });
      } else {
         var t = BEDROCK4_PARAMS[calleeLower.replace(/^\}bedrock\./, "")] || {};
         old = (t.r || []).map(function (n) { return { name: n, value: null }; })
            .concat((t.d || []).map(function (d) { return { name: d[0], value: d[1] }; }));
      }
      var removed = [], defaults = [], had = {};
      old.forEach(function (o) {
         had[o.name.toLowerCase()] = true;
         var n = now[o.name.toLowerCase()];
         if (!n) removed.push(o.name);
         else if (o.value !== null && o.value !== n.Value) defaults.push({ name: n.Name, value: o.value, type: n.Type, now: n.Value });
      });
      /* Parameters Bedrock 5 added (pJson everywhere). A process call may leave
       * them out, but a chore task may not: TM1 12 refuses a task whose
       * parameter count differs from its process's (§2.7). When the old
       * parameters come from the table, only pJson is known to be new. */
      var added = (ref.Parameters || []).filter(function (p) {
         var k = p.Name.toLowerCase();
         return installed && !sameProcessCode(installed, ref) ? !had[k] : k === "pjson";
      }).map(function (p) { return { name: p.Name, value: p.Value, type: p.Type }; });
      return { removed: removed, defaults: defaults, added: added };
   }

   /* Every ExecuteProcess / RunProcess in one statement, with its argument
    * spans in the original text. Positions come from the string-blanked code,
    * which keeps every offset (stripStrings), so commas and brackets inside a
    * literal never split an argument. */
   function callSites(text, fnRe) {
      var code = stripStrings(text).code, out = [], re = fnRe || /\b(ExecuteProcess|RunProcess)\s*\(/ig, m;
      var span = function (s, e) {
         var raw = text.substring(s, e), lit = /^\s*'((?:[^']|'')*)'\s*$/.exec(raw);
         return { start: s, end: e, text: raw, literal: lit ? lit[1].replace(/''/g, "'") : null };
      };
      while ((m = re.exec(code)) !== null) {
         var open = m.index + m[0].length - 1, depth = 0, args = [], start = open + 1, close = -1;
         for (var i = open; i < code.length; i++) {
            var c = code.charAt(i);
            if (c === "(") depth++;
            else if (c === ")") { depth--; if (depth === 0) { close = i; break; } }
            else if (c === "," && depth === 1) { args.push(span(start, i)); start = i + 1; }
         }
         if (close < 0) continue;
         args.push(span(start, close));
         out.push({ fn: m[1], index: m.index, open: open, close: close, args: args });
      }
      return out;
   }

   /* The operands of a TI `|` chain, split outside strings and parentheses:
    * each one's text, and its value when it is a literal. */
   function concatOperands(text) {
      var code = stripStrings(text).code, out = [], depth = 0, start = 0;
      var push = function (e) {
         var raw = text.substring(start, e).replace(/^\s+|\s+$/g, ""), lit = /^'((?:[^']|'')*)'$/.exec(raw);
         out.push({ text: raw, literal: lit ? lit[1].replace(/''/g, "'") : null });
      };
      for (var i = 0; i < code.length; i++) {
         var c = code.charAt(i);
         if (c === "(") depth++; else if (c === ")") depth--;
         else if (c === "|" && depth === 0) { push(i); start = i + 1; }
      }
      push(code.length);
      return out;
   }

   /* `.AncestorsAll` in MDX that TI builds from strings and variables, in any
    * statement: an assignment (`vMdx = '…[' | pDim | '].[' | vEl |
    * '].AncestorsAll, …'`, the shape a }tp_ process has) or a call argument.
    * The member is split across literals, so the MDX scan of one literal never
    * sees it (user, 2026-10-02). The operands are joined with each variable as a
    * placeholder, the rewrite of plan §2.11 is built on that, and it is turned
    * back into TI: the variables keep their place. It cannot be run first, so it
    * is shown (fixedStatement), never applied. */
   var JOIN_PH = /zzV(\d+)Vzz/g;
   function joinedAncestorsAll(statement) {
      var code = stripStrings(statement).code, spans = [];
      if (!/\.\s*ANCESTORSALL\b(?!\s*\()/i.test(statement)) return [];
      var asg = /^\s*[A-Za-z_][\w.]*\s*=(?!=)\s*/.exec(code);
      if (asg) { var t = code.replace(/[\s;]+$/, ""); spans.push({ start: asg[0].length, end: t.length }); }
      callSites(statement, /\b(\w+)\s*\(/g).forEach(function (site) { site.args.forEach(function (a) { spans.push({ start: a.start, end: a.end }); }); });
      // the innermost span whose `|` chain has the property in one of its literals
      var best = null;
      spans.forEach(function (sp) {
         var ops = concatOperands(statement.substring(sp.start, sp.end));
         if (!ops.some(function (o) { return o.literal !== null && /\.\s*ANCESTORSALL\b(?!\s*\()/i.test(o.literal); })) return;
         if (!best || sp.end - sp.start < best.end - best.start) best = { start: sp.start, end: sp.end, ops: ops };
      });
      if (!best) return [];
      var J = best.ops.map(function (o, i) { return o.literal !== null ? o.literal : "zzV" + i + "Vzz"; }).join("");
      var jcode = J.replace(/"[^"]*"/g, function (s) { return '"' + repeat(" ", s.length - 2) + '"'; });
      var st = mdxStructure(jcode), re = /\.\s*ANCESTORSALL\b(?!\s*\()/ig, m, hits = [], ok = true;
      while ((m = re.exec(jcode)) !== null) hits.push({ index: m.index, length: m[0].length });
      var J2 = J;
      hits.reverse().forEach(function (h) {
         var ms = exprStart(jcode, st, h.index), M = J.substring(ms, h.index).trim();
         var groups = M.match(/\[(?:[^\]]|\]\])*\]/g) || [];
         if (groups.length < 2 || /CURRENT/i.test(M)) { ok = false; return; }
         var H = groups.length >= 3 ? groups[0] + "." + groups[1] : groups[0] + "." + groups[0];
         var rep = "FILTER(TM1SUBSETALL(" + H + "), COUNT(INTERSECT({" + M + "}, DESCENDANTS(" + H + ".CurrentMember))) > 0 AND NOT (" + H + ".CurrentMember IS " + M + "))";
         J2 = J2.substring(0, ms) + rep + J2.substring(h.index + h.length);
      });
      var head = "[member].AncestorsAll (every ancestor, through every parent) is not supported in TM1 v12: alone it returns an empty set with no error, and inside INTERSECT the MDX fails. " +
         "Ancestors and IsAncestor follow one parent only, so they are not the same. The MDX is built here from strings and variables. ";
      var f = { rule: "mdx.ancestorsAll", severity: "BREAKS", fix: "MANUAL", function: "ANCESTORSALL", match: ".AncestorsAll" };
      if (!ok) { f.suggestion = head + "Build, instead of it, a FILTER over the hierarchy that keeps the consolidations whose DESCENDANTS include the member."; return [f]; }
      // back to TI: literal runs quoted (' doubled), each placeholder its operand's own text
      var parts = [], last = 0, pm;
      JOIN_PH.lastIndex = 0;
      while ((pm = JOIN_PH.exec(J2)) !== null) {
         if (pm.index > last) parts.push("'" + J2.substring(last, pm.index).replace(/'/g, "''") + "'");
         parts.push(best.ops[+pm[1]].text);
         last = pm.index + pm[0].length;
      }
      if (last < J2.length) parts.push("'" + J2.substring(last).replace(/'/g, "''") + "'");
      var span = statement.substring(best.start, best.end), lead = /^\s*/.exec(span)[0], trail = /\s*$/.exec(span)[0];
      f.fixedStatement = statement.substring(0, best.start) + lead + parts.join(" | ") + trail + statement.substring(best.end);
      f.fixedNote = "SAASMIG_FIXEDNOTEJOINED";
      f.suggestion = head + "The corrected statement builds, in its place, the consolidations whose descendants include the member: the same set on both versions, in dimension order (HIERARCHIZE gives the same order as v11). " +
         "It cannot be run before it is offered, so paste it in and check the result.";
      return [f];
   }

   /* MDX built across TI statements (user, 2026-10-02; STATUS Next 5):
    * `v = '…' | x | '…';`, `v = v | '…';`, then SubsetCreateByMDX(s, v) or
    * ViewCreateByMDX(c, w, v). String variables are followed through the
    * process in code order, Prolog to Epilog (TI keeps variables across the
    * procedures), each as its `|` operands, with a variable used inside a chain
    * expanded. At the MDX call, the MDX is assembled with a placeholder for each
    * part that is not known, and the MDX rules run on the whole of it. A part
    * assigned inside IF or WHILE makes the order an assumption: the whole-MDX
    * bracket checks are then left out, and the finding says so. Every finding
    * is MANUAL, because its fix spans several lines: it shows the assembled
    * MDX and, where there is one, its rewrite. Only MDX that uses such a
    * variable is scanned here; one written in the call itself is scanned
    * where it is written. */
   var TI_IDENT = /^[A-Za-z_][\w.$]*$/;
   function crossStatementMdx(p, ctx) {
      var vars = {}, out = [];
      var expand = function (ops, used) {
         var flat = [];
         ops.forEach(function (o) {
            var v = o.literal === null && TI_IDENT.test(o.text) ? vars[o.text.toLowerCase()] : null;
            if (v) { used.push(v); flat = flat.concat(v.ops); } else flat.push(o);
         });
         return flat;
      };
      PROCEDURES.forEach(function (proc) {
         tokenize(p[proc] || "").forEach(function (tok) {
            if (tok.type !== "statement") return;
            var text = tok.text.replace(/^\s+|\s+$/g, ""), code = stripStrings(text).code;
            var asg = /^([A-Za-z_][\w.$]*)\s*=(?!=)\s*/.exec(code);
            if (asg) {
               var rhs = text.substring(asg[0].length).replace(/[\s;]+$/, ""), used = [];
               var flat = expand(concatOperands(rhs), used);
               var name = asg[1].toLowerCase();
               if (!flat.some(function (o) { return o.literal !== null; })) { delete vars[name]; return; }
               var lines = [], branched = tok.depth > 0;
               used.forEach(function (u) { lines = lines.concat(u.lines); if (u.branched) branched = true; });
               vars[name] = { name: asg[1], ops: flat, lines: lines.concat([PROCEDURE_LABEL[proc] + " " + tok.line]), branched: branched };
               return;
            }
            callSites(text, /\b(SubsetCreateByMDX|ViewCreateByMDX)\s*\(/ig).forEach(function (site) {
               var arg = site.args[site.fn.toLowerCase() === "subsetcreatebymdx" ? 1 : 2];
               if (!arg) return;
               var used = [], flat = expand(concatOperands(arg.text), used);
               if (!used.length) return;
               var J = flat.map(function (o, i) { return o.literal !== null ? o.literal : "zzV" + i + "Vzz"; }).join("");
               /* The checks need a variable's value, but what is shown keeps the
                * variable (user, 2026-10-02): a corrected MDX with a variable's
                * value in it was a constant where the process has the
                * variable. A value known in full and standing as a whole name --
                * [value] or "value" -- is shown as the variable again. */
               var named = [];
               used.forEach(function (u) {
                  if (named.some(function (x) { return x.name === u.name; })) return;
                  if (!u.ops.every(function (o) { return o.literal !== null; })) return;
                  var value = u.ops.map(function (o) { return o.literal; }).join("");
                  if (value.length >= 2) named.push({ name: u.name, value: value });
               });
               var shown = function (s) {
                  var r = s.replace(JOIN_PH, function (all, i) { return "' | " + flat[+i].text + " | '"; });
                  named.forEach(function (v) {
                     r = r.split("[" + v.value + "]").join("[' | " + v.name + " | ']").split("\"" + v.value + "\"").join("\"' | " + v.name + " | '\"");
                  });
                  return r;
               };
               var lines = [], branched = tok.depth > 0;
               used.forEach(function (u) { lines = lines.concat(u.lines); if (u.branched) branched = true; });
               lines = lines.filter(function (l, i) { return lines.indexOf(l) === i; });
               var where = " The MDX is built on " + lines.join(", ") + " and used here." +
                  (branched ? " Part of it is assigned inside IF or WHILE, so the order is assumed, and brackets are not checked." : "") +
                  " Its fix is on those lines, so it is shown, not applied.";
               var found = scanMdx("Process", p.Name, null, J, ctx, branched ? "piece" : null)
                  // .AncestorsAll is reported on the line that writes it (joinedAncestorsAll)
                  .filter(function (f) { return f.rule !== "mdx.ancestorsAll"; });
               found = found.concat(variableSubsetRefs(J, flat));
               var fixed = found.some(function (f) { return f.fix === "REWRITE" && f.replacement !== undefined; }) ? fixMdx(J, found) : null;
               found.forEach(function (f) {
                  f.fix = "MANUAL";
                  f.objectType = "Process"; f.object = p.Name; f.procedure = proc; f.line = tok.line; f.statement = text;
                  f.tm1Applications = isTM1Applications(p.Name);
                  f.builtOn = lines;
                  f.assembledMdx = shown(J);
                  if (fixed && fixed !== J) { f.fixedMdx = shown(fixed); f.fixedNote = "SAASMIG_FIXEDNOTECROSS"; }
                  f.suggestion += where;
                  out.push(f);
               });
            });
         });
      });
      return out;
   }

   /* `[d].[v]` or `[d].[h].[v]` where the last name is a whole variable whose
    * name says subset (`pApprovalSubset`, `sSub`): when it holds a subset name,
    * TM1 12 returns an empty set with no error (§2.5). The code alone cannot
    * say what the variable holds, so this is REVIEW, with the TM1SubsetToSet
    * rewrite. */
   function variableSubsetRefs(J, flat) {
      var code = J.replace(/"[^"]*"/g, function (s) { return '"' + repeat(" ", s.length - 2) + '"'; }), out = [];
      referenceChains(code).forEach(function (ch) {
         var parts = ch.parts, last = /^zzV(\d+)Vzz$/.exec(parts[parts.length - 1]);
         if (parts.length < 2 || parts.length > 3 || !last) return;
         var v = flat[+last[1]];
         if (!v || !/sub/i.test(v.text)) return;
         if (/^\s*\./.test(code.substring(ch.index + ch.text.length))) return;
         var q = function (s) { return "[" + s + "]"; };
         var hier = parts.length === 3 ? parts[1] : parts[0];
         out.push({ rule: "mdx.subsetById", severity: "REVIEW", fix: "REWRITE", objectType: "Process", procedure: "MDX", line: null,
            match: J.substr(ch.index, ch.text.length), index: ch.index, function: v.text,
            replacement: "TM1SubsetToSet(" + q(parts[0]) + "." + q(hier) + ", \"" + parts[parts.length - 1] + "\")",
            suggestion: "Names " + v.text + " as a member. If it holds a subset name, as its name suggests, TM1 v12 no longer resolves a subset by identifier and says nothing: the set comes back empty. Use TM1SubsetToSet." });
      });
      return out;
   }

   function tiLiteral(value, type) {
      if (type === "Numeric" || typeof value === "number") return String(value);
      return "'" + String(value === null || value === undefined ? "" : value).replace(/'/g, "''") + "'";
   }

   /* Rewrites one call for Bedrock 5: drops the pairs of removed parameters
    * and passes each changed default with its old value, so the caller keeps
    * the behaviour it had. Returns null when nothing changes, or {manual} when
    * the call cannot be read (computed parameter names, odd argument count). */
   function rewriteCall(text, site, change) {
      var params = site.args.slice(1);
      if (params.length % 2 !== 0) return { manual: "The call does not have name/value pairs after the process name." };
      var passed = {}, keep = [], dropped = [], carry = null;
      for (var i = 0; i < params.length; i += 2) {
         var n = params[i].literal;
         if (n === null) return { manual: "A parameter name is computed, so the call cannot be checked." };
         passed[n.toLowerCase()] = true;
         if (change.removed.some(function (r) { return r.toLowerCase() === n.toLowerCase(); })) {
            dropped.push(n);
            // a dropped pair that started a line hands its line break to the next pair
            var lead = /^\s*/.exec(params[i].text)[0];
            if (/\n/.test(lead) && carry === null) carry = lead;
         } else {
            var nameArg = params[i];
            if (carry !== null) { nameArg = extend(nameArg, { text: carry + nameArg.text.replace(/^\s+/, "") }); carry = null; }
            keep.push(nameArg, params[i + 1]);
         }
      }
      var added = change.defaults.filter(function (d) { return !passed[d.name.toLowerCase()]; });
      if (!dropped.length && !added.length) return null;
      // the layout before the closing bracket (a newline and indent, often) stays where it was
      var trail = /\s*$/.exec(site.args[site.args.length - 1].text)[0];
      var body = (text.substring(site.open + 1, site.args[0].end) + keep.map(function (a) { return "," + a.text; }).join("")).replace(/\s+$/, "");
      added.forEach(function (d) { body += ", '" + d.name + "', " + tiLiteral(d.value, d.type); });
      return {
         text: text.substring(0, site.open + 1) + body + trail + text.substring(site.close),
         dropped: dropped, added: added.map(function (d) { return d.name + "=" + tiLiteral(d.value, d.type); })
      };
   }

   /* The caller side of an upgrade, for one process: every call to a Bedrock
    * process that `changesFor(lowerName)` has changes for, rewritten, with a
    * `# SAASMIG` line above each changed statement saying what changed and why.
    * A call to a Bedrock 3 process is never rewritten: its successor takes
    * different parameters, so it is reported for a person to change. */
   function fixBedrockCallers(process, changesFor) {
      var result = {}, edits = [], manual = [];
      PROCEDURES.forEach(function (proc) {
         var code = process[proc] || "", cuts = [];
         tokenize(code).forEach(function (tok) {
            if (tok.type !== "statement") return;
            var text = tok.text, changedText = text, notes = [];
            // right to left, so earlier offsets stay valid
            callSites(text).reverse().forEach(function (site) {
               var target = site.args[0] && site.args[0].literal;
               if (!target) return;
               var ch = changesFor(target.toLowerCase());
               if (!ch) return;
               var base = { procedure: proc, line: tok.line, statement: text.replace(/^\s+|\s+$/g, ""), callee: target };
               if (ch.v3) {
                  manual.push(extend(base, { reason: "Calls Bedrock 3 process " + target + ". Its Bedrock 5 successor is " + (ch.target || "not known") +
                     ", with different parameters: change this call by hand." }));
                  return;
               }
               var r = rewriteCall(changedText, site, ch);
               if (!r) return;
               if (r.manual) { manual.push(extend(base, { reason: r.manual })); return; }
               changedText = r.text;
               notes.push(target + (r.dropped.length ? " -" + r.dropped.join(",") : "") + (r.added.length ? " +" + r.added.join(",") : ""));
               edits.push(extend(base, { dropped: r.dropped, added: r.added }));
            });
            if (changedText !== text) cuts.push({ tok: tok, text: changedText, note: notes.join("; ") });
         });
         var out = code;
         cuts.sort(function (a, b) { return b.tok.start - a.tok.start; }).forEach(function (c) {
            var ls = out.lastIndexOf("\n", c.tok.start - 1) + 1, indent = out.substring(ls, c.tok.start);
            if (/\S/.test(indent)) indent = "";
            var eol = /\r\n/.test(code) ? "\r\n" : "\n";
            out = out.substring(0, c.tok.start) + MARK + "Bedrock 5 (kept v4 defaults / dropped removed parameters): " + c.note + eol + indent + c.text + out.substring(c.tok.end);
         });
         result[proc] = out;
      });
      var changedProcs = PROCEDURES.filter(function (p) { return (result[p] || "") !== (process[p] || ""); });
      var procs = copyProcedures(process);
      PROCEDURES.forEach(function (p) { procs[p] = result[p]; });
      return { procedures: procs, changedProcedures: changedProcs, edits: edits, manual: manual, removed: edits,
         blockers: [], fixable: true, changed: changedProcs.length > 0 };
   }

   /* The same for a chore: its tasks list parameters by name, so a removed one
    * is dropped and a changed default is added with its old value. */
   function fixChoreCallers(chore, changesFor) {
      var edits = [], manual = [], changed = false;
      var tasks = (chore.Tasks || []).map(function (t, k) {
         var name = t.Process && t.Process.Name, ch = name ? changesFor(name.toLowerCase()) : null;
         var params = (t.Parameters || []).map(function (p) { return { Name: p.Name, Value: p.Value }; });
         var step = t.Step !== undefined ? t.Step : k;
         if (!ch) return { step: step, process: name, Parameters: params, changed: false };
         if (ch.v3) {
            manual.push({ procedure: "Task " + (k + 1), line: null, statement: name, callee: name,
               reason: "Runs Bedrock 3 process " + name + ". Its Bedrock 5 successor is " + (ch.target || "not known") + ", with different parameters: change this task by hand." });
            return { step: step, process: name, Parameters: params, changed: false };
         }
         var passed = {};
         params.forEach(function (p) { passed[String(p.Name).toLowerCase()] = true; });
         var dropped = params.filter(function (p) { return ch.removed.some(function (r) { return r.toLowerCase() === String(p.Name).toLowerCase(); }); }).map(function (p) { return p.Name; });
         var kept = params.filter(function (p) { return dropped.indexOf(p.Name) < 0; });
         // a changed default keeps its old value; a parameter new in Bedrock 5 gets its default
         var added = ch.defaults.concat(ch.added || []).filter(function (d) { return !passed[d.name.toLowerCase()]; });
         added.forEach(function (d) { passed[d.name.toLowerCase()] = true; kept.push({ Name: d.name, Value: d.value }); });
         var did = dropped.length > 0 || added.length > 0;
         if (did) {
            changed = true;
            edits.push({ procedure: "Task " + (k + 1), line: null, statement: name, callee: name, dropped: dropped,
               added: added.map(function (d) { return d.name + "=" + tiLiteral(d.value, d.type); }) });
         }
         return { step: step, process: name, Parameters: kept, changed: did };
      });
      return { tasks: tasks, edits: edits, manual: manual, changed: changed };
   }

   function extend(a, b) { var o = {}, k; for (k in a) if (a.hasOwnProperty(k)) o[k] = a[k]; for (k in b) if (b.hasOwnProperty(k)) o[k] = b[k]; return o; }

   /* Could this start of a process name still become a Bedrock name? */
   function couldBeBedrock(prefix) {
      var p = String(prefix).toLowerCase();
      return ["}bedrock.", "bedrock."].some(function (b) { return b.indexOf(p) === 0 || p.indexOf(b) === 0; });
   }

   /* What a process-name expression can evaluate to, as far as the code
    * says: a literal; a literal followed by `|` (only its start is known); or
    * a variable, followed to every assignment of it in the process. Returns
    * the known values as {text, whole}, where `whole` says the literal is the
    * entire name rather than its start; or null when anything is unknown. */
   function nameStarts(expr, assignments, depth) {
      if ((depth || 0) > 4) return null;
      // split on | outside strings and brackets
      var e = String(expr || ""), code = stripStrings(e).code, parts = [], start = 0, lvl = 0;
      for (var i = 0; i < code.length; i++) {
         var c = code.charAt(i);
         if (c === "(") lvl++; else if (c === ")") lvl--;
         else if (c === "|" && lvl === 0) { parts.push(e.substring(start, i)); start = i + 1; }
      }
      parts.push(e.substring(start));
      var out = [{ text: "", whole: true }];
      for (var k = 0; k < parts.length; k++) {
         var vals = partValues(parts[k].replace(/^\s+|\s+$/g, ""), assignments, depth || 0);
         if (!vals) {
            // unknown from here on: what came before is only a start
            if (k === 0) return null;
            return out.map(function (o) { return { text: o.text, whole: false }; });
         }
         var next = [];
         out.forEach(function (o) { vals.forEach(function (v) { next.push({ text: o.text + v.text, whole: v.whole }); }); });
         out = next;
         if (out.length > 50) return null;
         if (out.every(function (o) { return !o.whole; })) return out;
      }
      return out;
   }

   /* The values one operand of a `|` chain can take: a literal, or a
    * variable followed to every assignment of it. */
   function partValues(e, assignments, depth) {
      var lit = /^'((?:[^']|'')*)'$/.exec(e);
      if (lit) return [{ text: lit[1].replace(/''/g, "'"), whole: true }];
      if (!/^[A-Za-z_][A-Za-z0-9_.$]*$/.test(e)) return null;
      var list = assignments[e.toLowerCase()];
      if (!list || !list.length) return null;
      var out = [];
      for (var i = 0; i < list.length; i++) {
         var r = nameStarts(list[i], assignments, depth + 1);
         if (!r) return null;
         out = out.concat(r);
      }
      return out;
   }

   /* The ExecuteProcess / RunProcess calls in a business process whose
    * target is computed and could be a Bedrock process. A variable set only
    * from literals, or a name built from a literal start that no Bedrock name
    * has (`'import_' | sCube`), is followed and dropped: those were the whole
    * of the warning on a real model (user, 2026-09-29). A literal Bedrock
    * name counts as a call already (`bedrockInventory`), so it is dropped too. */
   function computedBedrockCalls(process) {
      return computedCallSites(process).filter(function (s) {
         if (!s.values) return true;
         // open only when some value is a partial name that may still end up Bedrock
         return s.values.some(function (x) { return !x.whole && couldBeBedrock(x.text); });
      });
   }

   /* Every ExecuteProcess / RunProcess with a computed target, with the values
    * the target can take as far as the code says (`nameStarts`), or null.
    *
    * GetProcessName() is the calling process's own name, so it is read as that
    * name written out. Bedrock runs itself in parallel as
    * `RunProcess(cThisProcName, ...)` with `cThisProcName = GetProcessName();`:
    * unresolved, those were most of the "might be this one" warnings on a
    * guarded delete (user's screenshot, 2026-09-30), and none could be. */
   function computedCallSites(process) {
      var assignments = {}, sites = [];
      var self = "'" + String(process.Name).replace(/'/g, "''") + "'";
      var own = function (e) { return e.replace(/\bGetProcessName\s*\(\s*\)/ig, self); };
      PROCEDURES.forEach(function (proc) {
         tokenize(process[proc] || "").forEach(function (tok) {
            if (tok.type !== "statement") return;
            if (tok.assigns && !tok.keyword) {
               var rhs = tok.text.replace(/^\s+/, "").replace(/^[A-Za-z_][A-Za-z0-9_.$]*\s*=/, "").replace(/;\s*$/, "");
               (assignments[tok.assigns] = assignments[tok.assigns] || []).push(own(rhs));
            }
            callSites(tok.text).forEach(function (site) {
               if (site.args[0] && site.args[0].literal === null) sites.push({ procedure: proc, line: tok.line, statement: tok.text.replace(/^\s+|\s+$/g, ""), expr: own(site.args[0].text) });
            });
         });
      });
      sites.forEach(function (s) { s.values = nameStarts(s.expr, assignments); });
      return sites;
   }

   /* Who calls process `name`, for the guarded delete (user, 2026-09-29): a
    * delete is refused while any of these exist.
    *  - calls: ExecuteProcess / RunProcess with the name written out, or
    *    computed from literals that make exactly this name; a chore task;
    *  - mentions: any other string naming it (`sProc = 'name';`);
    *  - possible: a computed target that may be this name (a variable the code
    *    cannot resolve, or a start this name has). Warned about, not refused:
    *    the code alone cannot say.
    * TM1 compares names without case, and so does this. A process calling
    * itself does not count. */
   function processCallers(model, name) {
      var target = String(name).toLowerCase(), calls = [], mentions = [], possible = [];
      (model.processes || []).forEach(function (p) {
         if (p.Name.toLowerCase() === target) return;
         var seen = {};
         PROCEDURES.forEach(function (proc) {
            tokenize(p[proc] || "").forEach(function (tok) {
               if (tok.type !== "statement") return;
               var at = { fromType: "Process", from: p.Name, procedure: proc, line: tok.line, statement: tok.text.replace(/^\s+|\s+$/g, "") };
               var direct = callSites(tok.text).some(function (site) { return site.args[0] && site.args[0].literal !== null && site.args[0].literal.toLowerCase() === target; });
               if (direct) { calls.push(at); seen[proc + tok.line] = true; return; }
               if ((tok.literals || []).some(function (l) { return String(l).toLowerCase() === target; })) { mentions.push(at); seen[proc + tok.line] = true; }
            });
         });
         computedCallSites(p).forEach(function (s) {
            if (seen[s.procedure + s.line]) return;
            var at = { fromType: "Process", from: p.Name, procedure: s.procedure, line: s.line, statement: s.statement };
            if (!s.values) { possible.push(at); return; }
            if (s.values.some(function (x) { return x.whole && x.text.toLowerCase() === target; })) calls.push(at);
            else if (s.values.some(function (x) { return !x.whole && target.indexOf(x.text.toLowerCase()) === 0; })) possible.push(at);
         });
      });
      (model.chores || []).forEach(function (ch) {
         (ch.Tasks || []).forEach(function (t, k) {
            if (t.Process && String(t.Process.Name).toLowerCase() === target) {
               calls.push({ fromType: "Chore", from: ch.Name, procedure: "Task " + (k + 1), line: null, statement: t.Process.Name });
            }
         });
      });
      return { calls: calls, mentions: mentions, possible: possible, blocked: calls.length + mentions.length > 0 };
   }

   /* The Bedrock inventory and what each process is used by.
    *
    * A Bedrock process is used when a business process (anything that is not
    * Bedrock) or a chore runs it -- directly, or through other Bedrock
    * processes that are themselves used. Calls from a Bedrock process that
    * nothing uses do not count (user, 2026-09-29). A call is an ExecuteProcess
    * / RunProcess with a literal target, or any string literal naming a Bedrock
    * process (`sProc = '}bedrock.cube.data.clear';`), which is how Bedrock
    * calls itself. After an upgrade the Bedrock 5 code does the calling, so its
    * calls count too. A computed target cannot be followed; the processes that
    * have one are listed, because they may use anything.
    *
    * Returns one row per Bedrock process, the Bedrock 5 processes that callers
    * name but the database does not have, and the processes with computed
    * targets. */
   function bedrockInventory(model, reference) {
      var procs = model.processes || [], byLower = {}, known = {};
      procs.forEach(function (p) { byLower[p.Name.toLowerCase()] = p; if (bedrockKind(p.Name)) known[p.Name.toLowerCase()] = p.Name; });
      if (reference) reference.names.forEach(function (n) { known[n.toLowerCase()] = known[n.toLowerCase()] || n; });
      var refsOf = function (p) {
         var out = [];
         PROCEDURES.forEach(function (proc) {
            tokenize(p[proc] || "").forEach(function (tok) {
               if (tok.type !== "statement") return;
               var seen = {};
               (tok.literals || []).forEach(function (lit) {
                  var k = String(lit).toLowerCase();
                  if (!bedrockKind(k) || seen[k]) return;
                  seen[k] = true;
                  out.push({ to: k, fromType: "Process", from: p.Name, procedure: proc, line: tok.line, statement: tok.text.replace(/^\s+|\s+$/g, "") });
               });
            });
         });
         return out;
      };
      var callers = {}, dynamic = [], used = {}, queue = [];
      var reach = function (e) {
         (callers[e.to] = callers[e.to] || []).push(e);
         if (!used[e.to]) { used[e.to] = true; queue.push(e.to); }
      };
      procs.forEach(function (p) {
         if (bedrockKind(p.Name)) return;
         refsOf(p).forEach(reach);
         var open = computedBedrockCalls(p);
         if (open.length) dynamic.push({ name: p.Name, line: open[0].line, procedure: open[0].procedure, statement: open[0].statement, count: open.length });
      });
      (model.chores || []).forEach(function (ch) {
         (ch.Tasks || []).forEach(function (t, k) {
            var n = t.Process && t.Process.Name;
            if (n && bedrockKind(n)) reach({ to: n.toLowerCase(), fromType: "Chore", from: ch.Name, procedure: "Task " + (k + 1), line: null, statement: n });
         });
      });
      var via = {};
      while (queue.length) {
         var cur = queue.shift(), sources = [];
         if (byLower[cur]) sources.push(byLower[cur]);
         if (reference && reference.byName[cur]) sources.push(reference.byName[cur]);
         sources.forEach(function (src) {
            refsOf(src).forEach(function (e) {
               if (e.to === cur) return;
               (via[e.to] = via[e.to] || {})[known[cur] || cur] = true;
               if (!used[e.to]) { used[e.to] = true; queue.push(e.to); }
            });
         });
      }
      var rows = procs.filter(function (p) { return bedrockKind(p.Name); }).map(function (p) {
         var k = p.Name.toLowerCase(), kind = bedrockKind(p.Name), target = bedrock5Name(p.Name);
         var ref = reference && target ? reference.byName[target] : null, status;
         if (!reference) status = "notLoaded";
         else if (kind === "v3") status = "v3";
         else if (!ref) status = "unknown";
         else status = sameProcessCode(p, ref) ? "current" : "outdated";
         return {
            name: p.Name, kind: kind, stated: bedrockStatedVersion(p), status: status,
            target: ref ? ref.Name : target, targetInstalled: !!(target && byLower[target]),
            used: !!used[k], callers: callers[k] || [], via: Object.keys(via[k] || {})
         };
      }).sort(function (a, b) { return a.name.localeCompare(b.name); });
      var missing = [];
      if (reference) {
         Object.keys(used).forEach(function (k) {
            var t = bedrock5Name(k);
            if (byLower[k] || !t || !reference.byName[t] || t !== k) return;
            missing.push({ name: reference.byName[t].Name, callers: callers[k] || [], via: Object.keys(via[k] || {}) });
         });
         // a Bedrock 3 process in use needs its successor installed
         rows.forEach(function (r) {
            if (r.kind !== "v3" || !r.used || !r.target || byLower[r.target.toLowerCase()]) return;
            if (!missing.some(function (m) { return m.name.toLowerCase() === r.target.toLowerCase(); })) {
               missing.push({ name: r.target, callers: [], via: [r.name], forV3: true });
            }
         });
      }
      missing.sort(function (a, b) { return a.name.localeCompare(b.name); });
      return { rows: rows, missing: missing, dynamic: dynamic, used: used };
   }

   /* The default choice for each row: upgrade what is used and not yet
    * Bedrock 5, delete what nothing uses, leave the rest. */
   function bedrockDefaultAction(row) {
      if (!row.used) return "delete";
      if (row.status === "outdated") return "upgrade";
      return "leave";
   }

   /* The caller changes an upgrade run implies. `upgrading[lower]` is true for
    * every Bedrock process this run upgrades or installs; a caller of one
    * already on Bedrock 5 only loses parameters Bedrock 5 no longer has. */
   function bedrockCallerPlan(model, reference, upgrading) {
      if (!reference) return { processes: [], chores: [], manual: [] };
      var byLower = {};
      (model.processes || []).forEach(function (p) { byLower[p.Name.toLowerCase()] = p; });
      var cache = {};
      var changesFor = function (k) {
         if (cache.hasOwnProperty(k)) return cache[k];
         var kind = bedrockKind(k), c = null;
         if (kind === "v3") c = { v3: true, target: bedrock5Name(k) };
         else if (kind === "v4") {
            var ch = bedrockParamChanges(k, byLower[k], reference);
            if (ch) {
               if (!upgrading[k] && byLower[k] && !sameProcessCode(byLower[k], reference.byName[k])) ch = null;   // stays on v4
               else if (!upgrading[k]) { ch.defaults = []; ch.added = []; }
               if (ch && !ch.removed.length && !ch.defaults.length && !ch.added.length) ch = null;
            }
            c = ch;
         }
         cache[k] = c;
         return c;
      };
      var processes = [], chores = [], manual = [];
      (model.processes || []).forEach(function (p) {
         if (bedrockKind(p.Name)) return;
         var f = fixBedrockCallers(p, changesFor);
         f.manual.forEach(function (m) { manual.push(extend(m, { objectType: "Process", object: p.Name })); });
         if (f.changed) processes.push({ name: p.Name, before: p, fix: f });
      });
      (model.chores || []).forEach(function (ch) {
         var f = fixChoreCallers(ch, changesFor);
         f.manual.forEach(function (m) { manual.push(extend(m, { objectType: "Chore", object: ch.Name })); });
         if (f.changed) chores.push({ name: ch.Name, before: ch, fix: f });
      });
      return { processes: processes, chores: chores, manual: manual };
   }

   /* A process body TM1 will take back: only the writable properties. A full
    * GET on TM1 12 also returns `Attributes`, and a PATCH carrying it is
    * refused -- "Cannot modify Attributes property during Process PATCH"
    * (§2.7) -- so a backup is never written back as read. Without the name for
    * a PATCH, with it for a POST. */
   var PROCESS_WRITABLE = ["PrologProcedure", "MetadataProcedure", "DataProcedure", "EpilogProcedure", "HasSecurityAccess",
      "UIData", "DataSource", "Parameters", "Variables", "VariablesUIData"];
   function processBody(def, withName) {
      var body = {};
      if (withName) body.Name = def.Name;
      PROCESS_WRITABLE.forEach(function (k) { if (def && def.hasOwnProperty(k)) body[k] = def[k]; });
      return body;
   }

   /* The body that makes a process the Bedrock 5 one. */
   function bedrockBody(ref, withName) { return processBody(ref, withName); }

   return {
      VERSION: VERSION,
      compileMessage: compileMessage,
      CFG_UNSUPPORTED: CFG_UNSUPPORTED,
      parseCfg: parseCfg,
      cfgFromRest: cfgFromRest,
      migrateCommand: migrateCommand,
      migrateCommandLine: migrateCommandLine,
      migrateVerdict: migrateVerdict,
      PROJECT_OUTPUT_DIR: PROJECT_OUTPUT_DIR,
      projectSetHostPath: projectSetHostPath,
      projectOutputDir: projectOutputDir,
      checkCfg: checkCfg,
      parseMigrateLog: parseMigrateLog,
      whereUsed: whereUsed,
      groupWhereUsed: groupWhereUsed,
      DIAG_MODES: DIAG_MODES,
      diagIndex: diagIndex,
      diagScrubber: diagScrubber,
      diagEntry: diagEntry,
      diagScanSummary: diagScanSummary,
      FIX_CATALOGUE: FIX_CATALOGUE,
      FIX_VERIFIED_WITH: FIX_VERIFIED_WITH,
      fixEvidence: fixEvidence,
      dataFilePlan: dataFilePlan,
      matchDataFiles: matchDataFiles,
      dataFileView: dataFileView,
      dataFileFolders: dataFileFolders,
      filesKey: filesKey,
      detectEncoding: detectEncoding,
      fileLineDiff: fileLineDiff,
      fileDiffHunks: fileDiffHunks,
      filesPath: filesPath,
      compareLog: compareLog,
      elementTypeConflicts: elementTypeConflicts,
      compareModels: compareModels,
      scanModel: scanModel,
      tm1ApplicationsGroup: tm1ApplicationsGroup,
      compileBody: compileBody,
      REMOVED_TI: REMOVED_TI,
      REMOVED_CONTROL: REMOVED_CONTROL,
      PROCEDURES: PROCEDURES,
      PROCEDURE_LABEL: PROCEDURE_LABEL,
      tokenize: tokenize,
      stripStrings: stripStrings,
      scanProcess: scanProcess,
      scanRules: scanRules,
      scanMdx: scanMdx,
      scanName: scanName,
      nameProblem: nameProblem,
      pathProblem: pathProblem,
      fixProcess: fixProcess,
      fixRemove: fixRemove,
      fixMdx: fixMdx,
      basisSuggestion: basisSuggestion,
      basisSet: basisSet,
      basisListOf: basisListOf,
      BASIS_ONLY: BASIS_ONLY,
      checkNote: checkNote,
      grantGroups: grantGroups,
      joinedAncestorsAll: joinedAncestorsAll,
      crossStatementMdx: crossStatementMdx,
      carryPageResults: carryPageResults,
      refuseUnfixable: refuseUnfixable,

      mdxStructure: mdxStructure,
      hierarchyOf: hierarchyOf,
      processPatch: processPatch,
      diffLines: diffLines,
      diffHunks: diffHunks,
      sameRules: sameRules,
      parseCsv: parseCsv,
      cloudIdCsv: cloudIdCsv,
      cloudIdImport: cloudIdImport,
      validateCloudIds: validateCloudIds,
      cloudIdCell: cloudIdCell,
      groupCloudIdCell: groupCloudIdCell,
      groupCloudIdCsv: groupCloudIdCsv,
      isAlwaysGroup: isAlwaysGroup,
      odataKey: odataKey,
      path: path,
      backupFile: backupFile,
      backupFileName: backupFileName,
      readBackup: readBackup,
      deleteAnswer: deleteAnswer,
      FIX_ON_TM1_12: FIX_ON_TM1_12,
      setsDataSourceInCode: setsDataSourceInCode,

      fileStamp: fileStamp,
      safeName: safeName,
      PROJECT_KIND: PROJECT_KIND,
      PROJECT_SCHEMA: PROJECT_SCHEMA,
      PROJECT_SCANS_KEPT: PROJECT_SCANS_KEPT,
      newProject: newProject,
      migrateProject: migrateProject,
      readProject: readProject,
      projectNote: projectNote,
      projectAddBackup: projectAddBackup,
      projectAddScan: projectAddScan,
      latestScan: latestScan,
      scanFileName: scanFileName,
      scanSnapshot: scanSnapshot,
      scanFromSnapshot: scanFromSnapshot,
      logLine: logLine,
      parseLogLines: parseLogLines,
      mergeLogs: mergeLogs,
      recentProjects: recentProjects,
      isPluginFolder: isPluginFolder,
      projectBundle: projectBundle,
      readProjectBundle: readProjectBundle,
      droppedProcesses: droppedProcesses,
      processEdges: processEdges,
      controlEdges: controlEdges,
      usesRemoved: usesRemoved,
      isTM1Applications: isTM1Applications,
      summarise: summarise,
      OBJECT_TYPES: OBJECT_TYPES,
      findingsByType: findingsByType,
      sortFindings: sortFindings,
      findingsCsv: findingsCsv,
      findingKey: findingKey,
      securedDimensions: securedDimensions,
      normName: normName,
      securedElementRefs: securedElementRefs,
      elementSecurityFindings: elementSecurityFindings,
      grantPlan: grantPlan,
      isAdminGroup: function (g) { return !!ADMIN_GROUPS[String(g).toLowerCase()]; },
      objectLink: objectLink,
      isRemovedFunction: function (name) { return !!removedByName[String(name).toLowerCase()]; },
      // TM1 Applications clean-up
      isTpControl: isTpControl,
      tpInventory: tpInventory,
      tpDeleteOrder: tpDeleteOrder,
      tpKey: tpKey,
      objectPath: objectPath,
      definitionPath: definitionPath,
      cubeDataMdx: cubeDataMdx,
      cellsetRows: cellsetRows,
      cellUpdates: cellUpdates,
      stripOdata: stripOdata,
      dimensionCreateBody: dimensionCreateBody,
      cubeCreateBody: cubeCreateBody,
      subsetCreateBody: subsetCreateBody,
      choreCreateBody: choreCreateBody,
      // Bedrock
      BEDROCK_SOURCES: BEDROCK_SOURCES,
      BEDROCK3_MAP: BEDROCK3_MAP,
      BEDROCK4_PARAMS: BEDROCK4_PARAMS,
      bedrockKind: bedrockKind,
      bedrockStatedVersion: bedrockStatedVersion,
      bedrock5Name: bedrock5Name,
      sameProcessCode: sameProcessCode,
      bedrockReference: bedrockReference,
      bedrockParamChanges: bedrockParamChanges,
      callSites: callSites,
      rewriteCall: rewriteCall,
      fixBedrockCallers: fixBedrockCallers,
      fixChoreCallers: fixChoreCallers,
      bedrockInventory: bedrockInventory,
      bedrockDefaultAction: bedrockDefaultAction,
      bedrockCallerPlan: bedrockCallerPlan,
      bedrockBody: bedrockBody,
      processBody: processBody,
      bedrockGroup: bedrockGroup,
      computedBedrockCalls: computedBedrockCalls,
      processCallers: processCallers,
      v12Suggestion: v12Suggestion
   };
}]);

/* Grows a box into the room left above the nearest clipping ancestor: Arc
 * clips a plugin page and never scrolls it (calculation-explorer §2.8), so
 * every tall box scrolls itself. */
/* A draggable splitter between the two panes of an .sm-split (user, 2026-10-02):
 * drag it, or focus it and use the arrow keys; a double-click puts the default
 * split back. The width is a share of the split, kept per tab in this browser
 * (tm1Readiness.split.<name>), and set as --sm-left on the split, so the
 * stacked layout under 1100 px still overrides it. Each side keeps a minimum. */
arc.directive("saasMigSplitter", ['$window', function ($window) {
   return {
      restrict: "A",
      link: function ($scope, element, attrs) {
         var handle = element[0], split = handle.parentNode, key = "tm1Readiness.split." + $scope.$eval(attrs.saasMigSplitter);
         var MIN_LEFT = 320, MIN_RIGHT = 280, STEP = 32;
         handle.setAttribute("role", "separator");
         handle.setAttribute("aria-orientation", "vertical");
         handle.setAttribute("tabindex", "0");
         var read = function () { try { var v = parseFloat($window.localStorage.getItem(key)); return v > 0 && v < 1 ? v : null; } catch (e) { return null; } };
         var store = function (share) { try { if (share) $window.localStorage.setItem(key, String(share)); else $window.localStorage.removeItem(key); } catch (e) { } };
         var setShare = function (share) {
            if (!share) { split.classList.remove("sm-splitset"); split.style.removeProperty("--sm-left"); handle.removeAttribute("aria-valuenow"); return; }
            split.classList.add("sm-splitset");
            split.style.setProperty("--sm-left", (share * 100).toFixed(2) + "%");
            handle.setAttribute("aria-valuenow", String(Math.round(share * 100)));
         };
         // the share for a left width in pixels, kept inside both minimums
         var shareFor = function (px) {
            var total = split.getBoundingClientRect().width - handle.getBoundingClientRect().width;
            if (total <= 0) return null;
            var max = Math.max(MIN_LEFT, total - MIN_RIGHT);
            return Math.min(max, Math.max(MIN_LEFT, px)) / total;
         };
         var leftWidth = function () { var l = split.querySelector(".sm-left"); return l ? l.getBoundingClientRect().width : 0; };
         setShare(read());
         var drag = null;
         var move = function (e) {
            if (!drag) return;
            var s = shareFor(drag.width + (e.clientX - drag.x));
            if (s) setShare(s);
            e.preventDefault();
         };
         var up = function () {
            if (!drag) return;
            drag = null;
            handle.classList.remove("sm-dragging");
            $window.document.body.classList.remove("sm-resizing");
            $window.document.removeEventListener("mousemove", move);
            $window.document.removeEventListener("mouseup", up);
            var v = split.style.getPropertyValue("--sm-left");
            store(v ? parseFloat(v) / 100 : null);
         };
         handle.addEventListener("mousedown", function (e) {
            if (e.button !== 0) return;
            drag = { x: e.clientX, width: leftWidth() };
            handle.classList.add("sm-dragging");
            $window.document.body.classList.add("sm-resizing");
            $window.document.addEventListener("mousemove", move);
            $window.document.addEventListener("mouseup", up);
            e.preventDefault();
         });
         handle.addEventListener("dblclick", function () { setShare(null); store(null); });
         handle.addEventListener("keydown", function (e) {
            var d = e.key === "ArrowLeft" ? -STEP : e.key === "ArrowRight" ? STEP : 0;
            if (!d) return;
            var s = shareFor(leftWidth() + d);
            if (s) { setShare(s); store(s); }
            e.preventDefault();
         });
         $scope.$on("$destroy", function () { up(); });
      }
   };
}]);

arc.directive("saasMigFill", ['$window', '$timeout', function ($window, $timeout) {
   return {
      restrict: "A",
      link: function ($scope, element, attrs) {
         var node = element[0], pad = parseInt(attrs.saasMigFillPad, 10) || 12, min = 160;
         /* The bottom of the nearest clipping or scrolling ancestor, and how far
          * it is scrolled. Since the page scrolls inside Arc's tab (v0.5.14), the
          * list's top is taken as if that ancestor were at the top, or a list
          * sized while the page was scrolled down came out too tall. */
         var floorOf = function () {
            var limit = $window.innerHeight || 900, parent = node.parentNode, scrolled = 0;
            while (parent && parent.nodeType === 1) {
               var o = $window.getComputedStyle(parent).overflowY;
               if (o === "hidden" || o === "auto" || o === "scroll") {
                  var b = parent.getBoundingClientRect().bottom;
                  if (b > 0) limit = Math.min(limit, b);
                  scrolled = parent.scrollTop || 0;
                  break;
               }
               parent = parent.parentNode;
            }
            return { bottom: limit, scrolled: scrolled };
         };
         var apply = function () {
            if (!node.offsetParent) return;
            var f = floorOf();
            element.css("max-height", Math.max(min, Math.round(f.bottom - (node.getBoundingClientRect().top + f.scrolled) - pad)) + "px");
         };
         var queued = false;
         var later = function () {
            if (queued) return;
            queued = true;
            $timeout(function () { queued = false; apply(); }, 0);
         };
         var win = angular.element($window);
         win.on("resize", later);
         /* Re-fit when the content above changes height (user, 2026-10-02): the
          * list was sized once, so a row that wrapped, a chip row or a message that
          * came later left an empty band under it. Its own tab section and the
          * page are observed. The list's own height never moves its top, so the
          * second call it causes changes nothing. */
         var observer = null;
         if ($window.ResizeObserver) {
            observer = new $window.ResizeObserver(later);
            var section = node, root = node.closest ? node.closest(".tm1-readiness-plugin") : null;
            while (section && section.parentNode && section.parentNode !== root) section = section.parentNode;
            if (section && section !== node) observer.observe(section);
            if (root) observer.observe(root);
         }
         $scope.$on("$destroy", function () { win.off("resize", later); if (observer) observer.disconnect(); });
         if (attrs.saasMigFill) $scope.$watch(attrs.saasMigFill, later);
         // the project notice comes and goes above the tabs, outside the observed section
         $scope.$on("tm1-readiness-project", later);
         later();
      }
   };
}]);

/* saas-mig-tip="expression" -- a hover explanation. One floating box for the
 * whole page, placed against the window: a CSS-only tooltip is clipped by the
 * scrolling tables it sits in, and the browser's own `title` is slow and
 * cannot be styled. The expression is evaluated on hover, so it can say
 * something about the row it is on. */
arc.directive("saasMigTip", ['$parse', '$window', function ($parse, $window) {
   var box = null;
   var hide = function () { if (box) box.style.display = "none"; };
   var show = function (el, text) {
      if (!text) return;
      if (!box) {
         box = $window.document.createElement("div");
         box.className = "tm1-readiness-tip";
         $window.document.body.appendChild(box);
      }
      box.textContent = text;
      box.style.display = "block";
      var r = el.getBoundingClientRect(), w = box.offsetWidth, h = box.offsetHeight;
      var top = r.bottom + 6;
      if (top + h > $window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
      box.style.left = Math.max(8, Math.min(r.left, $window.innerWidth - w - 8)) + "px";
      box.style.top = top + "px";
   };
   return {
      restrict: "A",
      link: function ($scope, element, attrs) {
         var get = $parse(attrs.saasMigTip);
         element.addClass("sm-hint");
         element.on("mouseenter", function () { show(element[0], get($scope)); });
         element.on("mouseleave", hide);
         // a click that re-renders the list removes the element under the mouse
         element.on("click", hide);
         $scope.$on("$destroy", hide);
      }
   };
}]);

/* <input type="checkbox" saas-mig-indeterminate="expr"> -- the dash state
 * of a checkbox is a DOM property with no HTML attribute, so it is set here. */
/* <table saas-mig-resizable="'findings'"> -- a drag handle on the right edge of
 * each header cell sets that column's width; a double-click on any handle puts
 * every column back to automatic. The first drag freezes all widths as they
 * are and switches the table to a fixed layout, so one column grows without
 * squeezing the others and the table scrolls sideways instead. Widths are a
 * per-viewer convenience, kept in this browser's local storage. A header cell
 * marked saas-mig-nosize gets no handle. Header text must sit in a child
 * element: `<th translate>` rewrites the cell's content, handle included. */
arc.directive("saasMigResizable", ['$timeout', function ($timeout) {
   return {
      restrict: "A",
      link: function ($scope, element, attrs) {
         var table = element[0], key = "tm1Readiness.colWidths." + $scope.$eval(attrs.saasMigResizable);
         var heads = function () { return Array.prototype.slice.call(table.rows[0] ? table.rows[0].cells : []); };
         var save = function (widths) { try { if (widths) window.localStorage.setItem(key, JSON.stringify(widths)); else window.localStorage.removeItem(key); } catch (e) { } };
         var apply = function (widths) {
            var ths = heads();
            if (!widths || widths.length !== ths.length) {
               table.classList.remove("sm-sized"); table.style.width = "";
               ths.forEach(function (th) { th.style.width = ""; });
               return;
            }
            ths.forEach(function (th, i) { th.style.width = widths[i] + "px"; });
            table.style.width = widths.reduce(function (a, b) { return a + b; }, 0) + "px";
            table.classList.add("sm-sized");
         };
         var current = function () { return heads().map(function (th) { return Math.round(th.getBoundingClientRect().width); }); };
         $timeout(function () {
            var stored = null;
            try { stored = JSON.parse(window.localStorage.getItem(key) || "null"); } catch (e) { stored = null; }
            heads().forEach(function (th, i) {
               if (th.hasAttribute("saas-mig-nosize")) return;
               var grip = document.createElement("div");
               grip.className = "sm-grip";
               grip.title = "Drag to resize; double-click to reset all columns";
               grip.addEventListener("click", function (e) { e.stopPropagation(); });
               grip.addEventListener("dblclick", function (e) { e.stopPropagation(); apply(null); save(null); });
               grip.addEventListener("mousedown", function (e) {
                  if (e.button !== 0) return;
                  e.preventDefault(); e.stopPropagation();
                  var widths = current(), x0 = e.clientX, w0 = widths[i];
                  apply(widths);
                  grip.classList.add("sm-grip-on");
                  var move = function (m) { widths[i] = Math.max(32, w0 + m.clientX - x0); apply(widths); };
                  var up = function () {
                     document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up);
                     grip.classList.remove("sm-grip-on");
                     save(widths);
                  };
                  document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
               });
               th.appendChild(grip);
            });
            apply(stored);
         });
      }
   };
}]);

arc.directive("saasMigIndeterminate", function () {
   return {
      restrict: "A",
      link: function ($scope, element, attrs) {
         $scope.$watch(attrs.saasMigIndeterminate, function (v) { element[0].indeterminate = !!v; });
      }
   };
});

/* <input type="file" saas-mig-file="handler(text, name)"> -- reads the chosen
 * file as text. A person has to pick the file; nothing here can. */
arc.directive("saasMigFile", ['$parse', function ($parse) {
   return {
      restrict: "A",
      link: function ($scope, element, attrs) {
         var handler = $parse(attrs.saasMigFile);
         element.on("change", function () {
            var file = element[0].files && element[0].files[0];
            if (!file) return;
            var reader = new FileReader();
            reader.onload = function () {
               $scope.$apply(function () { handler($scope, { text: String(reader.result || ""), name: file.name }); });
               element[0].value = "";
            };
            reader.readAsText(file);
         });
      }
   };
}]);

/* <input type="file" multiple saas-mig-files="handler(files)"> -- the chosen
 * files as [{name, relPath, size, blob}], unread: the File itself is the Blob
 * the upload sends, byte for byte (plan §2.13). With `webkitdirectory` on the
 * input, relPath carries the folder path inside the picked folder. */
arc.directive("saasMigFiles", ['$parse', function ($parse) {
   return {
      restrict: "A",
      link: function ($scope, element, attrs) {
         var handler = $parse(attrs.saasMigFiles);
         element.on("change", function () {
            var list = Array.prototype.slice.call(element[0].files || []).map(function (f) {
               return { name: f.name, relPath: f.webkitRelativePath || f.name, size: f.size, blob: f };
            });
            element[0].value = "";
            if (list.length) $scope.$apply(function () { handler($scope, { files: list }); });
         });
      }
   };
}]);

/* <div saas-mig-drop="handler(files)" saas-mig-drop-over="flag"> -- a drop
 * target for files and folders. A dropped folder is walked through the
 * entries API, so each file keeps its path below the folder (the same
 * relPath a folder picker gives), which is what tells two same-named files
 * apart. readEntries returns at most 100 entries a call, so it is called
 * until it returns none. */
/* <div saas-mig-portal> -- the element moves to <body> while it exists. A
 * dialog inside the plugin is trapped in Arc's pane, whose stacking context
 * is below the tree pane and the splitter: they drew over it at any z-index. */
arc.directive("saasMigPortal", ["$window", function ($window) {
   return {
      restrict: "A",
      link: function ($scope, element) {
         $window.document.body.appendChild(element[0]);
         $scope.$on("$destroy", function () { element.remove(); });
      }
   };
}]);

/* <span saas-mig-path="expr"> -- a path that may wrap after each "/" and
 * nowhere else unless one part is longer than the cell: a <wbr> after each
 * slash (it is not a character, so a copied path stays exact). Plain
 * overflow-wrap broke "translation" into "translatio" + "n" (user, v0.8.3);
 * with break-word alone the longest file name held its column wide and the
 * table scrolled sideways by 216px at a 915px pane, so the file name, and
 * only it, may still break anywhere. */
arc.directive("saasMigPath", function () {
   return {
      restrict: "A",
      link: function ($scope, element, attrs) {
         $scope.$watch(attrs.saasMigPath, function (v) {
            var node = element[0], parts = String(v == null ? "" : v).split("/");
            while (node.firstChild) node.removeChild(node.firstChild);
            parts.forEach(function (p, i) {
               if (i < parts.length - 1) {
                  node.appendChild(document.createTextNode(p + "/"));
                  node.appendChild(document.createElement("wbr"));
                  return;
               }
               // only the file name may break inside, as a last resort in a narrow pane
               var last = document.createElement("span");
               last.className = "ux-path-file";
               last.textContent = p;
               node.appendChild(last);
            });
         });
      }
   };
});

/* <div saas-mig-autofocus> -- focus moves into a dialog when it opens, so
 * Escape and Tab work in it at once (WCAG 2.4.3). */
arc.directive("saasMigAutofocus", ["$timeout", function ($timeout) {
   return { restrict: "A", link: function ($scope, element) { $timeout(function () { element[0].focus(); }); } };
}]);

arc.directive("saasMigDrop", ['$parse', '$q', function ($parse, $q) {
   return {
      restrict: "A",
      link: function ($scope, element, attrs) {
         var handler = $parse(attrs.saasMigDrop), over = attrs.saasMigDropOver ? $parse(attrs.saasMigDropOver) : null, depth = 0;
         var setOver = function (v) { if (over) $scope.$evalAsync(function () { over.assign($scope, v); }); };
         var walk = function (entry, out) {
            if (entry.isFile) return $q(function (resolve) {
               entry.file(function (f) { out.push({ name: f.name, relPath: String(entry.fullPath || f.name).replace(/^\//, ""), size: f.size, blob: f }); resolve(); }, function () { resolve(); });
            });
            if (!entry.isDirectory) return $q.when();
            var reader = entry.createReader(), all = [];
            var more = function () {
               return $q(function (resolve) { reader.readEntries(resolve, function () { resolve([]); }); }).then(function (batch) {
                  if (!batch.length) return $q.all(all.map(function (e) { return walk(e, out); }));
                  all = all.concat(Array.prototype.slice.call(batch));
                  return more();
               });
            };
            return more();
         };
         element.on("dragenter", function (e) { e.preventDefault(); depth++; setOver(true); });
         element.on("dragover", function (e) { e.preventDefault(); var dt = (e.originalEvent || e).dataTransfer; if (dt) dt.dropEffect = "copy"; });
         element.on("dragleave", function () { depth = Math.max(0, depth - 1); if (!depth) setOver(false); });
         element.on("drop", function (e) {
            e.preventDefault(); depth = 0; setOver(false);
            var dt = (e.originalEvent || e).dataTransfer, out = [];
            if (!dt) return;
            var entries = Array.prototype.slice.call(dt.items || []).map(function (it) { return it.webkitGetAsEntry ? it.webkitGetAsEntry() : null; }).filter(Boolean);
            var done = entries.length ? $q.all(entries.map(function (en) { return walk(en, out); })) :
               $q.when(Array.prototype.slice.call(dt.files || []).forEach(function (f) { out.push({ name: f.name, relPath: f.name, size: f.size, blob: f }); }));
            done.then(function () { if (out.length) handler($scope, { files: out }); });
         });
      }
   };
}]);

arc.directive("tm1Readiness", function () {
   return {
      restrict: "EA",
      replace: true,
      scope: { instance: "=tm1Instance" },
      templateUrl: "__/plugins/tm1-12-readiness/template.html",
      controller: ["$scope", "$rootScope", "$state", "$tm1", "$http", "$translate", "$sce", "$q", "$timeout", "Notification", "saasMigrationCore", "tm1ReadinessRequest", "tm1ReadinessProject",
         function ($scope, $rootScope, $state, $tm1, $http, $translate, $sce, $q, $timeout, Notification, core, tm1ReadinessRequest, project) {

            /* $translate.instant returns a $sce wrapper under Arc's sanitising
             * configuration (calculation-explorer §2.9), so every string that
             * reaches JavaScript is unwrapped here. */
            var t = function (key, values) {
               var v = $translate.instant(key);
               if (typeof v !== "string") { v = $sce.valueOf(v); if (typeof v !== "string") v = String(key); }
               angular.forEach(values || {}, function (value, name) { v = v.split("{" + name + "}").join(String(value)); });
               return v;
            };

            // the same, for the template, where a value goes into the text
            $scope.tx = function (key, values) { return t(key, values); };

            var SELECT_PROCESSES = "/Processes?$select=Name,PrologProcedure,MetadataProcedure,DataProcedure,EpilogProcedure,DataSource,Parameters,Variables";
            var SELECT_DIMENSIONS = "/Dimensions?$select=Name&$expand=Hierarchies($select=Name;$expand=Subsets($select=Name,Expression),ElementAttributes($select=Name,Type))";
            var CP_ELEMENTS = "/Dimensions('%7DClientProperties')/Hierarchies('%7DClientProperties')/Elements";

            $scope.core = core;
            $scope.version = core.VERSION;
            $scope.state = {
               tab: "overview",
               instances: [],
               instance: $scope.instance || null,
               target: null,          // optional TM1 v12 instance for the compile check
               user: null,
               productVersion: null,
               busy: null,
               error: null,
               scan: null,
               filters: { severity: "", objectType: "", text: "", fixableOnly: false, showApps: false, showBedrock: false, deprecatedOnly: false, showSkipped: false },
               selected: {},
               detail: null,
               bulk: null,
               log: [],
               backups: [],
               restore: null,
               cloud: null,
               v12check: null,
               tp: null,
               bedrock: { source: "github", reference: null, inv: null, choice: {}, install: {}, fixCallers: true },
               cancel: false
            };

            // ----------------------------------------------------------------- I/O

            /* One request, with the 401/403-after-load retry calculation-explorer
             * measured (its §2.15): the session re-establishes asynchronously. */
            var call = function (instance, method, path, body, retries) {
               var left = retries === undefined ? 4 : retries, started = Date.now();
               // diagnostics: a failed or slow call, path decoded so names reach the scrubber
               var trace = function (status, error) {
                  var ms = Date.now() - started, p = path;
                  try { p = decodeURIComponent(path); } catch (e) { }
                  if (status >= 400 || status === "threw" || ms > 10000) diag("rest", { method: method, path: p.replace(/\?.*$/, ""), status: status, ms: ms, error: error || undefined });
               };
               return $tm1.async(instance, method, path, body).then(function (r) {
                  if ((r.status === 401 || r.status === 403) && left > 0) {
                     return $timeout(function () { }, 2500).then(function () { return call(instance, method, path, body, left - 1); });
                  }
                  trace(r.status, r.status >= 400 ? errorText(r) : null);
                  return r;
               }, function (e) {
                  trace("threw", String(e && (e.message || e.status) || e));
                  return $q.reject(e);
               });
            };
            /* Deletes go direct (user, 2026-10-06: "deletion is so slow"). $tm1.async sends every call
             * as a TM1 async job (`Prefer: respond-async`) and polls about a second later: measured
             * 1,040 ms for a GET TM1 answered in 12 ms, so each deleted object (a DELETE and the read
             * that must answer 404) cost two seconds. The same Arc path through $http, with the
             * x-host-id / x-instance-id headers Arc itself sends (HostID and ID from $tm1.instance),
             * answered in 10-20 ms on local databases and 165-311 ms on PA as a Service; without them
             * Arc answers 401 for any database but the page's own. There is no async fallback: the
             * guardrails are in deleteObject. Each request has a time limit, so a proxy that never
             * answers cannot hold the run; a time-out comes back with no status ("unknown"). */
            var hostIds = {};
            var direct = function (instance, method, path, ms) {
               var ids = hostIds[instance] || (hostIds[instance] = $q.when($tm1.instance(instance)).then(function (i) {
                  return i && i.HostID && i.ID ? { host: i.HostID, id: i.ID } : null;
               }, function () { return null; }));
               return ids.then(function (h) {
                  if (!h) { delete hostIds[instance]; return { status: 0, noIds: true }; }
                  var started = Date.now();
                  return $http({ method: method, url: instance + path, timeout: ms,
                     headers: { Accept: "application/json", "x-host-id": h.host, "x-instance-id": h.id } })
                     .then(function (r) { return r; }, function (r) {
                        r = r || { status: -1 };
                        if (!(r.status > 0)) r.timedOut = r.xhrStatus === "timeout" || Date.now() - started >= ms - 50;
                        return r;
                     });
               });
            };
            // a 401/403 in the first seconds is the session reconnecting (calculation-explorer §2.15): asked again for ~10 s
            var directSignedIn = function (instance, method, path, ms, tries) {
               tries = tries === undefined ? 4 : tries;
               return direct(instance, method, path, ms).then(function (r) {
                  if (core.deleteAnswer(r) !== "auth" || tries <= 0) return r;
                  delete hostIds[instance];
                  return $timeout(function () { }, 2500).then(function () { return directSignedIn(instance, method, path, ms, tries - 1); });
               });
            };
            var ok = function (r) { return !!r && r.status >= 200 && r.status < 300; };
            var errorText = function (r) {
               if (!r) return "no response";
               var d = r.data;
               return "HTTP " + r.status + (d && d.error && d.error.message ? ": " + d.error.message : "");
            };
            var must = function (r) { if (!ok(r)) throw new Error(errorText(r)); return r; };

            /* A silent download to the browser's Downloads folder (§2.4, row 0.9). */
            var saveFile = function (name, text, type) {
               var blob = new Blob([text], { type: type || "application/json" });
               var url = URL.createObjectURL(blob);
               var a = document.createElement("a");
               a.href = url; a.download = name;
               document.body.appendChild(a); a.click(); a.remove();
               $timeout(function () { URL.revokeObjectURL(url); }, 5000);
            };
            // a seam, so a live check can observe the backup without a download
            $scope.saveFile = saveFile;

            /* The log is kept in this browser (user, 2026-10-02), so it survives a
             * reload or an Arc restart: newest first, LOG_KEEP entries, each with
             * the database it is about. Delete clears it; Download saves a copy.
             * Storage can be off or full: the page then keeps the log in memory. */
            var LOG_STORE = "tm1Readiness.log", LOG_KEEP = 2000;
            var saveLog = function () {
               try { window.localStorage.setItem(LOG_STORE, JSON.stringify($scope.state.log)); } catch (e) { }
            };
            var log = function (kind, text) {
               var e = { at: new Date(), kind: kind, text: text, instance: $scope.state.instance || "" };
               $scope.state.log.unshift(e);
               if ($scope.state.log.length > LOG_KEEP) $scope.state.log.length = LOG_KEEP;
               saveLog();
               // the project's copy is never cut to LOG_KEEP: it is the migration's record
               if (project.canWrite()) { logBuffer.push(core.logLine(e)); if (!logFlushing) logFlushing = setTimeout(flushLog, 1000); }
               diag("log", { logKind: kind, text: String(text) });
            };
            /* Written once a second, not once a line: each append cost ~24 ms and seven page digests,
             * and a clean-up logs one line per deleted object (measured 2026-10-06). A plain timeout,
             * so waiting costs no digest; a close or a switch flushes first. */
            var logBuffer = [], logFlushing = null;
            var flushLog = function () {
               if (logFlushing) { clearTimeout(logFlushing); logFlushing = null; }
               if (!logBuffer.length || !project.canWrite()) { logBuffer = []; return $q.when(); }
               var text = logBuffer.join(""); logBuffer = [];
               return project.append("log.jsonl", text).catch(angular.noop);
            };
            $scope.$on("$destroy", function () { flushLog(); });

            // ------------------------------------------------------- diagnostics

            /* A technical trace another user can download and send, so a reported
             * issue can be analysed and fixed (user, 2026-10-03). Off by default
             * (user, v0.7.1: it asked a choice of every user before); nothing is
             * recorded until the user picks a mode; every field goes through the
             * core's scrubber for that mode, and the pseudonym map never leaves
             * this browser. Process code, MDX and cell values are never recorded.
             * Changing the mode starts a new log, so one file never mixes two
             * levels of scrubbing. */
            var DIAG_STORE = "tm1Readiness.diag", DIAG_MAP = "tm1Readiness.diag.map", DIAG_MODE = "tm1Readiness.diag.mode", DIAG_KEEP = 3000;
            var readStore = function (k, d) { try { var v = window.localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } };
            var writeStore = function (k, v) { try { window.localStorage.setItem(k, JSON.stringify(v)); } catch (e) { } };
            $scope.diag = { mode: readStore(DIAG_MODE, null), entries: readStore(DIAG_STORE, []) || [] };
            if (core.DIAG_MODES.indexOf($scope.diag.mode) < 0) $scope.diag.mode = "off";
            var diagMap = readStore(DIAG_MAP, null) || { next: {}, tokens: {} };
            var arcVersion = function () {
               var s = document.querySelector('script[src*="plugins__v"]'), m = s && /plugins__v([\d.]+)\.js/.exec(s.getAttribute("src") || "");
               return m ? m[1] : "";
            };
            var diagScrubber = function () {
               var s = $scope.state.scan, extra = [];
               ($scope.state.instances || []).concat([$scope.state.instance]).forEach(function (n) { if (n) extra.push({ type: "Database", name: n }); });
               if ($scope.state.user && $scope.state.user.Name) extra.push({ type: "User", name: $scope.state.user.Name });
               return core.diagScrubber($scope.diag.mode, core.diagIndex(s && s.model, extra), diagMap);
            };
            var diag = function (kind, fields) {
               if (!$scope.diag || !$scope.diag.mode || $scope.diag.mode === "off") return;
               var scrubber = diagScrubber();
               $scope.diag.entries.push(core.diagEntry(scrubber, kind, angular.extend({ database: $scope.state.instance || "" }, fields || {})));
               if ($scope.diag.entries.length > DIAG_KEEP) $scope.diag.entries.splice(0, $scope.diag.entries.length - DIAG_KEEP);
               writeStore(DIAG_STORE, $scope.diag.entries);
               writeStore(DIAG_MAP, scrubber.map);
            };
            var sessionInfo = function () {
               return { plugin: core.VERSION, arc: arcVersion(), browser: navigator.userAgent, window: window.innerWidth + "x" + window.innerHeight,
                  tm1: $scope.state.productVersion || "", v12: $scope.state.productVersion ? $scope.isV12() : null,
                  admin: $scope.state.user ? $scope.isAdmin() : null, user: $scope.state.user && $scope.state.user.Name || "" };
            };
            $scope.setDiagMode = function (mode) {
               if (core.DIAG_MODES.indexOf(mode) < 0 || mode === $scope.diag.mode) return;
               if ($scope.diag.mode && $scope.diag.entries.length && !window.confirm(t("SAASMIG_DIAGMODECHANGE", { n: $scope.diag.entries.length }))) return;
               $scope.diag.entries = []; diagMap = { next: {}, tokens: {} };
               writeStore(DIAG_STORE, []); writeStore(DIAG_MAP, diagMap);
               $scope.diag.mode = mode; writeStore(DIAG_MODE, mode);
               diag("session", sessionInfo());
            };
            var DIAG_LABEL = { off: "SAASMIG_DIAGOFF", pseudonym: "SAASMIG_DIAGPSEUDONYM", removed: "SAASMIG_DIAGREMOVED", full: "SAASMIG_DIAGFULL" };
            var DIAG_HELP = { off: "SAASMIG_DIAGOFFHELP", pseudonym: "SAASMIG_DIAGPSEUDONYMHELP", removed: "SAASMIG_DIAGREMOVEDHELP", full: "SAASMIG_DIAGFULLHELP" };
            $scope.dfDiagLabel = function (m) { return t(DIAG_LABEL[m]); };
            $scope.dfDiagHelp = function (m) { return t(DIAG_HELP[m]); };
            $scope.clearDiag = function () {
               if (!window.confirm(t("SAASMIG_DIAGCLEARCONFIRM", { n: $scope.diag.entries.length }))) return;
               $scope.diag.entries = []; diagMap = { next: {}, tokens: {} };
               writeStore(DIAG_STORE, []); writeStore(DIAG_MAP, diagMap);
            };
            $scope.downloadDiag = function () {
               var head = { type: "tm1-12-readiness-diagnostics", created: new Date().toISOString(), mode: $scope.diag.mode, plugin: core.VERSION, arc: arcVersion(),
                  browser: navigator.userAgent, entries: $scope.diag.entries.length };
               var lines = [JSON.stringify(head)].concat($scope.diag.entries.map(function (e) { return JSON.stringify(e); }));
               $scope.saveFile("tm1-12-readiness-diagnostics-" + new Date().toISOString().replace(/[:.]/g, "").slice(0, 15) + ".jsonl", lines.join("\r\n") + "\r\n");
            };
            $scope.$watch("state.tab", function (now, was) { if (now && now !== was) diag("tab", { tab: now }); });
            $scope.$watch("state.error", function (now) { if (now) diag("error", { text: String(now) }); });
            (function () {
               var stored = null;
               try { stored = JSON.parse(window.localStorage.getItem(LOG_STORE) || "null"); } catch (e) { stored = null; }
               if (Array.isArray(stored)) $scope.state.log = stored.map(function (l) { return { at: new Date(l.at), kind: l.kind, text: l.text, instance: l.instance || "" }; });
            })();
            $scope.deleteLog = function () {
               if (!window.confirm(t("SAASMIG_LOGDELETECONFIRM", { n: $scope.state.log.length }))) return;
               $scope.state.log = [];
               try { window.localStorage.removeItem(LOG_STORE); } catch (e) { }
            };
            $scope.downloadLog = function () {
               var lines = $scope.state.log.slice().reverse().map(function (l) {
                  return [l.at.toISOString(), l.instance, l.kind, String(l.text).replace(/\s+/g, " ")].join("\t");
               });
               $scope.saveFile("tm1-12-readiness-log-" + new Date().toISOString().slice(0, 10) + ".txt", ["when\tdatabase\tkind\ttext"].concat(lines).join("\r\n"));
            };

            // ------------------------------------------------------------ projects

            /* A project (v0.14.0) keeps this migration's scans, step status,
             * results, backups and log in a folder the user picks, so the work
             * can stop and continue later. It is optional: with none open, every
             * path below is a no-op and the page is as it was. The open project
             * is the page's (tm1ReadinessProject), shared by every plugin tab. */
            $scope.project = project;
            $scope.prj = { view: "start", form: null, problem: null, note: null, dirty: false };
            $scope.prjSupported = project.supported;

            /* The Project field's helper (design/project-entry-options.html, option 1, chosen by the user
             * 2026-10-06). Three UX reviews agreed a standing pitch goes unread within a couple of sessions
             * -- and takes the save status down with it -- so the line says something only when it is
             * true and timely, and is empty otherwise: the field then just reads "No project". */
            /* Facts (the save status, "this database is in a project") always show. Pitches (the intro,
             * "Not saved", "your scan wasn't kept") show in the first PITCH_SESSIONS page loads that had
             * one, then stop -- unless the user has used projects, for whom they stay useful. */
            var PITCH_STORE = "tm1Readiness.project.pitchSessions", LOST_STORE = "tm1Readiness.project.lostScan.", PITCH_SESSIONS = 2;
            var pitchSessions = readStore(PITCH_STORE, 0) || 0, pitchCounted = false;
            var pitchOk = function () { return (project.recent || []).length > 0 || pitchSessions < PITCH_SESSIONS; };
            var pitched = function () { if (!pitchCounted) { pitchCounted = true; writeStore(PITCH_STORE, pitchSessions + 1); } };
            $scope.prjPitchOk = pitchOk;
            /* A scan made without a project is lost on reload. Its time is noted per database, so the next
             * visit can say so once, truthfully -- the stamp is cleared when a project opens or a scan lands. */
            var noteLostScan = function (inst, at) { if (!project.isOpen()) writeStore(LOST_STORE + inst, at.toISOString()); };
            var lostScan = function (inst) { var v = readStore(LOST_STORE + inst, null); return v ? new Date(v) : null; };
            var clearLostScan = function (inst) { try { window.localStorage.removeItem(LOST_STORE + inst); } catch (e) { } };
            var prjMatch = function (inst) {
               return inst ? (project.recent || []).filter(function (r) { return r.databases && (r.databases.v11 === inst || r.databases.v12 === inst); })[0] || null : null;
            };
            var hintCache = { key: null, value: null };
            $scope.prjHint = function () {
               var c = project.current, inst = $scope.state.instance, s = $scope.state.scan, h;
               // a project that already holds this database is offered first, scan or not: "Keep it" would make a second one
               var scanHere = !!(s && s.instance === inst && !s.fromProject), lost = !scanHere && lostScan(inst), match = prjMatch(inst);
               if (c && c.project && c.backend) {
                  var st = $scope.prjStatus();
                  h = c.status === "perm" ? { cls: st.cls, text: t("SAASMIG_PRJHINTUNSAVED"), act: t("SAASMIG_PRJHINTALLOW"), go: "allow" }
                     : c.status === "missing" ? { cls: st.cls, text: t("SAASMIG_PRJHINTUNSAVED"), act: t("SAASMIG_PRJFIND"), go: "find" }
                     : { cls: st.cls, text: st.text, act: st.download ? t("SAASMIG_PRJDOWNLOADSHORT") : null, go: st.download ? "download" : null };
               } else if (c && c.status === "perm") h = { cls: "sm-prj-warn", text: t("SAASMIG_PRJHINTUNSAVED"), act: t("SAASMIG_PRJHINTALLOW"), go: "allow" };
               else if (match) h = { cls: "", text: t("SAASMIG_PRJHINTMATCH", { name: match.name }), act: t("SAASMIG_PRJHINTCONTINUE"), go: "continue", row: match };
               else if (scanHere && pitchOk()) h = { cls: "", text: t("SAASMIG_PRJHINTUNSAVED"), act: t("SAASMIG_PRJHINTKEEP"), go: "keep", pitch: true };
               else if (lost && pitchOk()) h = { cls: "", text: t("SAASMIG_PRJHINTLOST", { at: lost.getDate() + " " + MONTHS[lost.getMonth()] }), act: t("SAASMIG_PRJHINTSTART"), go: "keep", pitch: true };
               else if (pitchOk() && !(project.recent || []).length) h = { cls: "", text: t("SAASMIG_PRJHINTINTRO"), act: t("SAASMIG_PRJHINTSTARTONE"), go: "new", pitch: true };
               else h = { cls: "", text: "", act: null, go: null };
               if (h.pitch) pitched();
               // one object per distinct hint, so the digest sees a stable value
               var key = [h.cls, h.text, h.act, h.go].join("\u0001");
               if (hintCache.key !== key) hintCache = { key: key, value: h };
               else hintCache.value.row = h.row;
               return hintCache.value;
            };
            var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
            $scope.prjHintDo = function () {
               var h = $scope.prjHint();
               if (h.go === "download") return $scope.prjDownload();
               if (h.go === "allow") return $scope.prjAllow();
               if (h.go === "find") return $scope.prjFind();
               if (h.go === "continue") return $scope.prjOpenRecent(h.row);
               if (h.go === "keep") return $scope.prjKeep();
               if (h.go === "new") { $scope.state.tab = "project"; $scope.prjStartNew(); }
            };
            /* "Keep it in a project": the New form, with what this session has already ticked, so the
             * scan, its backups and the log go in without a rescan. */
            $scope.prjKeep = function () {
               $scope.state.tab = "project";
               $scope.prjStartNew();
               $scope.prj.form.keep = true;
            };

            var prjProblem = function (e) {
               var code = e && e.code;
               if (e && e.name === "AbortError") return null; // the picker was cancelled: nothing happened
               var key = { json: "SAASMIG_PRJBROKEN", kind: "SAASMIG_PRJNOTPRJ", notproject: "SAASMIG_PRJNOTPRJ", newer: "SAASMIG_PRJNEWER",
                  denied: "SAASMIG_PRJDENIED", missing: "SAASMIG_PRJMISSING", locked: "SAASMIG_PRJLOCKED" }[code];
               return key ? { code: code, text: t(key, { file: "project.json", v: e.version || "?", mine: core.VERSION }) }
                  : { code: "error", text: String(e && (e.message || e.code) || e) };
            };
            var showProblem = function (e) { $scope.prj.problem = prjProblem(e); if ($scope.prj.problem) diag("project", { problem: $scope.prj.problem.code }); };

            /* A database the project does not name yet takes the empty slot of its
             * kind, so a scan of the TM1 12 database files itself in. Anything
             * scanned is saved either way: the project keeps one record per database. */
            var prjAdopt = function (inst) {
               var m = project.current.project, slot = $scope.isV12() ? "v12" : "v11";
               if (inst && m.databases.v11 !== inst && m.databases.v12 !== inst && !m.databases[slot]) m.databases[slot] = inst;
            };
            var prjSave = function () { return project.canWrite() ? project.saveManifest().catch(angular.noop) : $q.when(); };
            var prjNote = function (inst, patch) {
               if (!project.canWrite() || !inst) return $q.when();
               core.projectNote(project.current.project, inst, patch);
               return prjSave();
            };
            var prjJson = function (path, value) { return project.canWrite() ? project.write(path, JSON.stringify(value, null, 1)) : $q.reject(new Error("no project")); };

            var prjSaveScan = function (result) {
               if (!project.canWrite() || result.fromProject) return $q.when(false);
               var file = core.scanFileName(result.instance, result.at), sum = core.summarise(result.findings);
               prjAdopt(result.instance);
               return prjJson("scans/" + file, core.scanSnapshot(result)).then(function () {
                  var drop = core.projectAddScan(project.current.project, { file: file, instance: result.instance, at: result.at.toISOString(),
                     findings: sum.total, blockers: sum.bySeverity.BLOCKER });
                  drop.forEach(function (f) { project.remove("scans/" + f).catch(angular.noop); });
                  return prjSave();
               }).then(function () { return true; }, function () { return false; });
            };

            /* Exports land in results/ while a project is open; a failed write
             * downloads instead, so the user still gets the file. */
            var exportFile = function (name, text, type) {
               if (!project.canWrite()) { saveFile(name, text, type); return; }
               project.write("results/" + name, text).then(function () {
                  Notification.success({ message: t("SAASMIG_PRJEXPORTED", { file: "results/" + name }) });
               }, function () { saveFile(name, text, type); });
            };

            /* What the project knows about one database, put back on the page: the
             * step status, the read migrate.log, the compare and compile results,
             * skips, and the latest scan -- read-only until scanned again. Called
             * when a project opens and whenever the database picker moves. */
            var restoring = 0;
            var restoreFromProject = function (inst) {
               if (!project.isOpen() || !inst) return $q.when();
               var m = project.current.project, steps = (m.instances[inst] || {}).steps || {}, still = function () { return $scope.state.instance === inst && project.isOpen(); };
               restoring++;
               var jobs = [];
               jobs.push(project.read("skips/" + core.safeName(inst) + ".json").then(function (text) {
                  var keys = null;
                  try { keys = JSON.parse(text || "null"); } catch (e) { keys = null; }
                  if (!keys || !still()) return;
                  var mine = {};
                  try { mine = JSON.parse(window.localStorage.getItem(SKIP_STORE + inst) || "{}") || {}; } catch (e) { mine = {}; }
                  Object.keys(keys).forEach(function (k) { mine[k] = keys[k]; });
                  try { window.localStorage.setItem(SKIP_STORE + inst, JSON.stringify(mine)); } catch (e) { }
                  if (skips.instance === inst) skips.instance = undefined;  // reread on next use
               }));
               if (steps.savedData && !$scope.state.savedData) $scope.state.savedData = { instance: inst, at: new Date(steps.savedData.at), seconds: steps.savedData.seconds, fromProject: true };
               if (steps.cmdCopied && !$scope.state.cmdCopied) $scope.state.cmdCopied = inst;
               if (m.databases.v12 && m.databases.v12 !== inst && !$scope.state.target && _.includes($scope.state.instances, m.databases.v12) && inst !== m.databases.v12) $scope.state.target = m.databases.v12;
               if (steps.cmdDirs && !readStore(CMD_DIRS + inst, null)) { writeStore(CMD_DIRS + inst, steps.cmdDirs); if ($scope.state.cmdDirsBy) delete $scope.state.cmdDirsBy[inst]; }
               var scanJob = $q.when();
               var latest = core.latestScan(m, inst);
               if (latest && !($scope.state.scan && $scope.state.scan.instance === inst)) {
                  scanJob = project.read("scans/" + latest.file).then(function (text) {
                     var s = text && core.scanFromSnapshot(text);
                     if (!s || !still() || ($scope.state.scan && $scope.state.scan.instance === inst)) return;
                     s.findings.forEach(function (f, i) { f.id = i; });
                     $scope.state.scan = s;
                     $scope.state.scanNote = { kind: "project", instance: inst, at: s.at };
                     refreshWhenReady(inst);
                  });
               }
               jobs.push(scanJob);
               // the migrate.log is compared with the scan, so it is read after it
               if (steps.migrateLog && !$scope.state.migrateLog) jobs.push(scanJob.then(function () {
                  return project.read("inputs/" + steps.migrateLog.file).then(function (text) { if (text !== null && still()) $scope.readLog(text, steps.migrateLog.name, true); });
               }));
               var result = function (key, revive) {
                  if (!steps[key] || !steps[key].file || $scope.state[key]) return;
                  jobs.push(project.read("results/" + steps[key].file).then(function (text) {
                     var v = null;
                     try { v = JSON.parse(text || "null"); } catch (e) { v = null; }
                     if (!v || !still() || $scope.state[key]) return;
                     revive(v); v.fromProject = true;
                     $scope.state[key] = v;
                  }));
               };
               result("compare", function (v) { v.at = new Date(v.at); });
               result("v12check", function (v) { v.at = new Date(v.at); if (v.finished) v.finished = new Date(v.finished); });
               return $q.all(jobs).catch(angular.noop).finally(function () { restoring--; });
            };

            /* A saved scan is for reading only (saveBackup refuses a write built from it), so continuing a
             * project used to mean knowing to press Scan again: the user selected 19 fixes and got
             * "stopped after 0 of 19" (2026-10-06). Now the saved result shows at once and a fresh scan
             * starts as soon as the database answers -- read-only, 10-20 s -- and its note says what
             * changed since the save. Until then every write button is disabled, saying why. If the
             * database never signs in, the note offers Scan again; the watch gives up after two minutes. */
            $scope.scanStale = function () { return !!($scope.state.scan && $scope.state.scan.fromProject); };
            var refreshWhenReady = function (inst) {
               var stop = $scope.$watch(function () {
                  var s = $scope.state.scan;
                  return !!(s && s.fromProject && s.instance === inst && $scope.state.instance === inst && $scope.state.productVersion && !$scope.state.busy);
               }, function (ready) {
                  if (!ready) return;
                  stop();
                  if ($scope.state.scanNote && $scope.state.scanNote.kind === "project") $scope.state.scanNote.refreshing = true;
                  $scope.scan();
               });
               $timeout(stop, 120000, false);
            };

            // the step status, saved as it happens
            $scope.$watch("state.savedData", function (v) {
               if (v && !v.fromProject && !restoring) prjNote(v.instance, { savedData: { at: v.at.toISOString(), seconds: v.seconds } });
            });
            $scope.$watch("state.cmdCopied", function (v) { if (v && !restoring) prjNote(v, { cmdCopied: true }); });
            $scope.$watch("state.compare", function (v) {
               var inst = $scope.state.instance;
               if (!v || v.fromProject || restoring || !project.canWrite()) return;
               var file = "compare-" + core.safeName(inst) + ".json";
               prjJson("results/" + file, v).then(function () { return prjNote(inst, { compare: { file: file, at: v.at.toISOString() } }); }).catch(angular.noop);
            });
            $scope.$watch("state.v12check.finished", function (done) {
               var v = $scope.state.v12check, inst = $scope.state.instance;
               if (!done || !v || v.fromProject || restoring || !project.canWrite()) return;
               var file = "v12check-" + core.safeName(inst) + ".json";
               prjJson("results/" + file, v).then(function () { return prjNote(inst, { v12check: { file: file, at: v.at.toISOString() } }); }).catch(angular.noop);
            });
            var prjSaveMigrateLog = function (text, name) {
               var inst = $scope.state.instance, file = "migrate-" + core.safeName(inst) + ".log";
               if (!project.canWrite()) return;
               project.write("inputs/" + file, text).then(function () { return prjNote(inst, { migrateLog: { file: file, name: name } }); }).catch(angular.noop);
            };

            /* After a project opens: its log joins this browser's, its backups
             * join the Backups tab, and the page moves to its database if nothing
             * else is on screen. */
            var afterOpen = function () {
               var m = project.current.project;
               if (m.hostPath) project.ensureDir(core.PROJECT_OUTPUT_DIR);
               $scope.prj.problem = null;
               if ($scope.state.instance) clearLostScan($scope.state.instance);
               $scope.prj.view = "detail";
               diag("project", { opened: project.current.mode });
               var known = {};
               $scope.state.backups.forEach(function (b) { known[b.name] = 1; });
               m.backups.forEach(function (b) {
                  if (!known[b.file]) $scope.state.backups.push({ name: b.file, at: new Date(b.at), count: b.count, instance: b.instance, backup: null, where: "project" });
               });
               $scope.state.backups.sort(function (a, b) { return b.at - a.at; });
               var logJob = project.read("log.jsonl").then(function (text) {
                  $scope.state.log = core.mergeLogs($scope.state.log, core.parseLogLines(text), LOG_KEEP);
                  saveLog();
               }).catch(angular.noop);
               var home = m.databases.v11 || m.databases.v12, here = $scope.state.instance;
               var mine = here && (here === m.databases.v11 || here === m.databases.v12 || m.instances[here]);
               if (!mine && home && _.includes($scope.state.instances, home) && !($scope.state.scan && $scope.state.scan.instance === here)) {
                  $scope.state.instance = home;   // the instance watch restores it
                  return logJob;
               }
               return $q.all([logJob, restoreFromProject(here)]);
            };

            $scope.prjStartNew = function (picked) {
               var inst = $scope.state.instance, v12 = $scope.isV12();
               $scope.prj.problem = null;
               $scope.prj.view = "new";
               $scope.prj.form = { name: inst ? t("SAASMIG_PRJNAMEDEFAULT", { db: inst }) : "", v11: v12 ? "" : (inst || ""), v12: v12 ? inst : "",
                  picked: picked || null, folderNote: null, keep: true, errors: {} };
            };
            $scope.prjChoose = function () {
               var f = $scope.prj.form;
               return project.pickFolder().then(function (picked) {
                  f.errors.folder = null; f.folderNote = null; f.existing = null;
                  if (core.isPluginFolder(picked.names)) { f.picked = null; f.folderNote = "plugin"; return; }
                  if (picked.projectText !== null) {
                     var r = core.readProject(picked.projectText);
                     f.picked = null; f.folderNote = "project"; f.existing = { picked: picked, name: r.project ? r.project.name : picked.name };
                     return;
                  }
                  f.picked = picked;
                  if (picked.names.length) f.folderNote = "busy";
               }, function (e) { if (!(e && e.name === "AbortError")) showProblem(e); });
            };
            /* Create. With "keep" ticked, what this session already did goes in:
             * the scan on screen, the backups made so far, and the log. */
            $scope.prjCreate = function () {
               var f = $scope.prj.form, inMemory = !project.supported();
               flushLog();  // lines logged for a project still open belong to it, not the new one
               f.errors = {};
               if (!String(f.name || "").trim()) f.errors.name = true;
               if (!inMemory && !f.picked) f.errors.folder = true;
               if (f.errors.name || f.errors.folder) return $q.when();
               $scope.state.busy = t("SAASMIG_PRJOPENING");
               return project.create({ name: f.name, v11: f.v11 || null, v12: f.v12 || null, handle: f.picked && f.picked.handle }).then(function () {
                  if (!f.keep) return;
                  var jobs = [], s = $scope.state.scan;
                  if (s && !s.fromProject) jobs.push(prjSaveScan(s));
                  $scope.state.backups.forEach(function (b) {
                     if (!b.backup) return;
                     jobs.push(project.write("backups/" + b.name, JSON.stringify(b.backup, null, 2)).then(function () {
                        b.where = "project";
                        core.projectAddBackup(project.current.project, { file: b.name, instance: b.backup.instance, at: b.at.toISOString(), count: b.count });
                     }));
                  });
                  var lines = $scope.state.log.slice().reverse().map(core.logLine).join("");
                  if (lines) jobs.push(project.write("log.jsonl", lines));
                  var inst = $scope.state.instance, st = $scope.state;
                  if (st.savedData && st.savedData.instance === inst) core.projectNote(project.current.project, inst, { savedData: { at: st.savedData.at.toISOString(), seconds: st.savedData.seconds } });
                  if (st.cmdCopied === inst) core.projectNote(project.current.project, inst, { cmdCopied: true });
                  return $q.all(jobs).then(prjSave);
               }).then(function () {
                  $scope.prj.view = "detail";
                  $scope.prj.note = "created";
                  $scope.prj.form = null;
                  if ($scope.state.instance) clearLostScan($scope.state.instance);

                  log("project", t("SAASMIG_LOGPRJCREATED", { name: project.current.project.name }));
                  if (project.current.mode === "browser") return $scope.prjDownload();
               }).catch(showProblem).finally(function () { $scope.state.busy = null; });
            };

            var openWith = function (promise) {
               flushLog();
               $scope.prj.problem = null; $scope.prj.note = null;

               $scope.state.busy = t("SAASMIG_PRJOPENING");
               return promise.then(function () {
                  log("project", t("SAASMIG_LOGPRJOPENED", { name: project.current.project.name }));
                  return afterOpen();
               }).catch(showProblem).finally(function () { $scope.state.busy = null; });
            };
            $scope.prjOpenFolder = function () {
               return project.pickFolder().then(function (picked) {
                  if (core.isPluginFolder(picked.names)) { $scope.prj.problem = { code: "plugin", text: t("SAASMIG_PRJPLUGINFOLDER") }; return; }
                  if (picked.projectText === null) { $scope.prj.problem = { code: "notproject", text: t("SAASMIG_PRJNOTPRJ"), picked: picked }; return; }
                  return openWith(project.openPicked(picked));
               }, function (e) { if (!(e && e.name === "AbortError")) showProblem(e); });
            };
            $scope.prjOpenPicked = function (picked) { return openWith(project.openPicked(picked)); };
            $scope.prjOpenRecent = function (row) {
               if (project.isOpen() && project.current.project.id === row.id) { $scope.prj.view = "detail"; return $q.when(); }
               return openWith(project.openRecent(row));
            };
            // a project opened from its file starts as downloaded: nothing in it is new yet
            $scope.prjImport = function (text) {
               return openWith(project.importBundle(text)).then(function () { return project.idle(); }).then(function () {
                  if (project.current) $scope.prj.downloadedAt = project.current.savedAt || new Date();
               });
            };
            $scope.prjAllow = function () { return openWith(project.reconnect()); };
            // a folder that moved: pick it where it is now
            $scope.prjFind = function () { return $scope.prjOpenFolder(); };
            $scope.prjForget = function (row) { return project.forget(row.id); };
            $scope.prjClose = function () {
               var name = project.current && (project.current.project ? project.current.project.name : project.current.name);
               flushLog();
               project.close();
               $scope.prj.view = "start"; $scope.prj.note = "closed"; $scope.prj.problem = null;
               // backups that live only in the folder leave the list with it
               $scope.state.backups = $scope.state.backups.filter(function (b) { return !!b.backup; });
               if ($scope.state.scan && $scope.state.scan.fromProject) { $scope.state.scan = null; $scope.state.scanNote = null; }
               if (name) log("project", t("SAASMIG_LOGPRJCLOSED", { name: name }));
            };
            $scope.prjDownload = function () {
               return project.bundle().then(function (text) {
                  saveFile(core.safeName(project.current.project.name) + ".tm1-readiness-project.json", text);
                  $scope.prj.downloadedAt = project.current.savedAt || new Date();
               });
            };
            // a browser-kept project changed since its last download: the one thing that can still be lost
            $scope.prjUndownloaded = function () {
               var c = project.current;
               return !!(c && c.mode === "browser" && c.savedAt && (!$scope.prj.downloadedAt || c.savedAt > $scope.prj.downloadedAt));
            };
            $scope.prjAddDb = function () {
               if (!project.canWrite()) return;
               var m = project.current.project, slot = $scope.isV12() ? "v12" : "v11";
               m.databases[slot] = $scope.state.instance;
               prjSave();
            };
            $scope.prjCounts = function () {
               var m = project.current && project.current.project;
               if (!m) return null;
               // every database the project names, has a scan of, or holds step status for
               var dbs = {};
               [m.databases.v11, m.databases.v12].concat(Object.keys(m.instances), m.scans.map(function (x) { return x.instance; })).forEach(function (d) { if (d) dbs[d] = 1; });
               return { s: m.scans.length, b: m.backups.length, d: Object.keys(dbs).length };
            };
            // the title-row status, and the one notice that asks for a click
            $scope.prjStatus = function () {
               var c = project.current;
               if (!c) return null;
               if (c.status === "perm") return { cls: "sm-prj-warn", text: t("SAASMIG_PRJUNSAVEDPERM") };
               if (c.status === "missing") return { cls: "sm-prj-error", text: t("SAASMIG_PRJUNSAVEDMISSING") };
               if (c.status === "error") return { cls: "sm-prj-error", text: t("SAASMIG_PRJUNSAVEDERROR") };
               if (c.status === "saving") return { cls: "", text: t("SAASMIG_PRJSAVING") };
               if ($scope.prjUndownloaded()) return { cls: "sm-prj-warn", text: t("SAASMIG_PRJCHANGED"), download: true };
               return { cls: "", text: c.savedAt ? t("SAASMIG_PRJSAVED", { at: hhmm(c.savedAt) }) : t("SAASMIG_PRJREADY") };
            };
            $scope.prjName = function () { var c = project.current; return c ? (c.project ? c.project.name : c.name) : null; };
            $scope.prjNotice = function () { var c = project.current; return c && (c.status === "perm" || c.status === "missing") ? c.status : null; };
            $scope.$on("tm1-readiness-project", function () { if (!project.current && $scope.prj.view === "detail") $scope.prj.view = "start"; });
            // a browser-kept project with changes never downloaded: the browser asks before the page goes
            var beforeUnload = function (e) { if ($scope.prjUndownloaded()) { e.preventDefault(); e.returnValue = ""; } };
            window.addEventListener("beforeunload", beforeUnload);
            $scope.$on("$destroy", function () { window.removeEventListener("beforeunload", beforeUnload); });

            // ----------------------------------------------------------- instances

            $scope.loadInstances = function () {
               $tm1.instances().then(function (data) {
                  /* Every database Arc knows, connected or not (user, 2026-10-02). Arc
                   * connects one only when something uses it in the session, so a filter
                   * on isLoaded left out every database not yet opened: the compare list
                   * showed only "none". Picking one probes it, which connects it. */
                  var names = _.map(data, function (i) { return i.Name; });
                  if ($scope.state.instance && !_.includes(names, $scope.state.instance)) names.unshift($scope.state.instance);
                  $scope.state.instances = names;
                  if (!$scope.state.instance && names.length) $scope.state.instance = names[0];
                  $scope.probeInstance();
               });
            };

            $scope.probeInstance = function () {
               var inst = $scope.state.instance;
               if (!inst) return;
               $scope.state.user = null; $scope.state.productVersion = null; $scope.state.instanceProblem = null;
               call(inst, "GET", "/ActiveUser?$select=Name,Type").then(function (r) { if (ok(r)) $scope.state.user = r.data; });
               // `/Configuration/ProductVersion/$value` fails on TM1 12 through Arc (§2.4); this form works on both
               probeVersion(inst).then(function (v) {
                  if ($scope.state.instance !== inst) return;
                  if (v.version) {
                     $scope.state.productVersion = v.version;
                     if (!$scope.state.user) call(inst, "GET", "/ActiveUser?$select=Name,Type").then(function (r) { if (ok(r)) $scope.state.user = r.data; });
                     diag("session", sessionInfo());
                  } else { $scope.state.instanceProblem = v.problem; diag("instanceProblem", { problem: v.problem, status: v.status || null }); }
               });
            };
            /* A database just picked may not be connected yet: a 401 or 403 in the
             * first seconds is the connection still being made (§2.15), so it is
             * asked again for about 10 s before it is called "not signed in". */
            var probeVersion = function (inst, tries) {
               tries = tries === undefined ? 4 : tries;
               return call(inst, "GET", "/Configuration?$select=ProductVersion").then(function (r) {
                  if (ok(r)) return { version: r.data.ProductVersion };
                  if ((r.status === 401 || r.status === 403) && tries > 0) return $timeout(function () { }, 2500).then(function () { return probeVersion(inst, tries - 1); });
                  return { problem: r.status === 401 || r.status === 403 ? "signin" : "unreachable", status: r.status };
               }, function () { return { problem: "unreachable" }; });
            };

            /* Apply, CloudID writes and restore need an admin session: the same
             * gate calculation-explorer settled on for its cancel. */
            $scope.isAdmin = function () { return !!$scope.state.user && $scope.state.user.Type === "Admin"; };
            $scope.isV12 = function () { return /^12\./.test($scope.state.productVersion || ""); };
            $scope.otherInstances = function () { return _.without($scope.state.instances, $scope.state.instance); };

            /* The picker means the TM1 12 target when the selected database is v11,
             * and the original v11 database when the selected one is already v12
             * (user, 2026-09-29). Its version is probed so a pick in the wrong
             * direction is said, not silently compared. */
            $scope.compileTarget = function () { return $scope.isV12() ? $scope.state.instance : $scope.state.target; };
            $scope.targetMismatch = function () {
               var v = $scope.state.targetVersion;
               if (!$scope.state.target || !v) return false;
               return $scope.isV12() ? /^12\./.test(v) : !/^12\./.test(v);
            };
            $scope.$watch("state.target", function (now) {
               $scope.state.targetVersion = null; $scope.state.targetProblem = null;
               if (!now) return;
               probeVersion(now).then(function (v) {
                  if ($scope.state.target !== now) return;
                  if (v.version) $scope.state.targetVersion = v.version; else $scope.state.targetProblem = v.problem;
               });
            });

            // ---------------------------------------------------------------- scan

            $scope.scan = function () {
               var inst = $scope.state.instance;
               if (!inst) return;
               /* After a scan (user, 2026-10-05, option B): the first scan of a database lands on step 1,
                * where its result is, with "Scan finished… Next" -- it used to jump to step 2 and the result
                * was never seen. A rescan stays where the user is and says in one line what changed. */
               var was = $scope.state.scan && $scope.state.scan.instance === inst ? noteFigures() : null, keepStep = $scope.openStep();
               $scope.state.scanNote = null;
               var model = {}, started = Date.now();
               $scope.state.error = null;
               $scope.state.selected = {};
               $scope.state.detail = null;
               $scope.state.grant = null;
               var step = function (label, path, key) {
                  $scope.state.busy = t(label);
                  return call(inst, "GET", path).then(function (r) { must(r); model[key] = r.data.value; });
               };
               return step("SAASMIG_READPROCESSES", SELECT_PROCESSES, "processes")
                  .then(function () { return step("SAASMIG_READRULES", "/Cubes?$select=Name,Rules&$expand=Dimensions($select=Name)", "cubes"); })
                  .then(function () { return step("SAASMIG_READSUBSETS", SELECT_DIMENSIONS, "dimensions"); })
                  .then(function () {
                     /* Element types only for dimensions with more than one real
                      * hierarchy: that is where a type conflict can be, and the
                      * only dimensions worth the extra reads. */
                     var multi = (model.dimensions || []).filter(function (d) {
                        return (d.Hierarchies || []).filter(function (h) { return !/^leaves$/i.test(h.Name); }).length > 1;
                     });
                     model.hierarchyElements = {};
                     var chain = $q.when();
                     multi.forEach(function (d) {
                        chain = chain.then(function () {
                           $scope.state.busy = t("SAASMIG_READELEMENTS", { dim: d.Name });
                           return call(inst, "GET", core.path([["Dimensions", d.Name]]) + "/Hierarchies?$select=Name&$expand=Elements($select=Name,Type)").then(function (r) {
                              must(r);
                              model.hierarchyElements[d.Name] = r.data.value.filter(function (h) { return !/^leaves$/i.test(h.Name); });
                           });
                        });
                     });
                     return chain;
                  })
                  .then(function () { return step("SAASMIG_READVIEWS", "/Cubes?$select=Name&$expand=Views($select=Name,ibm.tm1.api.v1.MDXView/MDX)", "views"); })
                  .then(function () { return step("SAASMIG_READCHORES", "/Chores?$select=Name&$expand=Tasks($expand=Process($select=Name))", "chores"); })
                  .then(function () { return readCfg(inst); })
                  .then(function () {
                     var result = core.scanModel(model, { v12: $scope.isV12() });
                     result.model = model;
                     result.instance = inst;
                     result.at = new Date();
                     result.seconds = Math.round((Date.now() - started) / 100) / 10;
                     result.appsGroup = core.tm1ApplicationsGroup(result.findings);
                     result.bedrockGroup = core.bedrockGroup(result.findings);
                     result.processByName = {};
                     model.processes.forEach(function (p) { result.processByName[p.Name] = p; });
                     result.counts = { processes: model.processes.length, cubes: model.cubes.length, dimensions: model.dimensions.length, chores: (model.chores || []).length };
                     return dropAmbiguousSubsets(inst, result).then(function () { return resolveSubsetBasis(inst, result); })
                        .then(function () { return verifyRewrites(inst, result); })
                        .then(function () { return checkElementSecurity(inst, result); }).then(function () {
                        result.findings.forEach(function (f, i) { f.id = i; });
                        $scope.state.scan = result;
                        $scope.state.v12check = null;
                        prjSaveScan(result).then(function (saved) { if (saved && $scope.state.scanNote && $scope.state.scanNote.instance === inst) $scope.state.scanNote.saved = true; });
                        // without a project this scan dies with the page: noted, so the next visit can say so
                        if (project.isOpen()) clearLostScan(inst); else noteLostScan(inst, result.at);
                        var now = noteFigures();
                        if (!was) {
                           // Where used opened from Arc's tree scans first: it stays on its own tab
                           if ($scope.state.tab !== "whereused") { $scope.state.tab = "overview"; $scope.state.stepOpen = 1; }
                           $scope.state.scanNote = angular.extend({ kind: "first", instance: inst, seconds: result.seconds }, now);
                        } else {
                           if (!$scope.state.stepOpen) $scope.state.stepOpen = keepStep;
                           $scope.state.scanNote = { kind: "rescan", instance: inst, at: hhmm(result.at), changes: noteChanges(was, now) };
                        }
                        /* tabs filled from the scan are refilled when they are open, too: a scan
                         * started on an empty TM1 Applications tab left it empty (manual test,
                         * 2026-10-05) because only a tab already filled was refreshed. Data files
                         * the same, but only for this database, so its plan is not marked looked-at
                         * (step 2) by a scan of another one. */
                        if ($scope.state.tp || $scope.state.tab === "apps") $scope.loadTp();
                        if ($scope.state.tab === "datafiles" || ($scope.state.dataFiles && $scope.state.dataFiles.instance === result.instance)) $scope.loadDataFiles();
                        if ($scope.state.bedrock.inv) $scope.planBedrock();
                        landHandoff(inst, result);
                        if ($scope.state.tab === "bedrock") $scope.openBedrock();
                        log("scan", t("SAASMIG_LOGSCAN", { n: result.findings.length, s: result.seconds }));
                        diag("scanResult", angular.extend({ seconds: result.seconds, counts: result.counts }, core.diagScanSummary(result.findings)));
                     });
                  })
                  .catch(function (e) { $scope.state.error = e.message || String(e); })
                  .finally(function () { $scope.state.busy = null; });
            };

            /* A `[dim].[x]` that names a subset is only a problem when no element
             * is called x: with one, TM1 12 resolves the member (measured, §2.5).
             * One request per candidate; there are few. */
            var dropAmbiguousSubsets = function (inst, result) {
               var cands = result.findings.filter(function (f) { return f.elementCheck; });
               var chain = $q.when(), drop = {};
               cands.forEach(function (f) {
                  chain = chain.then(function () {
                     var c = f.elementCheck;
                     $scope.state.busy = t("SAASMIG_CHECKINGELEMENTS");
                     return call(inst, "GET", core.path([["Dimensions", c.dimension], ["Hierarchies", c.hierarchy], ["Elements", c.element]]) + "?$select=Name").then(function (r) {
                        if (ok(r)) drop[f.object + "|" + f.index] = true;
                     });
                  });
               });
               return chain.then(function () {
                  if (!Object.keys(drop).length) return;
                  result.findings = result.findings.filter(function (f) { return !(f.elementCheck && drop[f.object + "|" + f.index]); });
                  result.summary = core.summarise(result.findings);
               });
            };

            /* TM1SubsetBasis() in a subset, done as Arc's v11 subset editor does it
             * (read from its code and its network log, plan §2.10; user,
             * 2026-10-02). PATCH the subset's MDX to {TM1SubsetBasis()} with
             * $expand=Elements, which returns the stored list, and put the MDX
             * back. Then replace each TM1SubsetBasis() with the list's
             * UniqueNames joined by ",". The list exists on v11 only. On TM1 12 it
             * is read from the v11 comparison database, or from the v11 database
             * the user picks in the finding (`fromDb`, readBasisFrom). Two things
             * Arc does not do: the put-back is re-read, and the rewrite is offered
             * only when it returns, here, what the subset returns on v11. */
            var resolveSubsetBasis = function (inst, result, fromDb) {
               var bySub = {}, order = [];
               result.findings.forEach(function (f) {
                  if (!f.basisCheck) return;
                  if (!bySub[f.object]) { bySub[f.object] = []; order.push(f.object); }
                  bySub[f.object].push(f);
               });
               if (!order.length) return $q.when();
               var v12 = $scope.isV12();
               var src = fromDb || (!v12 ? inst : ($scope.state.target && $scope.state.targetVersion && !/^12\./.test($scope.state.targetVersion) ? $scope.state.target : null));
               var say = function (fs, how, extra) { fs.forEach(function (f) { f.suggestion = core.basisSuggestion("Subset", how, extra); }); };
               var names = function (r) { return ((r.data.Elements || r.data.value) || []).map(function (e) { return e.Name; }); };
               var chain = $q.when();
               if (!src) {
                  // no v11 database yet: the finding asks for one, with a guess when an element is named like the subset
                  order.forEach(function (key) {
                     var fs = bySub[key], f0 = fs[0];
                     chain = chain.then(function () {
                        return call(inst, "GET", core.path([["Dimensions", f0.dimensionName], ["Hierarchies", f0.hierarchyName], ["Elements", f0.subsetName]]) + "?$select=Name").then(function (r) {
                           // the read also answers for an alias: then Name is the principal name (measured on 12.6.4)
                           var hit = ok(r) ? r.data.Name : null;
                           say(fs, "nosource", { element: hit ? core.basisSet(f0.dimensionName, f0.hierarchyName, [hit]).replace(/^\{|\}$/g, "") : null,
                              alias: hit && core.normName(hit) !== core.normName(f0.subsetName) ? f0.subsetName : null });
                        });
                     });
                  });
                  return chain;
               }
               /* Arc's read. A put-back that does not re-read as the original is an
                * error naming the MDX, raised as a notification, and nothing is
                * read on after it. */
               var readBasis = function (subPath, original, label) {
                  var got = null, failed = null;
                  return call(src, "PATCH", subPath + "?$expand=Elements($select=UniqueName)", { Expression: core.BASIS_ONLY }).then(function (r) {
                     if (!ok(r)) failed = new Error(errorText(r));
                     else got = (r.data.Elements || []).map(function (e) { return e.UniqueName; });
                  }, function (e) { failed = e; }).then(function () {
                     return call(src, "PATCH", subPath, { Expression: original });
                  }).then(function () {
                     return call(src, "GET", subPath + "?$select=Expression");
                  }).then(function (r) {
                     if (!ok(r) || r.data.Expression !== original) { var re = new Error(t("SAASMIG_BASISRESTOREFAILED", { mdx: original })); re.restore = true; throw re; }
                     if (failed) throw failed;
                     log("scan", t("SAASMIG_LOGBASISREST", { name: label, n: got.length }));
                     return { list: core.basisListOf(got), count: got.length };
                  });
               };
               order.forEach(function (key) {
                  var fs = bySub[key], f0 = fs[0], d = f0.dimensionName, h = f0.hierarchyName;
                  var subPath = core.path([["Dimensions", d], ["Hierarchies", h], ["Subsets", f0.subsetName]]);
                  chain = chain.then(function () {
                     $scope.state.busy = t("SAASMIG_READINGBASIS", { name: key });
                     var want;
                     return call(src, "GET", subPath + "?$select=Expression&$expand=Elements($select=Name)").then(function (r) {
                        if (!ok(r)) { say(fs, "notfound", { from: src }); return; }
                        want = names(r);
                        var original = r.data.Expression;
                        if (!original) { say(fs, "failed", { from: src, error: t("SAASMIG_BASISNOMDX") }); return; }
                        return readBasis(subPath, original, key).then(function (b) {
                           fs.forEach(function (f) { f.replacement = b.list; });
                           // every rewrite of the subset, as Apply will write it
                           var all = result.findings.filter(function (x) { return x.objectType === "Subset" && x.object === key && !$scope.isSkipped(x); });
                           var mdx = core.fixMdx(f0.statement, all.map(function (x) { return x.basisCheck ? angular.extend({}, x, { fix: "REWRITE" }) : x; }));
                           return call(inst, "POST", "/ExecuteMDXSetExpression?$expand=Tuples($expand=Members($select=Name))", { MDX: mdx }).then(function (x) {
                              must(x);
                              var got = (x.data.Tuples || []).map(function (tp) { return tp.Members[0].Name; });
                              if (got.join("\u0001") === want.join("\u0001")) {
                                 fs.forEach(function (f) { f.fix = "REWRITE"; });
                                 say(fs, "rewrite", { from: src, via: t("SAASMIG_BASISVIAREST"), count: b.count, result: want.length, v12: v12 });
                              } else {
                                 say(fs, "differs", { from: src, got: got.length, want: want.length, set: b.list });
                              }
                           });
                        });
                     }).catch(function (e) {
                        if (e.restore) Notification.error({ message: key + ": " + e.message });
                        say(fs, "failed", { from: src, error: e.message || String(e) });
                        log("scan", t("SAASMIG_LOGBASISFAILED", { name: key, error: e.message || String(e) }));
                     });
                  });
               });
               return chain.catch(function (e) {
                  order.forEach(function (key) { say(bySub[key], "failed", { from: src, error: e.message || String(e) }); });
               });
            };

            /* The v11 database to read the lists from, picked in a finding on TM1 12
             * (user, 2026-10-02: "ask for the v11 connection, or use the one in the
             * compare"). It must answer and be v11. Every TM1SubsetBasis finding is
             * then read again from it, and it becomes the comparison database too. */
            $scope.basisFrom = { db: null };
            $scope.readBasisFrom = function (db) {
               var s = $scope.state.scan, inst = $scope.state.instance;
               if (!s || !db) return $q.when();
               $scope.state.basisFromError = null;
               $scope.state.busy = t("SAASMIG_READINGBASIS", { name: db });
               return probeVersion(db).then(function (v) {
                  if (!v.version) throw new Error(t(v.problem === "signin" ? "SAASMIG_NOTSIGNEDIN" : "SAASMIG_UNREACHABLE", { inst: db }));
                  if (/^12\./.test(v.version)) throw new Error(t("SAASMIG_BASISNOTV11", { inst: db, v: v.version }));
                  s.findings.forEach(function (f) { if (f.basisCheck) { f.fix = "MANUAL"; delete f.replacement; } });
                  return resolveSubsetBasis(inst, s, db);
               }).then(function () {
                  if ($scope.state.target !== db) $scope.state.target = db;
                  s.summary = core.summarise(s.findings);
                  var f = $scope.state.detail && $scope.state.detail.finding;
                  if (f) $scope.openDetail(f);
               }).catch(function (e) {
                  $scope.state.basisFromError = e.message || String(e);
               }).finally(function () { $scope.state.busy = null; });
            };

            /* The rewrites of removed functions in subsets (`check`, plan §2.11)
             * are offered only once they are seen to keep the result (user,
             * 2026-10-02): the subset's MDX on v11 -- this database, or on TM1 12
             * the v11 comparison database -- against the whole rewritten MDX on
             * this database, member names in order. Anything else leaves the
             * finding MANUAL, with the rewrite in its text. */
            var verifyRewrites = function (inst, result) {
               var bySub = {}, order = [];
               result.findings.forEach(function (f) {
                  if (!f.check || f.fix !== "REWRITE" || (f.objectType !== "Subset" && f.objectType !== "View")) return;
                  // by type too: a subset "d / x" and a view "c / x" can share a label
                  var k = f.objectType + "|" + f.object;
                  if (!bySub[k]) { bySub[k] = []; order.push(k); }
                  bySub[k].push(f);
               });
               if (!order.length) return $q.when();
               var v12 = $scope.isV12();
               var v11db = !v12 ? inst : ($scope.state.target && $scope.state.targetVersion && !/^12\./.test($scope.state.targetVersion) ? $scope.state.target : null);
               var note = function (fs, how, extra) {
                  fs.forEach(function (f) {
                     f._checked = true;
                     if (how !== "same") f.fix = "MANUAL";
                     f.suggestion += core.checkNote(how, angular.extend({ replacement: f.replacement }, extra));
                  });
               };
               /* A view is a whole query: its rows and columns are compared, axis
                * by axis (the axis number makes a member that moves axes a
                * difference), and the cellset is dropped after the read. */
               var run = function (db, mdx, view) {
                  if (view) return call(db, "POST", "/ExecuteMDX?$expand=Axes($expand=Tuples($expand=Members($select=Name)))", { MDX: mdx }).then(function (r) {
                     if (!ok(r)) return { error: errorText(r) };
                     if (r.data.ID) call(db, "DELETE", "/Cellsets('" + r.data.ID + "')");
                     var names = [];
                     (r.data.Axes || []).forEach(function (a, i) {
                        (a.Tuples || []).forEach(function (tp) { names.push(i + "|" + tp.Members.map(function (m) { return m.Name; }).join("*")); });
                     });
                     return { names: names };
                  });
                  return call(db, "POST", "/ExecuteMDXSetExpression?$expand=Tuples($expand=Members($select=Name))", { MDX: mdx }).then(function (r) {
                     if (!ok(r)) return { error: errorText(r) };
                     return { names: (r.data.Tuples || []).map(function (tp) { return tp.Members.map(function (m) { return m.Name; }).join("*"); }) };
                  });
               };
               var chain = $q.when();
               order.forEach(function (key) {
                  var fs = bySub[key];
                  chain = chain.then(function () {
                     if (!v11db) { note(fs, "nosource", {}); return; }
                     $scope.state.busy = t("SAASMIG_CHECKINGREWRITE", { name: fs[0].object });
                     var f0 = fs[0], view = f0.objectType === "View";
                     var all = result.findings.filter(function (x) { return x.objectType === f0.objectType && x.object === f0.object && !$scope.isSkipped(x); });
                     var fixed = core.fixMdx(f0.statement, all);
                     return run(v11db, f0.statement, view).then(function (want) {
                        if (want.error) { note(fs, "v11fails", { from: v11db, error: want.error, view: view }); return; }
                        return run(inst, fixed, view).then(function (got) {
                           if (got.error) note(fs, "fails", { error: got.error, view: view });
                           else if (got.names.join("\u0001") === want.names.join("\u0001")) note(fs, "same", { n: want.names.length, from: v11db, view: view });
                           else note(fs, "differs", { got: got.names.length, want: want.names.length, from: v11db, view: view });
                        });
                     });
                  });
               });
               return chain.catch(function (e) {
                  log("scan", t("SAASMIG_LOGCHECKFAILED", { error: e.message || String(e) }));
                  order.forEach(function (key) { note(bySub[key].filter(function (f) { return !f._checked; }), "fails", { error: e.message || String(e) }); });
               });
            };

            /* Element security against the elements MDX names (user, 2026-10-01).
             * One cellset per secured dimension: every group across, and down
             * only the elements with some right (NON EMPTY), so the read stays
             * small. A named element with no row there has None for everyone; it
             * is checked with one read that it is an element at all, so an
             * alias, a subset or a typo is not reported. */
            var checkElementSecurity = function (inst, result) {
               var byCube = {};
               (result.elementRefs || []).forEach(function (r) { (byCube[r.cube] = byCube[r.cube] || []).push(r); });
               var access = {}, chain = $q.when();
               Object.keys(byCube).forEach(function (cube) {
                  var dim = byCube[cube][0].dimension;
                  chain = chain.then(function () {
                     $scope.state.busy = t("SAASMIG_READELEMENTSECURITY", { dim: dim });
                     var mdx = "SELECT {TM1SUBSETALL([}Groups])} ON 0, NON EMPTY {TM1SUBSETALL([" + dim.replace(/\]/g, "]]") + "])} ON 1 FROM [" + cube.replace(/\]/g, "]]") + "]";
                     return call(inst, "POST", "/ExecuteMDX?$expand=Axes($expand=Tuples($expand=Members($select=Name))),Cells($select=Value)", { MDX: mdx }).then(function (r) {
                        must(r);
                        var axes = r.data.Axes || [], cols = axes[0] ? axes[0].Tuples.map(function (tp) { return tp.Members[0].Name; }) : [];
                        var rows = axes[1] ? axes[1].Tuples.map(function (tp) { return tp.Members[0].Name; }) : [];
                        var cells = r.data.Cells || [], a = { groups: [], rights: {}, exists: {} }, used = {};
                        rows.forEach(function (el, i) {
                           var k = core.normName(el), m = a.rights[k] = {};
                           a.exists[k] = true;
                           cols.forEach(function (g, j) {
                              var v = cells[i * cols.length + j] ? cells[i * cols.length + j].Value : null;
                              if (v !== null && v !== undefined && v !== "") { m[g] = String(v); if (!/^none$/i.test(v)) used[g] = true; }
                           });
                        });
                        a.groups = cols.filter(function (g) { return used[g] && !core.isAdminGroup(g); });
                        access[cube] = a;
                        // the named elements with no right for anyone: are they elements?
                        var unknown = {};
                        byCube[cube].forEach(function (ref) { var k = core.normName(ref.element); if (!a.exists[k]) unknown[k] = ref.element; });
                        var inner = $q.when();
                        Object.keys(unknown).forEach(function (k) {
                           inner = inner.then(function () {
                              return call(inst, "GET", core.path([["Dimensions", dim], ["Hierarchies", dim], ["Elements", unknown[k]]]) + "?$select=Name").then(function (e) {
                                 if (ok(e)) a.exists[k] = true;
                              });
                           });
                        });
                        return inner;
                     }).catch(function (e) {
                        // a read that fails is reported, not taken for "no access"
                        log("scan", t("SAASMIG_LOGELEMENTSECURITYFAILED", { dim: dim, error: e.message || String(e) }));
                     });
                  });
               });
               return chain.then(function () {
                  var found = core.elementSecurityFindings(result.elementRefs || [], access);
                  if (!found.length) return;
                  if ($scope.isV12()) found.forEach(function (f) { f.suggestion = f.suggestion.replace(/; v11 filtered the result afterwards/, ""); });
                  result.findings = core.sortFindings(result.findings.concat(found));
                  result.summary = core.summarise(result.findings);
               });
            };

            /* READ on the named element for the groups a finding lists. Checked
             * first (rule-derived cells, the element's type), then a separate
             * confirmation: it changes who sees what, so it is never part of
             * Apply selected. Backup, write, SecurityRefresh (an unbound TI,
             * measured on v11 and 12.6.4: it runs and leaves no process), a
             * read-back, and the element security check again. */
            var SECURITY_REFRESH = { Process: { Name: "}saasmig_security_refresh", PrologProcedure: "SecurityRefresh;\r\n" } };
            var refreshSecurity = function (inst) {
               return call(inst, "POST", "/ExecuteProcessWithReturn", SECURITY_REFRESH).then(function (r) {
                  must(r);
                  if (r.data.ProcessExecuteStatusCode !== "CompletedSuccessfully") throw new Error("SecurityRefresh: " + r.data.ProcessExecuteStatusCode);
               });
            };
            var esq = function (x) { return "[" + String(x).replace(/\]/g, "]]") + "]"; };
            $scope.checkGrant = function (f) {
               var inst = $scope.state.instance, cube = "}ElementSecurity_" + f.dimension;
               var g = { finding: f, cube: cube, dimension: f.dimension, element: f.referenced, groups: f.groups.slice(), checking: true };
               $scope.state.grant = g;
               var mdx = "SELECT {" + g.groups.map(function (x) { return "[}Groups].[}Groups]." + esq(x); }).join(",") + "} ON 0, {" +
                  esq(g.dimension) + "." + esq(g.dimension) + "." + esq(g.element) + "} ON 1 FROM " + esq(cube);
               return call(inst, "POST", "/ExecuteMDX?$expand=Axes($expand=Tuples($expand=Members($select=Name;$expand=Element($select=Type)))),Cells($select=Value,RuleDerived)", { MDX: mdx }).then(function (r) {
                  must(r);
                  var axes = r.data.Axes || [];
                  var cols = axes[0] ? axes[0].Tuples.map(function (tp) { return tp.Members[0].Name; }) : [];
                  var row = axes[1] && axes[1].Tuples[0] ? axes[1].Tuples[0].Members[0] : null;
                  if (cols.length !== g.groups.length || !row) throw new Error(t("SAASMIG_GRANTREADFAILED"));
                  g.groups = cols;
                  g.element = row.Name;
                  // a cellset member's own Type is "Regular"; the element's is under Element (measured)
                  g.consolidated = !!row.Element && row.Element.Type === "Consolidated";
                  var cells = r.data.Cells || [];
                  if (!g.consolidated) { g.plan = core.grantPlan(cols, cells); return; }
                  /* A consolidation: READ only for the groups that can read one of its
                   * descendants (user, 2026-10-02); the rest are listed as left out. */
                  var el = esq(g.dimension) + "." + esq(g.dimension) + "." + esq(g.element);
                  var dmdx = "SELECT {" + cols.map(function (x) { return "[}Groups].[}Groups]." + esq(x); }).join(",") + "} ON 0, NON EMPTY {EXCEPT(DESCENDANTS(" + el + "), {" + el + "})} ON 1 FROM " + esq(cube);
                  return call(inst, "POST", "/ExecuteMDX?$expand=Axes($expand=Tuples($select=Ordinal)),Cells($select=Value)", { MDX: dmdx }).then(function (d) {
                     must(d);
                     var dax = d.data.Axes || [], drows = dax[1] ? dax[1].Tuples.length : 0;
                     var split = core.grantGroups(cols, d.data.Cells || [], drows);
                     g.leftOut = split.leftOut;
                     g.groups = split.grant;
                     g.plan = split.grant.length ? core.grantPlan(split.grant, split.grant.map(function (x) { return cells[cols.indexOf(x)]; })) : null;
                     g.nobody = !split.grant.length;
                  });
               }).catch(function (e) { g.error = e.message || String(e); })
                  .finally(function () { g.checking = false; });
            };
            $scope.cancelGrant = function () { $scope.state.grant = null; };
            $scope.applyGrant = function () {
               var g = $scope.state.grant, inst = $scope.state.instance;
               if (!g || !g.plan || !g.plan.writable) return $q.when();
               var dims = [g.dimension, "}Groups"];
               $scope.state.busy = t("SAASMIG_GRANTING", { el: g.element });
               return saveBackup(inst, [{ type: "ElementSecurity", objectType: "Cube", name: g.cube, dimension: g.dimension, element: g.element,
                  cells: g.groups.map(function (x) { return [g.element, x, g.plan.before[x]]; }) }])
                  .then(function () { return writeCells(inst, g.cube, dims, g.groups.map(function (x) { return [g.element, x, "READ"]; })); })
                  .then(function () { return refreshSecurity(inst); })
                  .then(function () {
                     var mdx = "SELECT {" + g.groups.map(function (x) { return "[}Groups].[}Groups]." + esq(x); }).join(",") + "} ON 0, {" +
                        esq(g.dimension) + "." + esq(g.dimension) + "." + esq(g.element) + "} ON 1 FROM " + esq(g.cube);
                     return call(inst, "POST", "/ExecuteMDX?$expand=Cells($select=Value)", { MDX: mdx });
                  }).then(function (r) {
                     must(r);
                     var bad = (r.data.Cells || []).filter(function (c) { return !/^read$/i.test(c.Value || ""); }).length;
                     if (bad) throw new Error(t("SAASMIG_REREADMISMATCH") + " " + g.cube);
                     log("apply", t("SAASMIG_LOGGRANTED", { el: g.element, n: g.groups.length, groups: g.groups.join(", ") }));
                     Notification.success({ message: t("SAASMIG_LOGGRANTED", { el: g.element, n: g.groups.length, groups: g.groups.join(", ") }) });
                     // the findings again, from the rights as they are now
                     var s = $scope.state.scan;
                     s.findings = s.findings.filter(function (x) { return x.rule !== "mdx.elementSecurity"; });
                     return checkElementSecurity(inst, s).then(function () {
                        s.findings.forEach(function (x, i) { x.id = i; });
                        s.summary = core.summarise(s.findings);
                        $scope.state.grant = null;
                        $scope.state.detail = null;
                     });
                  }).catch(function (e) {
                     g.error = e.message || String(e);
                     Notification.error({ message: g.error });
                  }).finally(function () { $scope.state.busy = null; });
            };

            $scope.visibleFindings = function () {
               var s = $scope.state.scan;
               if (!s) return [];
               var f = $scope.state.filters, text = (f.text || "").toLowerCase();
               var list = s.findings.filter(function (x) {
                  if (!f.showSkipped && $scope.isSkipped(x)) return false;
                  if (!f.showApps && x.tm1Applications) return false;
                  if (!f.showBedrock && x.bedrock) return false;
                  // "ACT": every severity but INFO -- what the breakdown by object counts
                  if (f.severity && (f.severity === "ACT" ? x.severity === "INFO" : x.severity !== f.severity)) return false;
                  // "Other": a type the scan does not name, the step-2 group for uncategorised objects
                  if (f.objectType && (f.objectType === "Other" ? core.OBJECT_TYPES.indexOf(x.objectType) >= 0 : x.objectType !== f.objectType)) return false;
                  if (f.fixableOnly && !$scope.fixable(x)) return false;
                  if (f.deprecatedOnly && !(x.deprecated || x.rule === "dep.usesRemoved")) return false;
                  if (text && (x.object + " " + (x.function || "") + " " + (x.referenced || "") + " " + (x.statement || "") + " " + x.rule).toLowerCase().indexOf(text) < 0) return false;
                  return true;
               });
               var plain = (!f.severity || f.severity === "REVIEW") && !f.objectType && !f.fixableOnly && !f.deprecatedOnly && !text;
               if (!f.showBedrock && s.bedrockGroup && plain) list = [s.bedrockGroup].concat(list);
               if (!f.showApps && s.appsGroup && plain) list = [s.appsGroup].concat(list);
               return list;
            };

            $scope.fixable = function (f) {
               return (f.objectType === "Process" && (f.fix === "REMOVE" || f.fix === "STUB" || f.fix === "REWRITE") ||
                  (f.objectType === "Subset" || f.objectType === "View") && f.fix === "REWRITE") && !$scope.isSkipped(f);
            };
            $scope.targetKey = function (f) { return f.objectType + "|" + f.object; };
            $scope.isSelected = function (f) { return !!$scope.state.selected[$scope.targetKey(f)]; };
            var select = function (f, on) {
               var key = $scope.targetKey(f);
               if (on) $scope.state.selected[key] = { type: f.objectType, name: f.object };
               else delete $scope.state.selected[key];
            };

            /* A row's box. Shift-click selects (or clears) every fixable row
             * between it and the row clicked before, in the order shown, and
             * sets them all to the clicked row's new state. */
            var lastToggle = null;
            $scope.toggle = function (f, $event) {
               if (!$scope.fixable(f)) return;
               var on = !$scope.isSelected(f);
               var list = $scope.visibleFindings(), at = list.indexOf(f);
               if ($event && $event.shiftKey && lastToggle && list.indexOf(lastToggle) >= 0 && at >= 0) {
                  var from = Math.min(at, list.indexOf(lastToggle)), to = Math.max(at, list.indexOf(lastToggle));
                  for (var i = from; i <= to; i++) if ($scope.fixable(list[i])) select(list[i], on);
               } else {
                  select(f, on);
               }
               lastToggle = f;
            };
            $scope.selectedCount = function () { return Object.keys($scope.state.selected).length; };
            /* The button counted objects only, and "Apply selected (20)" under a
             * BLOCKER chip of 139 read as most of the list left out (user's
             * manual test, 2026-10-04): it now names the findings those objects
             * carry as well, hidden ones included, since Apply fixes them too. */
            $scope.selectedFindingCount = function () {
               var s = $scope.state.scan, sel = $scope.state.selected;
               if (!s) return 0;
               return s.findings.filter(function (f) { return $scope.fixable(f) && sel[$scope.targetKey(f)]; }).length;
            };

            /* The header box works on the fixable rows the filters show. A
             * selection is per object (one fix covers all of a process's
             * findings), so the states count objects, not rows. */
            var visibleFixableKeys = function () {
               var keys = {};
               $scope.visibleFindings().forEach(function (f) { if ($scope.fixable(f)) keys[$scope.targetKey(f)] = f; });
               return keys;
            };
            $scope.headState = function () {
               var keys = visibleFixableKeys(), n = 0, sel = 0;
               for (var k in keys) if (keys.hasOwnProperty(k)) { n++; if ($scope.state.selected[k]) sel++; }
               return !n ? "empty" : !sel ? "none" : sel === n ? "all" : "some";
            };
            $scope.toggleAllVisible = function () {
               var keys = visibleFixableKeys(), on = $scope.headState() !== "all";
               for (var k in keys) if (keys.hasOwnProperty(k)) select(keys[k], on);
               lastToggle = null;
            };
            $scope.headTip = function () {
               var n = Object.keys(visibleFixableKeys()).length;
               return t($scope.headState() === "all" ? "SAASMIG_HEADTIP_CLEAR" : "SAASMIG_HEADTIP_SELECT", { n: n });
            };
            /* Selected objects the current filters hide: a bulk Apply still
             * includes them (user, 2026-09-29), so they are counted beside it. */
            $scope.hiddenSelected = function () {
               var keys = visibleFixableKeys(), n = 0;
               for (var k in $scope.state.selected) if ($scope.state.selected.hasOwnProperty(k) && !keys[k]) n++;
               return n;
            };
            $scope.clearSelection = function () { $scope.state.selected = {}; lastToggle = null; };

            // --------------------------------------------------------------- skip

            /* A skipped finding (user, 2026-09-29) leaves the list, the counts and
             * the tiles, and Apply leaves its statement as it is. Skips are kept
             * per instance in this browser, so they survive a reload and a
             * rescan; the total stays in view, and "Show skipped" brings them
             * back to un-skip. Keyed by core.findingKey, which does not use the
             * line number, so a fix elsewhere in the procedure keeps the skip. */
            var SKIP_STORE = "tm1Readiness.skipped.";
            var skips = { instance: undefined, keys: {}, version: 0 };
            var skipKeys = function () {
               var inst = $scope.state.instance;
               if (skips.instance !== inst) {
                  var keys = {};
                  try { keys = JSON.parse(window.localStorage.getItem(SKIP_STORE + inst) || "{}") || {}; } catch (e) { keys = {}; }
                  skips = { instance: inst, keys: keys, version: skips.version + 1 };
               }
               return skips.keys;
            };
            var saveSkips = function () {
               skips.version++;
               // a private window refuses: the skips then last as long as the page
               try { window.localStorage.setItem(SKIP_STORE + skips.instance, JSON.stringify(skips.keys)); } catch (e) { }
               if (project.canWrite()) prjJson("skips/" + core.safeName(skips.instance) + ".json", skips.keys).catch(angular.noop);
            };
            // cached on the finding, out of sight of JSON and angular.equals
            var cached = function (f, name, build) {
               if (!Object.prototype.hasOwnProperty.call(f, name)) Object.defineProperty(f, name, { value: build(), writable: true, configurable: true, enumerable: false });
               return f[name];
            };
            var keyOf = function (f) { return cached(f, "_smKey", function () { return core.findingKey(f); }); };
            // the two group rows stand for a tab, not for a finding
            $scope.canSkip = function (f) { return f.rule !== "apps.tm1Applications" && f.rule !== "bedrock.group"; };
            $scope.isSkipped = function (f) { return $scope.canSkip(f) && !!skipKeys()[keyOf(f)]; };
            var objectHasFixable = function (key) {
               return $scope.state.scan.findings.some(function (x) { return $scope.targetKey(x) === key && $scope.fixable(x); });
            };
            $scope.setSkipped = function (f, on) {
               var keys = skipKeys(), k = keyOf(f);
               if (on) keys[k] = { at: new Date().toISOString(), objectType: f.objectType, object: f.object, rule: f.rule };
               else delete keys[k];
               saveSkips();
               // an object with nothing left to fix has nothing left to apply
               var tk = $scope.targetKey(f);
               if ($scope.state.selected[tk] && !objectHasFixable(tk)) delete $scope.state.selected[tk];
               // the preview shows what Apply would do, and that just changed
               var d = $scope.state.detail;
               if (d && d.finding && $scope.targetKey(d.finding) === tk) $scope.openDetail(d.finding);
            };
            var skippedList = function () {
               var s = $scope.state.scan;
               if (!s) return [];
               return sameAs("skipped", [s.findings, skips.instance, skips.version], function () { return s.findings.filter($scope.isSkipped); });
            };
            $scope.skippedCount = function () { return skippedList().length; };
            $scope.unskipAll = function () {
               skippedList().forEach(function (f) { delete skips.keys[keyOf(f)]; });
               saveSkips();
               if ($scope.state.detail) $scope.openDetail($scope.state.detail.finding);
            };
            /* The counts behind the tiles, the chips and the tab badge: the
             * scan's own summary, less what is skipped. */
            $scope.summary = function () {
               var s = $scope.state.scan;
               if (!s) return null;
               return sameAs("summary", [s.findings, skips.instance, skips.version], function () {
                  return skippedList().length ? core.summarise(s.findings.filter(function (f) { return !$scope.isSkipped(f); })) : s.summary;
               });
            };
            // memoised on a list of parts compared by identity: a new object
            // on every digest is an infinite digest (v0.3.1)
            var sameMemo = {};
            var sameAs = function (name, parts, build) {
               var m = sameMemo[name];
               if (!m || m.parts.length !== parts.length || parts.some(function (x, i) { return x !== m.parts[i]; })) {
                  m = sameMemo[name] = { parts: parts, value: build() };
               }
               return m.value;
            };
            // a statement of this object that one of its skipped findings names
            var skipTest = function (type, name) {
               var set = {};
               $scope.state.scan.findings.forEach(function (x) {
                  if (x.objectType === type && x.object === name && $scope.isSkipped(x)) set[x.procedure + "\u0001" + x.statement] = true;
               });
               return function (procedure, statement) { return !!set[procedure + "\u0001" + statement]; };
            };

            /* The object's own page in Arc, or null where Arc has none. */
            $scope.objectHref = function (f) {
               var inst = $scope.state.instance;
               var link = cached(f, "_smLink", function () { return {}; });
               if (link.instance !== inst) {
                  var l = core.objectLink(f);
                  link.instance = inst;
                  link.href = l && inst ? $state.href(l.state, angular.extend({ instance: inst }, l.params)) : null;
               }
               return link.href;
            };

            // ------------------------------------------------------------- preview

            var previewFor = function (type, name) {
               var s = $scope.state.scan;
               if (type === "Process") {
                  var p = s.processByName[name];
                  var mdxEdits = s.findings.filter(function (x) {
                     return x.objectType === "Process" && x.object === name && x.fix === "REWRITE" && x.fixedStatement;
                  }).map(function (x) { return { procedure: x.procedure, statement: x.statement, fixedStatement: x.fixedStatement }; });
                  var fix = core.fixProcess(p, null, { v12: $scope.isV12(), skip: skipTest(type, name), mdxEdits: mdxEdits });
                  return {
                     type: type, name: name, before: p, fix: fix,
                     hunks: core.PROCEDURES.filter(function (k) { return fix.procedures[k] !== (p[k] || ""); }).map(function (k) {
                        return { procedure: core.PROCEDURE_LABEL[k], rows: core.diffHunks(p[k], fix.procedures[k], 2) };
                     })
                  };
               }
               if (type === "Subset") {
                  var fs = s.findings.filter(function (x) { return x.objectType === "Subset" && x.object === name; });
                  var f0 = fs[0];
                  var live = fs.filter(function (x) { return !$scope.isSkipped(x); });
                  var after = core.fixMdx(f0.statement, live);
                  return {
                     type: type, name: name, subset: { dimension: f0.dimensionName, hierarchy: f0.hierarchyName, name: f0.subsetName },
                     beforeMdx: f0.statement, afterMdx: after,
                     fix: { fixable: true, changed: after !== f0.statement, removed: live, blockers: [], kept: fs.filter($scope.isSkipped) },
                     hunks: [{ procedure: "MDX", rows: core.diffHunks(f0.statement, after, 2) }]
                  };
               }
               if (type === "View") {
                  var vs = s.findings.filter(function (x) { return x.objectType === "View" && x.object === name && x.procedure === "MDX"; });
                  var v0 = vs[0];
                  var vlive = vs.filter(function (x) { return !$scope.isSkipped(x); });
                  var vafter = core.fixMdx(v0.statement, vlive);
                  return {
                     type: type, name: name, view: { cube: v0.cubeName, name: v0.viewName },
                     beforeMdx: v0.statement, afterMdx: vafter,
                     fix: { fixable: true, changed: vafter !== v0.statement, removed: vlive, blockers: [], kept: vs.filter($scope.isSkipped) },
                     hunks: [{ procedure: "MDX", rows: core.diffHunks(v0.statement, vafter, 2) }]
                  };
               }
               return null;
            };

            $scope.openDetail = function (f) {
               $scope.state.detail = { finding: f, preview: $scope.fixable(f) ? previewFor(f.objectType, f.object) : null };
            };
            /* The one line above a single object's Apply: what it writes and how
             * it is undone. The bulk confirmation keeps the full text. */
            // an MDX rewrite or a rename changes nothing v11 does; commenting a call out does
            $scope.commentsOut = function (preview) {
               return preview.type === "Process" && preview.fix.removed.some(function (r) { return r.reason !== "MDX" && r.reason !== "RefreshSecurity"; });
            };
            // what the fix catalogue has shown for this finding's rule (plan §2.13)
            $scope.fixEvidence = core.fixEvidence;
            $scope.fixVerifiedWith = core.FIX_VERIFIED_WITH;

            $scope.applyNoteKey = function (type) {
               if (type === "Subset") return $scope.isV12() ? "SAASMIG_APPLYNOTE_SUBSETV12" : "SAASMIG_APPLYNOTE_SUBSET";
               if (type === "View") return $scope.isV12() ? "SAASMIG_APPLYNOTE_VIEWV12" : "SAASMIG_APPLYNOTE_VIEW";
               return $scope.isV12() ? "SAASMIG_APPLYNOTE_PROCESSV12" : "SAASMIG_APPLYNOTE_PROCESS";
            };
            /* The corrected TI statement (or MDX), to paste: Apply does not edit
             * MDX inside TI. The Clipboard API needs a secure context, which
             * Arc on localhost is; elsewhere the text stays selectable. */
            $scope.copyText = function (text) {
               var done = function () { Notification.success({ message: t("SAASMIG_COPIED") }); };
               try { navigator.clipboard.writeText(text).then(done, function () { Notification.error({ message: t("SAASMIG_COPYFAILED") }); }); }
               catch (e) { Notification.error({ message: t("SAASMIG_COPYFAILED") }); }
            };
            $scope.oneLine = function (s) { return String(s || "").replace(/\s+/g, " "); };
            $scope.possibleSummary = function (d) {
               var n = d.callers.possible.length, from = d.possibleFrom;
               return t(n === 1 ? "SAASMIG_DELPOSSIBLEONE" : "SAASMIG_DELPOSSIBLEMANY", { n: n }) +
                  (from.length <= 3 ? " " + t("SAASMIG_DELPOSSIBLEFROM", { from: from.join(", ") }) : "");
            };
            $scope.closeDetail = function () { $scope.state.detail = null; $scope.state.del = null; $scope.state.grant = null; };

            $scope.openApps = function () { $scope.state.tab = "apps"; if (!$scope.state.tp) $scope.loadTp(); };

            /* Delete one process (user, 2026-09-29), refused while anything still
             * calls it. The check runs on a fresh scan, not on the one on screen,
             * because the model may have changed since. A computed call that may
             * be this process is shown as a warning: the code alone cannot say. */
            $scope.checkDelete = function (name) {
               var d = { name: name, checking: true };
               $scope.state.del = d;
               return $scope.scan().then(function () {
                  var s = $scope.state.scan;
                  if (!s || !s.processByName[name]) throw new Error(t("SAASMIG_DELGONE", { name: name }));
                  d.callers = core.processCallers(s.model, name);
                  // the warning is one line until opened; it names the callers when they are few
                  d.showPossible = false;
                  d.possibleFrom = _.uniq(d.callers.possible.map(function (c) { return c.from; }));
                  // the scan closed the detail panel, which is where this is shown
                  var f = s.findings.filter(function (x) { return x.objectType === "Process" && x.object === name; })[0];
                  $scope.state.detail = { finding: f || { objectType: "Process", object: name, severity: "INFO", suggestion: "" }, preview: f && $scope.fixable(f) ? previewFor("Process", name) : null };
               }).catch(function (e) { d.error = e.message || String(e); })
                  .finally(function () { d.checking = false; $scope.state.del = d; });
            };

            /* Backup of the whole process, DELETE, a read that must answer 404,
             * and a rescan. The Backups tab puts it back. */
            $scope.deleteProcess = function () {
               var d = $scope.state.del, inst = $scope.state.instance;
               if (!d || !d.callers || d.callers.blocked) return $q.when();
               return readFullProcesses(inst).then(function (procs) {
                  var def = procs[d.name.toLowerCase()];
                  if (!def) throw new Error(t("SAASMIG_BACKUPREADFAILED", { name: d.name }));
                  return saveBackup(inst, [{ type: "Deleted", objectType: "Process", name: def.Name, definition: def }]).then(function () {
                     $scope.state.busy = t("SAASMIG_DELETING", { name: d.name, i: 1, n: 1 });
                     return deleteObject(inst, { type: "Process", name: def.Name });
                  });
               }).then(function () {
                  log("delete", "Process " + d.name + ": deleted");
                  Notification.success({ message: t("SAASMIG_DELDONE", { name: d.name }) });
                  $scope.state.del = null; $scope.state.detail = null;
               }).catch(function (e) {
                  d.error = e.message || String(e);
                  Notification.error({ message: d.error });
               }).finally(function () {
                  $scope.state.busy = null;
                  return $scope.scan();
               });
            };

            // --------------------------------------------------------------- apply

            /* One process: a dry-run compile on the source (and on the TM1 12
             * target when one is chosen), a PATCH of only the changed
             * procedures, a re-read, a compile of what was saved -- and on any
             * failure after the PATCH, the original goes back. */
            var applyProcess = function (inst, prev) {
               var p = prev.before, fix = prev.fix, name = prev.name;
               if (!fix.fixable) {
                  return $q.reject(new Error(t("SAASMIG_NOTFIXABLE") + " " + fix.blockers.map(function (b) { return core.PROCEDURE_LABEL[b.procedure] + " " + b.line; }).join(", ")));
               }
               if (!fix.changed) return $q.when({ skipped: true });
               var body = core.compileBody(p, fix.procedures);
               var compileErrors = function (r, where) {
                  must(r);
                  var errs = r.data.value || [];
                  if (errs.length) throw new Error(where + ": " + errs.map(function (e) { return e.Procedure + " " + e.LineNumber + " " + core.compileMessage(e.Message); }).join("; "));
               };
               var step = call(inst, "POST", "/CompileProcess", body).then(function (r) { compileErrors(r, t("SAASMIG_DRYRUN")); });
               // on a v12 database the dry run above already is the v12 compiler
               if ($scope.state.target && !$scope.isV12()) {
                  step = step.then(function () {
                     return call($scope.state.target, "POST", "/CompileProcess", body).then(function (r) { compileErrors(r, t("SAASMIG_DRYRUNV12")); });
                  });
               }
               var patched = false;
               var enc = core.path([["Processes", name]]);
               return step.then(function () {
                  return call(inst, "PATCH", enc, core.processPatch(fix));
               }).then(function (r) {
                  must(r); patched = true;
                  return call(inst, "GET", enc + "?$select=PrologProcedure,MetadataProcedure,DataProcedure,EpilogProcedure");
               }).then(function (r) {
                  must(r);
                  core.PROCEDURES.forEach(function (k) {
                     if ((r.data[k] || "") !== (fix.procedures[k] || "")) throw new Error(t("SAASMIG_REREADMISMATCH") + " " + core.PROCEDURE_LABEL[k]);
                  });
                  return call(inst, "POST", enc + "/tm1.Compile", {});
               }).then(function (r) {
                  compileErrors(r, t("SAASMIG_COMPILE"));
                  core.PROCEDURES.forEach(function (k) { p[k] = fix.procedures[k]; });   // the scan's copy follows the server
                  return { applied: true, removed: fix.removed.length, manual: fix.needsManualWork };
               }).catch(function (e) {
                  if (!patched) throw e;
                  var original = {};
                  core.PROCEDURES.forEach(function (k) { original[k] = p[k] || ""; });
                  return call(inst, "PATCH", enc, original).then(function (r) {
                     throw new Error(e.message + " -- " + (ok(r) ? t("SAASMIG_ROLLEDBACK") : t("SAASMIG_ROLLBACKFAILED") + " " + errorText(r)));
                  });
               });
            };

            var applySubset = function (inst, prev) {
               var s = prev.subset;
               var path = core.path([["Dimensions", s.dimension], ["Hierarchies", s.hierarchy], ["Subsets", s.name]]);
               return call(inst, "PATCH", path, { Expression: prev.afterMdx }).then(function (r) {
                  must(r);
                  return call(inst, "GET", path + "?$select=Expression");
               }).then(function (r) {
                  must(r);
                  if (r.data.Expression !== prev.afterMdx) throw new Error(t("SAASMIG_REREADMISMATCH") + " MDX");
                  var f = $scope.state.scan.findings.filter(function (x) { return x.objectType === "Subset" && x.object === prev.name; })[0];
                  updateSubsetModel(s, prev.afterMdx);
                  return { applied: true, finding: f };
               });
            };

            /* An MDX view is written as a subset is: PATCH the MDX, then re-read it
             * (measured 2026-10-09 on 11.8: PATCH {MDX} answers 200 and reads back
             * as sent, with or without the @odata.type). */
            var viewPath = function (v) { return core.path([["Cubes", v.cube], ["Views", v.name]]); };
            var applyView = function (inst, prev) {
               var path = viewPath(prev.view);
               return call(inst, "PATCH", path, { "@odata.type": "ibm.tm1.api.v1.MDXView", MDX: prev.afterMdx }).then(function (r) {
                  must(r);
                  return call(inst, "GET", path + "?$select=Name,ibm.tm1.api.v1.MDXView/MDX");
               }).then(function (r) {
                  must(r);
                  if (r.data.MDX !== prev.afterMdx) throw new Error(t("SAASMIG_REREADMISMATCH") + " MDX");
                  var f = $scope.state.scan.findings.filter(function (x) { return x.objectType === "View" && x.object === prev.name; })[0];
                  updateViewModel(prev.view, prev.afterMdx);
                  return { applied: true, finding: f };
               });
            };
            var updateViewModel = function (v, mdx) {
               ($scope.state.scan.model.views || []).forEach(function (c) {
                  if (c.Name !== v.cube) return;
                  (c.Views || []).forEach(function (x) { if (x.Name === v.name) x.MDX = mdx; });
               });
            };

            var updateSubsetModel = function (s, expr) {
               ($scope.state.scan.model.dimensions || []).forEach(function (d) {
                  if (d.Name !== s.dimension) return;
                  (d.Hierarchies || []).forEach(function (h) {
                     if (h.Name !== s.hierarchy) return;
                     (h.Subsets || []).forEach(function (x) { if (x.Name === s.name) x.Expression = expr; });
                  });
               });
            };

            var backupEntry = function (prev) {
               if (prev.type === "Process") {
                  var b = { type: "Process", name: prev.name, before: {} };
                  core.PROCEDURES.forEach(function (k) { b.before[k] = prev.before[k] || ""; });
                  return b;
               }
               if (prev.type === "View") return { type: "View", name: prev.name, view: prev.view, before: { MDX: prev.beforeMdx } };
               return { type: "Subset", name: prev.name, subset: prev.subset, before: { Expression: prev.beforeMdx } };
            };

            /* Apply a list of previews in order, stopping at the first failure.
             * The backup of everything in the run is saved before the first
             * write, so a failure part-way leaves a file that restores it all. */
            var run = function (previews) {
               var inst = $scope.state.instance;
               var todo = previews.filter(function (p) { return p && p.fix && p.fix.changed; });
               if (!todo.length) { Notification.info({ message: t("SAASMIG_NOTHINGTOAPPLY") }); return $q.when(); }
               var done = 0;
               $scope.state.cancel = false;
               var chain = saveBackup(inst, todo.map(backupEntry));
               todo.forEach(function (prev) {
                  chain = chain.then(function () {
                     if ($scope.state.cancel) throw new Error(t("SAASMIG_CANCELLED"));
                     $scope.state.busy = t("SAASMIG_APPLYING", { name: prev.name, i: done + 1, n: todo.length });
                     return (prev.type === "Process" ? applyProcess(inst, prev) : prev.type === "View" ? applyView(inst, prev) : applySubset(inst, prev)).then(function (res) {
                        done++;
                        log("apply", prev.type + " " + prev.name + ": " + t(res && res.manual ? "SAASMIG_APPLIEDMANUAL" : "SAASMIG_APPLIED"));
                        return res;
                     }, function (e) {
                        log("error", prev.type + " " + prev.name + ": " + e.message);
                        throw e;
                     });
                  });
               });
               return chain.then(function () {
                  Notification.success({ message: t("SAASMIG_APPLYDONE", { n: done }) });
                  return { done: done };
               }).catch(function (e) {
                  Notification.error({ message: t("SAASMIG_APPLYSTOPPED", { n: done, total: todo.length }) + " " + e.message });
                  return { done: done, error: e.message };
               }).finally(function () {
                  $scope.state.busy = null;
                  $scope.state.selected = {};
                  $scope.state.detail = null;
                  $scope.rescanQuiet();
               });
            };

            $scope.applyDetail = function () {
               var d = $scope.state.detail;
               if (!d || !d.preview) return $q.when();
               return run([d.preview]);
            };

            $scope.openBulk = function () {
               var list = _.values($scope.state.selected).map(function (s) { return previewFor(s.type, s.name); });
               $scope.state.bulk = {
                  previews: list,
                  fixable: list.filter(function (p) { return p.fix.fixable && p.fix.changed; }),
                  blocked: list.filter(function (p) { return !p.fix.fixable; }),
                  statements: _.sumBy(list, function (p) { return p.fix.removed.length; })
               };
            };
            $scope.closeBulk = function () { $scope.state.bulk = null; };
            $scope.applyBulk = function () {
               var b = $scope.state.bulk;
               $scope.state.bulk = null;
               return b ? run(b.fixable) : $q.when();
            };
            $scope.cancelRun = function () { $scope.state.cancel = true; };

            /* After an Apply the findings are recomputed from the scan's own copy
             * of the code, which now matches the server, without re-reading. */
            $scope.rescanQuiet = function () {
               var s = $scope.state.scan;
               if (!s) return;
               var result = core.scanModel(s.model, { v12: $scope.isV12() });
               // the page's own reads (element names, TM1SubsetBasis, rewrite checks, element security) are not repeated: their results carry over
               s.findings = core.carryPageResults(s.findings, result); s.summary = core.summarise(s.findings); s.dropped = result.dropped; s.usesRemoved = result.usesRemoved;
               s.elementRefs = result.elementRefs;
               s.appsGroup = core.tm1ApplicationsGroup(s.findings);
               s.bedrockGroup = core.bedrockGroup(s.findings);
               s.findings.forEach(function (f, i) { f.id = i; });
            };

            // -------------------------------------------------------- v12 compile

            /* Dry-runs every process against the TM1 v12 compiler
             * (§2.4, oracle row). Saves nothing. TM1 Applications only when
             * they are shown. */
            $scope.v12Check = function () {
               var s = $scope.state.scan, target = $scope.compileTarget();
               if (!s || !target) return $q.when();
               var list = s.model.processes.filter(function (p) { return $scope.state.filters.showApps || !core.isTM1Applications(p.Name); });
               var res = { target: target, total: list.length, done: 0, failed: [], at: new Date() };
               $scope.state.v12check = res;
               $scope.state.cancel = false;
               var chain = $q.when();
               list.forEach(function (p) {
                  chain = chain.then(function () {
                     if ($scope.state.cancel) return;
                     $scope.state.busy = t("SAASMIG_V12CHECKING", { i: res.done + 1, n: res.total });
                     return call(target, "POST", "/CompileProcess", core.compileBody(p)).then(function (r) {
                        res.done++;
                        if (!ok(r)) { res.failed.push({ name: p.Name, errors: [errorText(r)] }); return; }
                        var errs = r.data.value || [];
                        if (errs.length) res.failed.push({ name: p.Name, errors: errs.map(function (e) { return e.Procedure + " " + e.LineNumber + ": " + core.compileMessage(e.Message); }) });
                     });
                  });
               });
               return chain.finally(function () { $scope.state.busy = null; res.finished = new Date(); res.cancelled = $scope.state.cancel; });
            };

            // ------------------------------------------------ tm1s.cfg, migrate.log, compare

            /* Part of the scan on a v11 database (tm1s.cfg is a pre-migration
             * check). A failed read is reported in the section and does not
             * stop the scan: the rest of the model is still worth reading. */
            var readCfg = function (inst) {
               $scope.state.cfg = null;
               $scope.state.migrateCmd = null;
               if ($scope.isV12()) return $q.when();
               $scope.state.busy = t("SAASMIG_READCONFIG");
               var fileDir = null;
               return call(inst, "GET", "/StaticConfiguration").then(function (r) {
                  if (!ok(r)) { $scope.state.cfg = { error: errorText(r) }; return; }
                  $scope.state.cfg = core.checkCfg(core.cfgFromRest(r.data));
                  fileDir = $scope.state.cfg.databaseDirectory;
               }).then(function () {
                  // the migrate.log section's command; a failed read still offers it, with a placeholder
                  return call(inst, "GET", "/Configuration?$select=DataBaseDirectory,ServerName").then(function (r) {
                     var c = ok(r) ? r.data : {};
                     $scope.state.migrateCmd = core.migrateCommand(fileDir, c.DataBaseDirectory, c.ServerName || inst);
                  });
               });
            };

            /* The utility reads the .cub files on disk, so data still only in
             * memory would not migrate. Same unbound-TI route as SecurityRefresh
             * (no process is left behind). Asked first: on a large model
             * SaveDataAll holds the server for a while. */
            var SAVE_DATA_ALL = { Process: { Name: "}saasmig_save_data_all", PrologProcedure: "SaveDataAll;\r\n" } };
            $scope.saveData = function () {
               var inst = $scope.state.instance, started = Date.now();
               if (!inst || !window.confirm(t("SAASMIG_SAVEDATACONFIRM", { inst: inst }))) return $q.when();
               $scope.state.error = null;
               $scope.state.savedData = null;
               $scope.state.busy = t("SAASMIG_SAVINGDATA");
               return call(inst, "POST", "/ExecuteProcessWithReturn", SAVE_DATA_ALL).then(function (r) {
                  must(r);
                  if (r.data.ProcessExecuteStatusCode !== "CompletedSuccessfully") throw new Error("SaveDataAll: " + r.data.ProcessExecuteStatusCode);
                  $scope.state.savedData = { instance: inst, at: new Date(), seconds: Math.round((Date.now() - started) / 100) / 10 };
                  log("save", t("SAASMIG_LOGSAVED", { inst: inst, s: $scope.state.savedData.seconds }));
               }).catch(function (e) { $scope.state.error = e.message || String(e); })
                  .finally(function () { $scope.state.busy = null; });
            };

            $scope.readLog = function (text, name, fromProject, extra) {
               if (!fromProject) prjSaveMigrateLog(text, name);
               var log = core.parseMigrateLog(text);
               var cmp = $scope.state.scan ? core.compareLog(log, $scope.state.scan.findings) : null;
               $scope.state.migrateLog = { fileName: name, log: log, compare: cmp, verdict: core.migrateVerdict(log, cmp, extra), processes: Object.keys(log.processes),
                  dataSource: Object.keys(log.dataSource),
                  warnCounts: Object.keys(log.warnCounts).map(function (k) { return { message: k, n: log.warnCounts[k] }; }) };
            };

            /* Selected v11: what it has that the TM1 12 target lacks.
             * Selected v12: what the original v11 database has that this one
             * lacks -- read with its code, so each missing process says why. */
            $scope.compare = function () {
               var s = $scope.state.scan, other = $scope.state.target;
               if (!s || !other) return $q.when();
               var fromV12 = $scope.isV12(), them = {};
               var read = function (key, path) {
                  $scope.state.busy = t("SAASMIG_COMPARING");
                  return call(other, "GET", path).then(function (r) { must(r); them[key] = r.data.value; });
               };
               return read("processes", fromV12 ? SELECT_PROCESSES : "/Processes?$select=Name")
                  .then(function () { return read("cubes", "/Cubes?$select=Name"); })
                  .then(function () { return read("dimensions", "/Dimensions?$select=Name"); })
                  .then(function () { return read("chores", "/Chores?$select=Name"); })
                  .then(function () {
                     var v11 = fromV12 ? them : s.model, v12 = fromV12 ? s.model : them;
                     var m = core.compareModels(v11, v12);
                     m.other = other;
                     m.fromV12 = fromV12;
                     m.at = new Date();
                     m.reasons = {};
                     var findings = s.findings;
                     if (fromV12) {
                        findings = [];
                        (them.processes || []).forEach(function (p) {
                           if (m.processes.indexOf(p.Name) >= 0) findings = findings.concat(core.scanProcess(p));
                        });
                     }
                     m.processes.forEach(function (p) {
                        m.reasons[p] = findings.filter(function (f) { return f.object === p && f.severity === "BLOCKER"; })
                           .map(function (f) { return f.function || f.rule; }).filter(function (v, i, a) { return a.indexOf(v) === i; }).join(", ");
                     });
                     $scope.state.compare = m;
                  })
                  .catch(function (e) { $scope.state.error = e.message; })
                  .finally(function () { $scope.state.busy = null; });
            };

            // ------------------------------------------- backups of whole objects

            /* Every non-empty leaf cell of a small cube (§2.6). */
            var readCells = function (inst, cube, dims) {
               return call(inst, "POST", "/ExecuteMDX?$expand=Axes($expand=Tuples($expand=Members($select=Name))),Cells($select=Value,RuleDerived)",
                  { MDX: core.cubeDataMdx(cube, dims) }).then(function (r) {
                  must(r);
                  if (r.data.ID) call(inst, "DELETE", "/Cellsets('" + r.data.ID + "')");
                  return core.cellsetRows(r.data);
               });
            };

            /* All processes with every property, in one read: a restore needs
             * UIData, VariablesUIData and HasSecurityAccess, not just the code. */
            var readFullProcesses = function (inst) {
               $scope.state.busy = t("SAASMIG_READINGBACKUP");
               return call(inst, "GET", "/Processes").then(function (r) {
                  must(r);
                  var out = {};
                  r.data.value.forEach(function (p) { out[p.Name.toLowerCase()] = core.stripOdata(p); });
                  return out;
               });
            };

            /* The backup entries for items about to be deleted: the definition
             * that recreates each one, a cube's cells, a dimension's attribute
             * values. A view keeps its @odata.type, which says whether it is an
             * MDX view (restorable) or a native one (restored by hand). */
            var readDefinitions = function (inst, items) {
               var entries = [], procs = null;
               var chain = items.some(function (i) { return i.type === "Process"; })
                  ? readFullProcesses(inst).then(function (p) { procs = p; }) : $q.when();
               items.forEach(function (item, k) {
                  chain = chain.then(function () {
                     var e = { type: "Deleted", objectType: item.type, name: item.name, parent: item.parent || null,
                        hierarchy: item.hierarchy || null, control: !!item.control };
                     if (item.type === "Process") {
                        e.definition = procs[item.name.toLowerCase()];
                        if (!e.definition) throw new Error(t("SAASMIG_BACKUPREADFAILED", { name: item.name }));
                        entries.push(e);
                        return;
                     }
                     $scope.state.busy = t("SAASMIG_READINGBACKUPOF", { name: item.name, i: k + 1, n: items.length });
                     /* A cube whose cells this session may not read -- 9 of 13 }tp_
                      * cubes refuse even Admin, "User does not have read access
                      * (rte 34)" (plan §2.13) -- keeps its definition and is marked;
                      * the delete then asks for an explicit tick (user, 2026-10-03).
                      * Any other failure still stops the backup, and nothing is deleted. */
                     var unreadable = function (key) {
                        return function (err) {
                           if (/does not have read access/i.test(err && err.message || "")) { e[key] = err.message; return; }
                           throw err;
                        };
                     };
                     return call(inst, "GET", core.definitionPath(item)).then(function (r) {
                        must(r);
                        e.definition = item.type === "View" ? r.data : core.stripOdata(r.data);
                        if (item.type === "Cube") {
                           return readCells(inst, item.name, (r.data.Dimensions || []).map(function (d) { return d.Name; }))
                              .then(function (rows) { e.cells = rows; }, unreadable("cellsUnreadable"));
                        }
                        if (item.type === "Dimension" && !item.control) {
                           var h = (r.data.Hierarchies || []).filter(function (x) { return x.Name === item.name; })[0];
                           if (h && (h.ElementAttributes || []).length) {
                              var ac = "}ElementAttributes_" + item.name;
                              return readCells(inst, ac, [item.name, ac]).then(function (rows) { e.attributeCells = rows; }, unreadable("attributeCellsUnreadable"));
                           }
                        }
                     }).then(function () { entries.push(e); });
                  });
               });
               return chain.then(function () { return entries; });
            };

            /* The backup, before the first write -- every caller chains its write
             * on this promise (v0.14.0: it was a synchronous download). With a
             * project open it goes into the project's backups/ folder, and a
             * failed write there falls back to the download, so a backup is
             * never lost and an Apply is never blocked by the folder. A project
             * kept in this browser downloads it as well: IndexedDB is cleared
             * with the site data, and a backup must outlive that.
             *
             * A scan read back from a project is refused here: the change would
             * be built from code captured then, not as it is now. CloudID writes
             * (`notFromScan`) read their values live, so they pass. */
            var saveBackup = function (inst, entries, notFromScan) {
               if (!notFromScan && $scope.state.scan && $scope.state.scan.fromProject) return $q.reject(new Error(t("SAASMIG_PRJSTALE")));
               var when = new Date();
               var backup = core.backupFile(inst, entries, when);
               var fileName = core.backupFileName(inst, when);
               var text = JSON.stringify(backup, null, 2);
               var row = { name: fileName, at: when, count: entries.length, backup: backup, where: "download" };
               $scope.state.backups.unshift(row);
               log("backup", t("SAASMIG_LOGBACKUP", { file: fileName, n: entries.length }));
               if (!project.canWrite()) { $scope.saveFile(fileName, text); return $q.when(fileName); }
               if (project.current.mode === "browser") $scope.saveFile(fileName, text);
               return project.write("backups/" + fileName, text).then(function () {
                  row.where = "project";
                  core.projectAddBackup(project.current.project, { file: fileName, instance: inst, at: when.toISOString(), count: entries.length });
                  return project.saveManifest().catch(angular.noop);
               }, function (e) {
                  if (project.current && project.current.mode !== "browser") $scope.saveFile(fileName, text);
                  log("error", t("SAASMIG_PRJBACKUPFALLBACK", { file: fileName, error: String(e && e.message || e) }));
               }).then(function () { return fileName; });
            };


            /* DELETE, then a read that must answer 404. A 404 on the DELETE itself is not an error: TM1
             * removes most control objects with their parent. Direct, with these guardrails (user,
             * 2026-10-06), each answer read through core.deleteAnswer:
             *  - only TM1's own 404 (its error body) means "not there"; a proxy's 404 is "unknown";
             *  - a DELETE whose answer is unknown (time-out, dropped, a gateway 5xx) is never repeated:
             *    the read decides. It may have happened, so "still there" is read once more after 3 s;
             *  - a 401/403 after the ~10 s reconnect wait stops the run: every next item would fail too;
             *  - DELETE_UNKNOWN_STOP unknown outcomes in a row stop the run (state.cancel): the rest is
             *    skipped, not attempted blind. The backup was written before the first delete. */
            var DELETE_MS = 30000, VERIFY_MS = 15000, DELETE_UNKNOWN_STOP = 2, deleteUnknowns = 0;
            var deleteObject = function (inst, item) {
               var p = core.objectPath(item), q = p + (item.type === "Process" || item.type === "Chore" ? "?$select=Name" : "");
               var why = function (r) {
                  return r && r.status > 0 ? "HTTP " + r.status : t(r && r.noIds ? "SAASMIG_DELNOIDS" : r && r.timedOut ? "SAASMIG_DELTIMEOUT" : "SAASMIG_DELNOANSWER");
               };
               var stopRun = function (message) {
                  $scope.state.cancel = true;
                  log("error", message);
                  return $q.reject(new Error(message));
               };
               var tm1Spoke = function () { deleteUnknowns = 0; };
               var unknown = function (r, method) {
                  diag("rest", { method: method, path: p, status: r && r.status, direct: true, unknown: true, timedOut: !!(r && r.timedOut) });
                  if (++deleteUnknowns >= DELETE_UNKNOWN_STOP) { deleteUnknowns = 0; return stopRun(t("SAASMIG_DELSTOPPED", { why: why(r) })); }
                  return $q.reject(new Error(t("SAASMIG_DELUNKNOWN", { why: why(r) })));
               };
               var verify = function (again) {
                  return directSignedIn(inst, "GET", q, VERIFY_MS).then(function (x) {
                     switch (core.deleteAnswer(x)) {
                        case "missing": tm1Spoke(); return "deleted";
                        case "auth": return stopRun(t("SAASMIG_DELSIGNIN", { inst: inst, status: x.status }));
                        case "unknown": return unknown(x, "GET");
                        default:
                           tm1Spoke();
                           if (again) return $timeout(function () { }, 3000).then(function () { return verify(false); });
                           throw new Error(t("SAASMIG_STILLTHERE") + " (" + (x.status === 200 ? "HTTP 200" : errorText(x)) + ")");
                     }
                  });
               };
               return directSignedIn(inst, "DELETE", p, DELETE_MS).then(function (r) {
                  switch (core.deleteAnswer(r)) {
                     case "missing": tm1Spoke(); return "gone";
                     case "auth": return stopRun(t("SAASMIG_DELSIGNIN", { inst: inst, status: r.status }));
                     case "tm1error": tm1Spoke(); throw new Error(errorText(r));
                     case "ok": return verify(false);
                     // the DELETE may have happened: never sent twice, the read decides
                     default:
                        diag("rest", { method: "DELETE", path: p, status: r && r.status, direct: true, unknown: true, timedOut: !!(r && r.timedOut) });
                        return verify(true);
                  }
               });
            };
            // a seam, as saveFile is, so a live check can drive the guardrails without a clean-up run
            $scope.deleteObjectCheck = deleteObject;


            // ------------------------------------------------------ Data-source files (TM1 12)

            /* The plan is read from the scan's processes; the files are the ones
             * the user picks, because nothing in a browser can read the v11
             * server's disk. Measured on 12.6.4 (plan §2.13): a Blob body is
             * uploaded byte for byte while an ArrayBuffer through $tm1.async is
             * not, and DELETE of a non-empty folder removes it recursively -- so
             * this never deletes a folder, and undoing an upload deletes only
             * the document it created. */
            // the Data files tab: (re)built when it opens on a plan made for another database
            $scope.openDataFiles = function () {
               $scope.state.tab = "datafiles";
               var d = $scope.state.dataFiles;
               if (!d || d.instance !== $scope.state.instance) $scope.loadDataFiles();
            };
            $scope.loadDataFiles = function () {
               var s = $scope.state.scan;
               if (!s) return;
               var prev = $scope.state.dataFiles;
               /* another database's results, selection and server check do not carry over (they showed up as
                * stale "attention" rows on a second TM1 12 database); the picked folder does: it is still the
                * folder v11 read the files from */
               if (prev && prev.instance !== s.instance) prev = { root: prev.root, files: prev.files, filter: "all", result: null, selected: {}, server: null, checkedAt: null };
               var root = prev ? prev.root : "Imports";
               var rows = core.dataFilePlan(s.model.processes, { root: root });
               $scope.state.dataFiles = { instance: s.instance, root: root, rows: rows, files: prev ? prev.files : [], matches: null, confirm: false, result: prev ? prev.result : null, filter: prev ? prev.filter : "all", selected: prev ? prev.selected || {} : {},
                  server: prev ? prev.server : null, checkedAt: prev ? prev.checkedAt : null, compare: null };
               if (prev && prev.files.length) $scope.state.dataFiles.matches = core.matchDataFiles(rows, prev.files);
               $scope.dfRefresh();
               if ($scope.isV12()) $scope.dfServerCheck();
            };
            /* What the Files area holds where each process reads now and where
             * its file would go (user, v0.8.1): read from TM1 12 on every load,
             * so "uploaded and pointed at" survives a rescan, a reload and a
             * change of the Upload-to folder. One GET per folder (the listing
             * carries Size and LastUpdated); a missing folder is an empty one.
             * One call at a time: two loops at once against PA as a Service
             * broke $tm1.async (plan §2.13). */
            var dfCheckRun = 0;
            $scope.dfServerCheck = function () {
               var d = $scope.state.dataFiles, inst = $scope.state.instance, run = ++dfCheckRun, map = {};
               if (!d || !$scope.isV12()) return $q.when();
               d.checking = true;
               var chain = $q.when();
               core.dataFileFolders(d.rows).forEach(function (parts) {
                  chain = chain.then(function () {
                     if (run !== dfCheckRun) return;
                     return call(inst, "GET", core.filesPath(parts) + "/Contents").then(function (r) {
                        if (r.status === 404) return;
                        must(r);
                        (r.data.value || []).forEach(function (x) {
                           if (x["@odata.type"] && !/Document$/.test(x["@odata.type"])) return;
                           map[core.filesKey(parts.concat([x.Name]).join("/"))] = { size: x.Size, updated: x.LastUpdated };
                        });
                     });
                  });
               });
               return chain.then(function () {
                  if (run !== dfCheckRun || $scope.state.dataFiles !== d) return;
                  d.server = map; d.checkedAt = new Date(); d.checkError = null;
                  $scope.dfRefresh();
               }).catch(function (e) {
                  if (run === dfCheckRun) d.checkError = e.message;
               }).finally(function () { if (run === dfCheckRun) d.checking = false; });
            };
            /* The table's rows are rebuilt here, never in a function ng-repeat
             * calls: fresh objects on every digest would never settle. */
            $scope.dfRefresh = function () {
               var d = $scope.state.dataFiles;
               if (!d) return;
               d.view = core.dataFileView(d.rows, d.matches, d.result, $scope.isV12() ? d.filter : "all", !$scope.isV12(), $scope.isV12() ? d.server : null);
               var res = (d.result || []).filter(function (x) { return x.process; });
               var good = res.filter(function (x) { return (x.change === "updated" || x.change === "unchanged") && (x.file === "uploaded" || x.file === "same" || x.file === "replaced"); }).length;
               d.summary = d.result ? { done: good, attention: res.length - good } : null;
               d.view.found = (d.matches || []).filter(function (m) { return m.file; }).length;
            };
            $scope.dfFilter = function (f) { $scope.state.dataFiles.filter = f; $scope.dfRefresh(); };
            $scope.dataFilesPicked = function (files) {
               var d = $scope.state.dataFiles;
               d.files = files;
               d.matches = core.matchDataFiles(d.rows, files);
               d.result = null;
               d.selected = {};
               $scope.dfRefresh();
               // every ready row, whatever the filter shows: not one already done, not a conflict
               core.dataFileView(d.rows, d.matches, null, "all", true, $scope.isV12() ? d.server : null).rows.forEach(function (v) {
                  if ($scope.dfSelectable(v)) d.selected[v.row.process.toLowerCase()] = true;
               });
            };
            $scope.dataFilesClear = function () {
               var d = $scope.state.dataFiles;
               d.files = []; d.matches = null; d.result = null; d.selected = {};
               $scope.dfRefresh();
            };
            /* Selection (user, v0.8.0): a row can be ticked when it is ready -- a
             * file was found for it, its path is not set in its code, and TM1 12
             * holds neither that file already read by the process nor a different
             * file in its place. Picking ticks them all; the button counts them. */
            $scope.dfSelectable = function (v) { return !!(v && v.status === "ready" && v.match && v.match.file && !v.row.setInCode); };
            $scope.dfIsSelected = function (v) { var d = $scope.state.dataFiles; return $scope.dfSelectable(v) && !!d.selected[v.row.process.toLowerCase()]; };
            $scope.dfToggle = function (v) { var d = $scope.state.dataFiles, k = v.row.process.toLowerCase(); if ($scope.dfSelectable(v)) d.selected[k] = !d.selected[k]; };
            $scope.dfSelection = function () {
               var d = $scope.state.dataFiles, rows = (d && d.view ? d.view.rows : []).filter($scope.dfSelectable), on = rows.filter($scope.dfIsSelected).length;
               return { selectable: rows.length, all: rows.length > 0 && on === rows.length, some: on > 0 && on < rows.length };
            };
            // ticks or clears the rows in view, as Carbon's header checkbox does
            $scope.dfToggleAll = function () {
               var d = $scope.state.dataFiles, all = $scope.dfSelection().all;
               d.view.rows.filter($scope.dfSelectable).forEach(function (v) { d.selected[v.row.process.toLowerCase()] = !all; });
            };
            $scope.dfTagClass = function (v) {
               var r = v.result;
               if (!r) return "";
               if (r.file === "failed" || r.change === "failed") return "ux-tag-error";
               return v.status === "done" ? "ux-tag-success" : "ux-tag-warning";
            };
            // a <label> is not a button: Enter and Space open its file input
            $scope.dfKeyPick = function (e) {
               if (e.keyCode !== 13 && e.keyCode !== 32) return;
               e.preventDefault();
               var input = e.currentTarget.querySelector("input[type=file]");
               if (input) input.click();
            };
            // Enter or Space on a clickable non-button (a tile) does what a click does
            $scope.keyActivate = function (e) {
               if (e.keyCode !== 13 && e.keyCode !== 32) return;
               e.preventDefault();
               e.currentTarget.click();
            };
            $scope.dfDrag = { over: false };
            $scope.dfFolderName = function () {
               var f = $scope.state.dataFiles.files[0], p = f && String(f.relPath || "").replace(/\\/g, "/");
               return p && p.indexOf("/") > 0 ? p.split("/")[0] : "";
            };
            var DF_TEXT = {
               file: { uploaded: "SAASMIG_DFFILEUPLOADED", replaced: "SAASMIG_DFFILEREPLACED", same: "SAASMIG_DFFILESAME", different: "SAASMIG_DFFILEDIFFERENT", failed: "SAASMIG_DFFILEFAILED", skipped: "SAASMIG_DFFILESKIPPED" },
               change: { updated: "SAASMIG_DFCHANGEUPDATED", unchanged: "SAASMIG_DFCHANGEUNCHANGED", "not changed": "SAASMIG_DFCHANGENOT", failed: "SAASMIG_DFCHANGEFAILED" },
               filter: { all: "SAASMIG_DFFILTERALL", attention: "SAASMIG_DFFILTERATTENTION", missing: "SAASMIG_DFFILTERMISSING", ready: "SAASMIG_DFFILTERREADY", done: "SAASMIG_DFFILTERDONE" }
            };
            $scope.dfText = function (kind, v) { var k = DF_TEXT[kind][v]; return k ? t(k) : (v || ""); };
            $scope.dataFilesReady = function () {
               var d = $scope.state.dataFiles;
               if (!d || !d.matches) return [];
               return d.rows.map(function (r, i) { return { row: r, file: d.matches[i].file }; })
                  .filter(function (x) { return x.file && !x.row.setInCode && d.selected && d.selected[x.row.process.toLowerCase()]; });
            };

            /* The process's data source points at a Files path; read back. */
            var pointProcessAt = function (inst, name, target, full) {
               var before = (full && full.DataSource) || {}, ds = {};
               for (var key in before) if (before.hasOwnProperty(key)) ds[key] = before[key];
               ds.dataSourceNameForServer = target; ds.dataSourceNameForClient = target;
               var p = core.path([["Processes", name]]);
               $scope.state.busy = t("SAASMIG_DFUPDATING", { name: name });
               return call(inst, "PATCH", p, { DataSource: ds }).then(must).then(function () {
                  return call(inst, "GET", p + "?$select=DataSource");
               }).then(function (r) {
                  must(r);
                  if ((r.data.DataSource || {}).dataSourceNameForServer !== target) throw new Error(t("SAASMIG_REREADMISMATCH") + " " + name);
                  var mp = $scope.state.scan && $scope.state.scan.processByName[name];
                  if (mp) mp.DataSource = r.data.DataSource;
                  log("datafiles", t("SAASMIG_LOGDFUPDATED", { name: name, path: target }));
               });
            };

            /* A Files document's exact bytes. $tm1.async decodes the body as
             * text (measured: 1,101 characters for a 2,204-byte UTF-16 file),
             * so this is a plain fetch through Arc's own proxy path, which
             * returns the bytes (2,204, BOM first). A 401/403 right after a
             * load is the session reconnecting (§2.15): retried. */
            var readFileBytes = function (inst, parts, left) {
               var tries = left === undefined ? 4 : left;
               return $q.when(fetch("/" + inst + core.filesPath(parts) + "/Content", { credentials: "include", cache: "no-store" })).then(function (r) {
                  if ((r.status === 401 || r.status === 403) && tries > 0) return $timeout(function () { }, 2500).then(function () { return readFileBytes(inst, parts, tries - 1); });
                  if (r.status !== 200) throw new Error("HTTP " + r.status);
                  return $q.when(r.arrayBuffer()).then(function (b) { return new Uint8Array(b); });
               });
            };
            var blobBytes = function (blob) {
               return $q(function (resolve, reject) {
                  var fr = new FileReader();
                  fr.onload = function () { resolve(new Uint8Array(fr.result)); };
                  fr.onerror = function () { reject(new Error(String(fr.error))); };
                  fr.readAsArrayBuffer(blob);
               });
            };
            var DF_COMPARE_MAX = 8 * 1024 * 1024, DF_REPLACE_MAX = 50 * 1024 * 1024;
            var textOf = function (bytes) {
               var enc = core.detectEncoding(bytes), text = new TextDecoder(enc).decode(bytes);
               var lines = text.split(/\r\n|\n|\r/);
               if (lines.length && lines[lines.length - 1] === "") lines.pop();
               return { enc: enc.toUpperCase(), eol: /\r\n/.test(text) ? "CRLF" : /\n/.test(text) ? "LF" : "—", lines: lines };
            };
            var toBase64 = function (bytes) {
               var out = "", step = 0x8000;
               for (var i = 0; i < bytes.length; i += step) out += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
               return btoa(out);
            };
            var fromBase64 = function (b64) {
               var bin = atob(b64), bytes = new Uint8Array(bin.length);
               for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
               return bytes;
            };

            /* Compare (user, v0.8.1): the file on TM1 12 against the one picked
             * for its place, in a dialog. Both are read as bytes and decoded by
             * their own encoding, so a re-saved copy that differs only in its
             * encoding or line ends says so instead of showing every line. */
            var dfCompareBytes = null;
            $scope.dfCompare = function (v) {
               var d = $scope.state.dataFiles, inst = $scope.state.instance, parts = v.row.target.split("/");
               var c = d.compare = { v: v, loading: true, confirm: false };
               dfCompareBytes = null;
               return readFileBytes(inst, parts).then(function (server) {
                  return blobBytes(v.match.file.blob).then(function (picked) {
                     if (d.compare !== c) return;
                     dfCompareBytes = server;
                     c.server = { size: server.length, updated: v.live && v.live.there && v.live.there.updated };
                     c.picked = { size: picked.length, name: v.match.file.relPath };
                     if (server.length > DF_COMPARE_MAX || picked.length > DF_COMPARE_MAX) { c.tooLarge = true; return; }
                     var a = textOf(server), b = textOf(picked);
                     angular.extend(c.server, { lines: a.lines.length, enc: a.enc, eol: a.eol });
                     angular.extend(c.picked, { lines: b.lines.length, enc: b.enc, eol: b.eol });
                     c.diff = core.fileLineDiff(a.lines, b.lines);
                     if (!c.diff.tooBig) c.hunks = core.fileDiffHunks(c.diff.ops, 3, 400);
                     c.diff.ops = null;   // the hunks are what is shown; the full list can be large
                  });
               }).catch(function (e) { c.error = e.message; }).finally(function () { c.loading = false; });
            };
            $scope.dfShowConflicts = function () {
               var c = $scope.state.dataFiles.view.conflicts;
               if (c.length === 1) return $scope.dfCompare(c[0]);
               $scope.dfFilter("attention");
            };
            $scope.dfCompareClose = function () { $scope.state.dataFiles.compare = null; dfCompareBytes = null; };

            /* Replace: the file on TM1 12 is backed up byte for byte (base64 in
             * the backup file; Restore writes it back and checks its size),
             * with every process that reads that path or is planned to; then
             * the picked file is uploaded, its size read back, and the row's
             * process pointed at it. */
            $scope.dfReplace = function () {
               var d = $scope.state.dataFiles, c = d.compare, inst = $scope.state.instance;
               if (!c || !dfCompareBytes || !$scope.isV12()) return $q.when();
               var old = dfCompareBytes, v = c.v, target = v.row.target, parts = target.split("/"), file = v.match.file;
               if (old.length > DF_REPLACE_MAX) { c.error = t("SAASMIG_DFREPLACETOOBIG"); return $q.when(); }
               var key = target.toLowerCase(), touched = d.rows.filter(function (r) { return !r.setInCode && r.target.toLowerCase() === key; });
               var results = d.result ? d.result.slice() : [];
               c.confirm = false; c.replacing = true;
               return readFullProcesses(inst).then(function (full) {
                  var entries = [{ type: "FileReplaced", name: target, parts: parts, size: old.length, base64: toBase64(old) }];
                  touched.forEach(function (r) {
                     if (!full[r.process.toLowerCase()]) throw new Error(t("SAASMIG_BACKUPREADFAILED", { name: r.process }));
                     entries.push({ type: "ProcessFull", name: r.process, before: full[r.process.toLowerCase()] });
                  });
                  return saveBackup(inst, entries).then(function () {
                     $scope.state.busy = t("SAASMIG_DFUPLOADING", { name: target });
                     return call(inst, "PUT", core.filesPath(parts) + "/Content", file.blob).then(must);
                  }).then(function () {
                     return call(inst, "GET", core.filesPath(parts) + "?$select=Name,Size");
                  }).then(function (r) {
                     must(r);
                     if (r.data.Size !== file.size) throw new Error(t("SAASMIG_DFSIZEMISMATCH", { name: target, want: file.size, got: r.data.Size }));
                     log("datafiles", t("SAASMIG_LOGDFREPLACED", { path: target }));
                     var chain = $q.when();
                     touched.forEach(function (r) {
                        chain = chain.then(function () {
                           var ds = (full[r.process.toLowerCase()].DataSource || {}).dataSourceNameForServer;
                           results = results.filter(function (x) { return x.process.toLowerCase() !== r.process.toLowerCase(); });
                           if (ds === target) { results.push({ process: r.process, target: target, file: "replaced", change: "unchanged" }); return; }
                           return pointProcessAt(inst, r.process, target, full[r.process.toLowerCase()]).then(function () {
                              results.push({ process: r.process, target: target, file: "replaced", change: "updated" });
                           }, function (e) { results.push({ process: r.process, target: target, file: "replaced", change: "failed", error: e.message }); });
                        });
                     });
                     return chain;
                  });
               }).then(function () {
                  d.result = results;
                  Notification.success({ message: t("SAASMIG_LOGDFREPLACED", { path: target }) });
                  $scope.dfCompareClose();
                  $scope.rescanQuiet();
                  $scope.loadDataFiles();
               }).catch(function (e) {
                  c.error = e.message;
                  Notification.error({ message: e.message });
               }).finally(function () { c.replacing = false; $scope.state.busy = null; });
            };

            $scope.applyDataFiles = function () {
               var inst = $scope.state.instance, d = $scope.state.dataFiles;
               var todo = $scope.dataFilesReady();
               d.confirm = false;
               if (!todo.length || !$scope.isV12()) return $q.when();
               var results = [], targets = {}, folders = {};
               todo.forEach(function (x) { (targets[x.row.target.toLowerCase()] = targets[x.row.target.toLowerCase()] || { parts: x.row.target.split("/"), file: x.file, rows: [] }).rows.push(x.row); });
               var keys = Object.keys(targets);
               $scope.state.cancel = false;
               // 1. read only: what is already there
               var chain = $q.when();
               keys.forEach(function (k) {
                  chain = chain.then(function () {
                     var tg = targets[k];
                     $scope.state.busy = t("SAASMIG_DFCHECKING", { name: tg.parts.join("/") });
                     return call(inst, "GET", core.filesPath(tg.parts) + "?$select=Name,Size").then(function (r) {
                        if (r.status === 404) tg.state = "new";
                        else if (ok(r)) tg.state = r.data.Size === tg.file.size ? "same" : "different";
                        else throw new Error(errorText(r));
                     });
                  });
               });
               var full = null;
               return chain.then(function () { return readFullProcesses(inst); }).then(function (procs) {
                  full = procs;
                  // 2. the backup: each process as it is, and each file this creates
                  var entries = [];
                  todo.forEach(function (x) {
                     if (x.row.inPlace || targets[x.row.target.toLowerCase()].state === "different") return;
                     if (!entries.some(function (e) { return e.type === "ProcessFull" && e.name === x.row.process; }))
                        entries.push({ type: "ProcessFull", name: x.row.process, before: full[x.row.process.toLowerCase()] });
                  });
                  keys.forEach(function (k) { if (targets[k].state === "new") entries.push({ type: "FileUploaded", name: targets[k].parts.join("/"), parts: targets[k].parts }); });
                  if (entries.some(function (e) { return e.type === "ProcessFull" && !e.before; })) throw new Error(t("SAASMIG_BACKUPREADFAILED", { name: "" }));
                  // 3. upload, once the backup is written: folders, the document, its bytes, and a size read-back
                  var up = entries.length ? saveBackup(inst, entries) : $q.when();
                  keys.forEach(function (k) {
                     var tg = targets[k];
                     up = up.then(function () {
                        if ($scope.state.cancel) { tg.outcome = "skipped"; return; }
                        if (tg.state === "same") { tg.outcome = "same"; return; }
                        if (tg.state === "different") { tg.outcome = "different"; return; }
                        $scope.state.busy = t("SAASMIG_DFUPLOADING", { name: tg.parts.join("/") });
                        var dirs = tg.parts.slice(0, -1), steps = $q.when();
                        dirs.forEach(function (dname, j) {
                           var at = dirs.slice(0, j + 1), fk = at.join("/").toLowerCase();
                           steps = steps.then(function () {
                              if (folders[fk]) return;
                              return call(inst, "GET", core.filesPath(at) + "?$select=Name").then(function (r) {
                                 if (ok(r)) { folders[fk] = true; return; }
                                 if (r.status !== 404) throw new Error(errorText(r));
                                 return call(inst, "POST", core.filesPath(at.slice(0, -1)) + "/Contents", { "@odata.type": "#ibm.tm1.api.v1.Folder", Name: dname })
                                    .then(must).then(function () { folders[fk] = true; });
                              });
                           });
                        });
                        return steps.then(function () {
                           return call(inst, "POST", core.filesPath(dirs) + "/Contents", { "@odata.type": "#ibm.tm1.api.v1.Document", Name: tg.parts[tg.parts.length - 1] }).then(must);
                        }).then(function () {
                           return call(inst, "PUT", core.filesPath(tg.parts) + "/Content", tg.file.blob).then(must);
                        }).then(function () {
                           return call(inst, "GET", core.filesPath(tg.parts) + "?$select=Name,Size");
                        }).then(function (r) {
                           must(r);
                           if (r.data.Size !== tg.file.size) throw new Error(t("SAASMIG_DFSIZEMISMATCH", { name: tg.parts.join("/"), want: tg.file.size, got: r.data.Size }));
                           tg.outcome = "uploaded";
                        }).catch(function (e) { tg.outcome = "failed"; tg.error = e.message; });
                     });
                  });
                  return up;
               }).then(function () {
                  // 4. the processes: the data source points at the uploaded file, then a re-read
                  var pc = $q.when();
                  todo.forEach(function (x) {
                     var tg = targets[x.row.target.toLowerCase()];
                     pc = pc.then(function () {
                        if (x.row.inPlace || (tg.outcome !== "uploaded" && tg.outcome !== "same")) {
                           results.push({ process: x.row.process, target: x.row.target, file: tg.outcome, change: tg.outcome === "uploaded" || tg.outcome === "same" ? "unchanged" : "not changed", error: tg.error || null });
                           return;
                        }
                        return pointProcessAt(inst, x.row.process, x.row.target, full[x.row.process.toLowerCase()]).then(function () {
                           results.push({ process: x.row.process, target: x.row.target, file: tg.outcome, change: "updated" });
                        }).catch(function (e) { results.push({ process: x.row.process, target: x.row.target, file: tg.outcome, change: "failed", error: e.message }); });
                     });
                  });
                  return pc;
               }).then(function () {
                  d.result = results;
                  d.selected = {};
                  // the ON TM1 v12 count drops at once: pointProcessAt patched the scan's model
                  $scope.rescanQuiet();
                  $scope.loadDataFiles();
               }).catch(function (e) {
                  Notification.error({ message: e.message });
                  d.result = results.concat([{ process: "", target: "", file: "", change: "failed", error: e.message }]);
                  $scope.dfRefresh();
               }).finally(function () { $scope.state.busy = null; });
            };

            // ------------------------------------------------------ TM1 Applications

            $scope.loadTp = function () {
               var s = $scope.state.scan;
               if (!s) return;
               var inv = core.tpInventory(s.model), prev = $scope.state.tp;
               var selected = {};
               inv.items.forEach(function (i) { selected[i.key] = prev && prev.selected.hasOwnProperty(i.key) ? prev.selected[i.key] : true; });
               $scope.state.tp = { inv: inv, selected: selected, confirm: false, result: prev ? prev.result : null };
            };
            $scope.tpSelected = function () {
               var tp = $scope.state.tp;
               return tp ? tp.inv.items.filter(function (i) { return tp.selected[i.key]; }) : [];
            };
            $scope.tpSelectAll = function (on) {
               var tp = $scope.state.tp;
               tp.inv.items.forEach(function (i) { tp.selected[i.key] = on; });
            };

            /* Backup first, then delete in dependency order, carrying on past a
             * failure so one refused object does not strand the rest; each
             * outcome is listed. The scan then re-reads the model, and whatever
             * TM1 Applications left behind shows up in the inventory again. */
            $scope.applyTp = function () {
               var inst = $scope.state.instance, tp = $scope.state.tp;
               var items = core.tpDeleteOrder($scope.tpSelected());
               tp.confirm = false;
               if (!items.length) return $q.when();
               var results = [], halted = false;
               $scope.state.cancel = false;
               return readDefinitions(inst, items).then(function (entries) {
                  // cells this session could not read: say which, and delete only after an explicit tick
                  var blind = entries.filter(function (e) { return e.cellsUnreadable || e.attributeCellsUnreadable; }).map(function (e) { return e.objectType + " " + e.name; });
                  if (blind.length && !(tp.ackCells && tp.unreadable && tp.unreadable.join("\u0001") === blind.join("\u0001"))) {
                     tp.unreadable = blind; tp.ackCells = false; tp.confirm = true; halted = true;
                     return;
                  }
                  var chain = saveBackup(inst, entries);
                  items.forEach(function (item, k) {
                     chain = chain.then(function () {
                        if ($scope.state.cancel) { results.push({ item: item, outcome: "skipped" }); return; }
                        $scope.state.busy = t("SAASMIG_DELETING", { name: item.name, i: k + 1, n: items.length });
                        return deleteObject(inst, item).then(function (outcome) {
                           results.push({ item: item, outcome: outcome });
                           log("delete", item.type + " " + item.name + ": " + outcome);
                        }, function (e) {
                           results.push({ item: item, outcome: "error", message: e.message });
                           log("error", item.type + " " + item.name + ": " + e.message);
                        });
                     });
                  });
                  return chain;
               }).then(function () {
                  if (halted) return;
                  tp.unreadable = null; tp.ackCells = false;
                  var failed = results.filter(function (r) { return r.outcome === "error"; }).length;
                  tp.result = { at: new Date(), results: results, failed: failed,
                     deleted: results.filter(function (r) { return r.outcome === "deleted" || r.outcome === "gone"; }).length };
                  // called as a method: Notification's functions need their `this`
                  if (failed) Notification.error({ message: t("SAASMIG_TPDONE", { n: tp.result.deleted, f: failed }) });
                  else Notification.success({ message: t("SAASMIG_TPDONE", { n: tp.result.deleted, f: failed }) });
               }).catch(function (e) {
                  // nothing was deleted: the backup could not be read in full
                  Notification.error({ message: e.message });
                  tp.result = { at: new Date(), results: [], failed: 0, deleted: 0, error: e.message };
               }).finally(function () {
                  $scope.state.busy = null;
                  if (!halted) $scope.scan();
               });
            };

            // --------------------------------------------------------------- Bedrock

            /* The Bedrock 5 code, from GitHub (the default) or from the copy
             * shipped with the plugin. `fetch` rather than $http: Arc's $http
             * interceptors are for TM1, and GitHub is not TM1. */
            $scope.loadBedrock = function () {
               var b = $scope.state.bedrock;
               var url = core.BEDROCK_SOURCES[b.source === "bundled" ? "bundled" : "github"];
               b.loading = true; b.error = null;
               return $q.when(fetch(url, { cache: "no-store" }).then(function (r) {
                  if (!r.ok) throw new Error("HTTP " + r.status + " " + url);
                  return r.json();
               })).then(function (json) {
                  var ref = core.bedrockReference(json);
                  if (ref.error) throw new Error(ref.error);
                  ref.source = b.source; ref.url = url; ref.at = new Date();
                  b.reference = ref;
                  log("bedrock", t("SAASMIG_LOGBEDROCKLOADED", { n: ref.count, source: url }));
                  $scope.planBedrock();
               }).catch(function (e) {
                  b.error = e.message || String(e);
               }).finally(function () { b.loading = false; });
            };

            /* Opening the tab loads Bedrock 5 from the chosen source straight
             * away: without it every row reads "not compared", which says
             * nothing (user, 2026-09-29). A failed load leaves the choice of
             * the bundled copy on screen. */
            /* Whether this install carries its own copy of Bedrock (user, 2026-10-06). Bedrock's licence
             * does not allow publishing its code on a web site without permission, so the public release
             * leaves bedrock/ out; the plugin then offers GitHub only, rather than a choice that 404s. */
            $scope.bedrockBundled = null;
            var checkBundled = function () {
               if ($scope.bedrockBundled !== null) return $q.when($scope.bedrockBundled);
               return $q.when(fetch(core.BEDROCK_SOURCES.bundled, { method: "HEAD", cache: "no-store" }).then(function (r) { return r.ok; }, function () { return false; }))
                  .then(function (has) {
                     $scope.bedrockBundled = has;
                     if (!has && $scope.state.bedrock.source === "bundled") $scope.state.bedrock.source = "github";
                     return has;
                  });
            };
            $scope.openBedrock = function () {
               var b = $scope.state.bedrock;
               checkBundled();
               $scope.state.tab = "bedrock";
               if (!b.inv) $scope.planBedrock();
               if ($scope.state.scan && !b.reference && !b.loading && !b.error) $scope.loadBedrock();
            };

            $scope.planBedrock = function () {
               var s = $scope.state.scan, b = $scope.state.bedrock;
               if (!s) return;
               b.inv = core.bedrockInventory(s.model, b.reference);
               // the removed functions each row calls, from the scan's BLOCKERs
               var removed = {};
               s.findings.forEach(function (f) {
                  if (f.objectType !== "Process" || f.severity !== "BLOCKER" || !f.function) return;
                  var k = f.object.toLowerCase();
                  removed[k] = removed[k] || [];
                  if (removed[k].indexOf(f.function) < 0) removed[k].push(f.function);
               });
               b.inv.rows.forEach(function (r) { r.removedFunctions = removed[r.name.toLowerCase()] || []; });
               b.inv.rows.forEach(function (r) {
                  var allowed = $scope.bedrockActions(r);
                  if (!b.choice[r.name] || allowed.indexOf(b.choice[r.name]) < 0) {
                     var d = core.bedrockDefaultAction(r);
                     b.choice[r.name] = allowed.indexOf(d) >= 0 ? d : "leave";
                  }
               });
               b.inv.missing.forEach(function (m) { if (!b.install.hasOwnProperty(m.name)) b.install[m.name] = true; });
               $scope.planCallers();
            };

            /* What a row may do. Upgrading and installing only on TM1 12, where
             * Bedrock 5 runs (user, 2026-09-29); deleting wherever nothing uses
             * the process. */
            $scope.bedrockActions = function (row) {
               var a = ["leave"];
               if ($scope.isV12() && row.status === "outdated") a.unshift("upgrade");
               if (!row.used) a.push("delete");
               return a;
            };

            /* Every row that allows it gets the same action; "default" puts back
             * the proposal (upgrade what is used, delete what is not). A row
             * that does not allow the action keeps its own. */
            $scope.bedrockSetAll = function (action) {
               var b = $scope.state.bedrock;
               if (!b.inv) return;
               b.inv.rows.forEach(function (r) {
                  var allowed = $scope.bedrockActions(r), a = action === "default" ? core.bedrockDefaultAction(r) : action;
                  if (allowed.indexOf(a) >= 0) b.choice[r.name] = a;
                  else if (action === "default") b.choice[r.name] = "leave";
               });
               $scope.planCallers();
            };

            // keys spelled out, so the key-coverage test sees every one
            var STATUS_KEYS = { current: "SAASMIG_BRS_CURRENT", outdated: "SAASMIG_BRS_OUTDATED", v3: "SAASMIG_BRS_V3",
               unknown: "SAASMIG_BRS_UNKNOWN", notLoaded: "SAASMIG_BRS_NOTLOADED" };
            var ACTION_KEYS = { upgrade: "SAASMIG_BRA_UPGRADE", "delete": "SAASMIG_BRA_DELETE", leave: "SAASMIG_BRA_LEAVE" };
            $scope.statusLabel = function (s) { return t(STATUS_KEYS[s] || s); };

            // ------------------------------------------------ hover explanations and chips

            var TIP_KEYS = { current: "SAASMIG_BRL_CURRENT", outdated: "SAASMIG_BRL_OUTDATED", v3: "SAASMIG_BRL_V3",
               unknown: "SAASMIG_BRL_UNKNOWN", notLoaded: "SAASMIG_BRL_NOTLOADED", missing: "SAASMIG_BRL_MISSING" };
            $scope.statusTip = function (s) { return t(TIP_KEYS[s] || ""); };
            /* The pill on a process that calls a removed function names them, and
             * says whether the upgrade takes them away. */
            $scope.failsLabel = function () { return t($scope.isV12() ? "SAASMIG_BRFAILSV12" : "SAASMIG_BRFAILSV11"); };
            $scope.failsTip = function (r) {
               var fns = (r && r.removedFunctions || []).join(", ");
               return t($scope.isV12() ? "SAASMIG_BRTIP_FAILSV12" : "SAASMIG_BRTIP_FAILSV11", { fns: fns || "?" }) +
                  (r && r.status === "outdated" ? " " + t("SAASMIG_BRTIP_FIXEDBY5") : "");
            };

            /* Severity means something slightly different on each side: on v11 a
             * BLOCKER will not compile after the migration, on TM1 12 it does not. */
            // keys spelled out (not built from the severity) so the key-coverage test sees them
            var SEVERITY_TIPS = {
               BLOCKER: ["SAASMIG_SEVTIP_BLOCKER", "SAASMIG_SEVTIP_BLOCKERV12"], BREAKS: ["SAASMIG_SEVTIP_BREAKS", "SAASMIG_SEVTIP_BREAKSV12"],
               REVIEW: ["SAASMIG_SEVTIP_REVIEW", "SAASMIG_SEVTIP_REVIEW"], INFO: ["SAASMIG_SEVTIP_INFO", "SAASMIG_SEVTIP_INFO"]
            };
            $scope.severityTip = function (sev) {
               var k = SEVERITY_TIPS[sev];
               return k ? t(k[$scope.isV12() ? 1 : 0]) : "";
            };

            /* Findings: one chip per severity present, with its count. A click
             * shows only that severity; a second click shows all again. */
            /* ng-repeat watches the array it is given: a new array of new objects
             * on every digest never settles ($rootScope:infdig, measured live), so
             * each list is rebuilt only when what it shows has changed. */
            var memo = {};
            var same = function (name, key, build) {
               if (!memo[name] || memo[name].key !== key) memo[name] = { key: key, value: build() };
               return memo[name].value;
            };
            $scope.severityChips = function () {
               var s = $scope.state.scan;
               if (!s) return [];
               var by = $scope.summary().bySeverity;
               return same("severity", [by.BLOCKER, by.BREAKS, by.REVIEW, by.INFO].join("|"), function () {
                  return ["BLOCKER", "BREAKS", "REVIEW", "INFO"].filter(function (k) { return by[k]; })
                     .map(function (k) { return { key: k, count: by[k] }; });
               });
            };
            $scope.toggleSeverity = function (k) {
               var f = $scope.state.filters;
               f.severity = f.severity === k ? "" : k;
            };

            /* Bedrock: one chip per status present, plus "fails" and "missing".
             * The same click filters the table. */
            var EMPTY = [];
            var CHIP_ORDER = ["outdated", "fails", "missing", "v3", "unknown", "current", "notLoaded"];
            $scope.bedrockChips = function () {
               var b = $scope.state.bedrock;
               if (!b.inv) return [];
               var n = {};
               b.inv.rows.forEach(function (r) {
                  n[r.status] = (n[r.status] || 0) + 1;
                  if (r.removedFunctions && r.removedFunctions.length) n.fails = (n.fails || 0) + 1;
               });
               if (b.inv.missing.length) n.missing = b.inv.missing.length;
               return same("bedrock", JSON.stringify(n) + $scope.isV12(), function () { return CHIP_ORDER.filter(function (k) { return n[k]; }).map(function (k) {
                  return {
                     key: k, count: n[k],
                     label: k === "fails" ? $scope.failsLabel() : k === "missing" ? t("SAASMIG_BRMISSING") : $scope.statusLabel(k),
                     cls: k === "current" ? "sm-fix" : k === "fails" ? "sm-dep" : (k === "unknown" || k === "notLoaded") ? "sm-manual" : "sm-BREAKS",
                     tip: k === "fails" ? t($scope.isV12() ? "SAASMIG_BRL_FAILSV12" : "SAASMIG_BRL_FAILSV11") : $scope.statusTip(k)
                  };
               }); });
            };
            $scope.toggleBedrockFilter = function (k) {
               var b = $scope.state.bedrock;
               b.filter = b.filter === k ? null : k;
            };
            $scope.bedrockRows = function () {
               var b = $scope.state.bedrock;
               if (!b.inv) return [];
               if (!b.filter) return b.inv.rows;
               if (b.filter === "missing") return EMPTY;
               // a new array of the same row objects is stable for ng-repeat; new objects are not
               return b.inv.rows.filter(function (r) {
                  return b.filter === "fails" ? r.removedFunctions && r.removedFunctions.length : r.status === b.filter;
               });
            };
            $scope.bedrockMissingRows = function () {
               var b = $scope.state.bedrock;
               return b.inv && (!b.filter || b.filter === "missing") ? b.inv.missing : EMPTY;
            };

            /* Overview: each tile explains itself, and a click opens the list
             * behind the number. */
            var TILE_TIPS = {
               dropped: ["SAASMIG_TILETIP_DROPPED", "SAASMIG_TILETIP_DROPPEDV12"], apps: ["SAASMIG_TILETIP_APPS", "SAASMIG_TILETIP_APPS"],
               BLOCKER: ["SAASMIG_SEVTIP_BLOCKER", "SAASMIG_SEVTIP_BLOCKERV12"], BREAKS: ["SAASMIG_SEVTIP_BREAKS", "SAASMIG_SEVTIP_BREAKSV12"],
               REVIEW: ["SAASMIG_SEVTIP_REVIEW", "SAASMIG_SEVTIP_REVIEW"], fixable: ["SAASMIG_TILETIP_FIXABLE", "SAASMIG_TILETIP_FIXABLE"],
               uses: ["SAASMIG_TILETIP_USES", "SAASMIG_TILETIP_USESV12"]
            };
            $scope.tileTip = function (k) { return t(TILE_TIPS[k][$scope.isV12() ? 1 : 0]) + " " + t("SAASMIG_TILETIP_CLICK"); };

            /* The Overview as guided steps (user, 2026-10-05: "overwhelming";
             * "make it more guided steps"; tiles of one size and one keyword with
             * the legend outside). Every state is computed from what the page
             * already holds and nothing is stored (user's choice), so a step whose
             * tab has not been opened since a reload reads "not checked".
             * One unit per tile row: processes, then findings. The old "22 of
             * them" tile was not part of the 19 beside it -- 41 do not compile. */
            var modelCounts = function (s) {
               if (!s.stepCounts) {
                  var br = core.bedrockInventory(s.model, null).rows;
                  s.stepCounts = { tp: core.tpInventory(s.model).items.length, bedrock: br.length,
                     bedrockUnused: br.filter(function (r) { return !r.used; }).length };
               }
               return s.stepCounts;
            };
            $scope.processTiles = function () {
               var s = $scope.state.scan, sum = $scope.summary();
               if (!s || !sum) return null;
               // one object per input, or ng-if on it never settles (infdig, measured)
               return sameAs("processTiles", [s, sum, s.usesRemoved], function () {
                  var callers = {};
                  (s.usesRemoved || []).forEach(function (f) { if (f.objectType === "Process") callers[f.object.toLowerCase()] = true; });
                  var total = s.counts.processes, retire = sum.dropped - sum.droppedOutsideApps;
                  return { total: total, compiles: total - sum.dropped, blocked: sum.droppedOutsideApps, retire: retire,
                     callers: Object.keys(callers).length, ready: total ? Math.round((total - sum.dropped) / total * 100) : 100 };
               });
            };
            // the share of the bar a count takes, for a CSS flex weight
            $scope.share = function (n, total) { return total ? Math.max(0, n) / total * 100 : 0; };
            // the findings to act on (not INFO, not skipped), by the group that deals with them
            var findingGroups = function (s) {
               var g = { apps: 0, bedrock: 0, others: 0 };
               s.findings.forEach(function (f) {
                  if (f.severity === "INFO" || $scope.isSkipped(f)) return;
                  if (f.tm1Applications) g.apps++; else if (f.bedrock) g.bedrock++; else g.others++;
               });
               return g;
            };
            var hhmm = function (d) { var p = function (x) { return (x < 10 ? "0" : "") + x; }; return d ? p(d.getHours()) + ":" + p(d.getMinutes()) : ""; };
            // literal keys, so the strings test sees each one used
            var STEP_KEYS = [null, ["SAASMIG_STEP1", "SAASMIG_STEP1TITLE", "SAASMIG_STEP1HELP"], ["SAASMIG_STEP2", "SAASMIG_STEP2TITLE", "SAASMIG_STEP2HELP"],
               ["SAASMIG_STEP3", "SAASMIG_STEP3TITLE", "SAASMIG_STEP3HELP"], ["SAASMIG_STEP4", "SAASMIG_STEP4TITLE", "SAASMIG_STEP4HELP"], ["SAASMIG_STEP5", "SAASMIG_STEP5TITLE", "SAASMIG_STEP5HELP"]];
            var ITEM_KEYS = { v12: "SAASMIG_ITEMV12", scan: "SAASMIG_ITEMSCAN", compile: "SAASMIG_ITEMCOMPILE", apps: "SAASMIG_ITEMAPPS", bedrock: "SAASMIG_ITEMBEDROCK", findings: "SAASMIG_ITEMFINDINGS",
               cloud: "SAASMIG_ITEMCLOUD", datafiles: "SAASMIG_ITEMDATAFILES", cfg: "SAASMIG_ITEMCFG", save: "SAASMIG_ITEMSAVE", command: "SAASMIG_ITEMCOMMAND", log: "SAASMIG_ITEMLOG", compare: "SAASMIG_ITEMCOMPARE" };
            var ACT_KEYS = { scan: "SAASMIG_ACTSCAN", apps: "SAASMIG_ACTAPPS", bedrock: "SAASMIG_ACTBEDROCK", cloud: "SAASMIG_ACTCLOUD", datafiles: "SAASMIG_ACTDATAFILES" };
            $scope.stepIcon = { done: "fa-check-circle", blocked: "fa-exclamation-circle", current: "fa-dot-circle-o", later: "fa-circle-o", elsewhere: "fa-circle-o" };
            $scope.checkIcon = { done: "fa-check-circle", todo: "fa-circle-o", unknown: "fa-question-circle-o", blocked: "fa-exclamation-circle", optional: "fa-circle-thin" };
            var item = function (key, state, text, action) { return { key: key, state: state, text: text, action: action || null }; };
            var allDone = function (items) { return items.every(function (i) { return i.state === "done" || i.state === "optional"; }); };
            $scope.steps = function () {
               var s = $scope.state.scan, v12 = $scope.isV12(), inst = $scope.state.instance;
               var mine = s && s.instance === inst ? s : null, st = $scope.state, steps = [];
               // 1 Assess
               var assess = [item("scan", mine ? "done" : "todo", mine ? t("SAASMIG_STEPSCANNED", { at: hhmm(mine.at) }) : t("SAASMIG_STEPSCANFIRST"), "scan")];
               // the compile row is the link that opens the check (user, 2026-10-05): its text is the live summary
               if (!v12) assess.push(item("compile", st.v12check && st.v12check.finished ? "done" : "optional", $scope.compileSummary(), "compile"));
               steps.push({ n: 1, key: "assess", items: assess, done: !!mine });
               /* 2 Prepare: the findings first, as a total over their three groups (user,
                * 2026-10-05) -- TM1 Applications and unused Bedrock are deleted, the others
                * fixed -- then CloudID and the data-file plan. The total row is a heading: it
                * is done when its groups are, and is not counted in "N of M done". */
               var prep = [];
               if (mine && !v12) {
                  var c = modelCounts(mine), g = findingGroups(mine);
                  var appsItem = item("apps", c.tp ? "todo" : "done", c.tp ? t("SAASMIG_STEPAPPSG", { n: g.apps, o: c.tp }) : t("SAASMIG_STEPAPPSNONE"), "apps");
                  var brItem = item("bedrock", c.bedrockUnused ? "todo" : "done",
                     c.bedrockUnused ? t("SAASMIG_STEPBEDROCKG", { n: g.bedrock, u: c.bedrockUnused }) : c.bedrock ? t("SAASMIG_STEPBEDROCKUSEDG", { n: g.bedrock, b: c.bedrock }) : t("SAASMIG_STEPBEDROCKNONE"), "bedrock");
                  /* every known object type is a group of its own (user, 2026-10-05: "keep Others for
                   * uncategorised objects"), shown when it has findings; a group is done when nothing in it
                   * can still be fixed here and no BLOCKER in it needs a manual fix */
                  var groups = [appsItem, brItem];
                  core.findingsByType(mine.findings, $scope.isSkipped, function (f) { return !f.tm1Applications && !f.bedrock; }).forEach(function (r) {
                     if (!r.n) return;
                     var gi = item("type:" + r.type, r.fixable || r.manualBlockers ? "todo" : "done",
                        r.fixable ? t("SAASMIG_STEPFIXG", { n: r.n, f: r.fixable }) : r.manualBlockers ? t("SAASMIG_STEPMANUALG", { n: r.n, m: r.manualBlockers }) : t("SAASMIG_STEPFIXNONEG", { n: r.n }),
                        "type:" + r.type);
                     gi.name = $scope.typeLabel(r.type);
                     groups.push(gi);
                  });
                  groups.forEach(function (i) { i.sub = true; });
                  var total = item("findings", groups.every(function (i) { return i.state === "done"; }) ? "done" : "todo",
                     t("SAASMIG_STEPFINDINGSTOTAL", { n: g.apps + g.bedrock + g.others }));
                  total.head = true;
                  prep.push.apply(prep, [total].concat(groups));
                  prep.push(item("cloud", !st.cloud || st.cloud.loading ? "unknown" : st.cloud.exists ? "done" : "todo",
                     !st.cloud || st.cloud.loading ? t("SAASMIG_STEPNOTCHECKED") : st.cloud.exists ? t("SAASMIG_STEPCLOUDSET") : t("SAASMIG_STEPCLOUDNONE"), "cloud"));
                  var dfMine = st.dataFiles && st.dataFiles.instance === inst;
                  prep.push(item("datafiles", dfMine ? "done" : "unknown",
                     dfMine ? t("SAASMIG_STEPPLAN", { n: st.dataFiles.rows.length }) : t("SAASMIG_STEPNOTCHECKED"), "datafiles"));
               }
               steps.push({ n: 2, key: "prepare", items: prep, done: !!mine && !v12 && allDone(prep) });
               // 3 Convert
               var conv = [];
               if (mine && !v12) {
                  var cfg = st.cfg;
                  /* The rows are the controls, as Compile check is in step 1 (user, 2026-10-06): a row with
                   * more to show opens and closes its section under the list (`toggle`), a row with one
                   * thing to do does it from its text (`inline`). The always-open "Run the utility" block
                   * became the three sections, and the links on the right went. */
                  conv.push(item("cfg", !cfg || cfg.error ? "unknown" : cfg.blocked ? "blocked" : "done",
                     !cfg || cfg.error ? t("SAASMIG_STEPNOTCHECKED") : cfg.blocked ? t("SAASMIG_STEPCFGBLOCKED") : t("SAASMIG_STEPCFGOK", { dir: cfg.databaseDirectory })));
                  conv[conv.length - 1].toggle = "cfg";
                  var saved = st.savedData && st.savedData.instance === inst;
                  conv.push(item("save", saved ? "done" : "todo", saved ? t("SAASMIG_STEPSAVED", { at: hhmm(st.savedData.at), s: st.savedData.seconds }) : t("SAASMIG_STEPSAVE"), "save"));
                  conv[conv.length - 1].inline = true;
                  conv.push(item("command", st.cmdCopied === inst ? "done" : "todo", st.cmdCopied === inst ? t("SAASMIG_STEPCOMMANDDONE") : t("SAASMIG_STEPCOMMAND")));
                  conv[conv.length - 1].toggle = "command";
                  conv.push(item("log", st.migrateLog ? "done" : "todo", st.migrateLog ? t("SAASMIG_STEPLOGREAD", { n: st.migrateLog.processes.length }) : t("SAASMIG_STEPLOG")));
                  conv[conv.length - 1].toggle = "log";
               }
               steps.push({ n: 3, key: "convert", items: conv, done: !!st.migrateLog && !v12, blocked: conv.length && conv[0].state === "blocked" });
               /* 4 Create and restore: outside the plugin; it ends with picking the TM1 12 database (user,
                * 2026-10-06). The pick is state.target -- the same TM1 12 database the compile check and the
                * compare use -- probed by its watch, so the row says what it is before anything switches. */
               var rest = [];
               if (!v12) {
                  var tg = st.target, tv = st.targetVersion, ok12 = !!(tg && /^12\./.test(tv || ""));
                  rest.push(item("v12", !tg ? "todo" : ok12 ? "done" : (tv || st.targetProblem) ? "blocked" : "unknown",
                     !tg ? t("SAASMIG_V12PICKHELP") : ok12 ? t("SAASMIG_V12OK", { v: tv })
                        : tv ? t("SAASMIG_V12ISV11", { db: tg, v: tv })
                        : st.targetProblem ? t(st.targetProblem === "signin" ? "SAASMIG_NOTSIGNEDIN" : "SAASMIG_UNREACHABLE", { inst: tg })
                        : t("SAASMIG_V12CHECKING", { db: tg })));
                  rest[0].pick = true;
               }
               steps.push({ n: 4, key: "restore", items: rest, done: v12 || (rest.length > 0 && rest[0].state === "done") });
               // 5 Verify, on the TM1 12 database
               var ver = [];
               if (mine && v12) {
                  var b = st.bedrock && st.bedrock.inv, df = st.dataFiles && st.dataFiles.instance === inst && st.dataFiles.view;
                  var toUpgrade = b ? b.rows.filter(function (r) { return r.used && (r.status === "outdated" || r.status === "v3"); }).length + b.missing.length : 0;
                  ver.push(item("compare", st.compare ? "done" : "todo", st.compare ? t("SAASMIG_STEPCOMPARED", { n: st.compare.processes.length }) : t("SAASMIG_STEPCOMPARE")));
                  ver.push(item("compile", st.v12check && st.v12check.finished ? "done" : "todo", $scope.compileSummary(), "compile"));
                  ver.push(item("bedrock", !b ? "unknown" : toUpgrade ? "todo" : "done",
                     !b ? t("SAASMIG_STEPNOTCHECKED") : toUpgrade ? t("SAASMIG_STEPUPGRADE", { n: toUpgrade }) : t("SAASMIG_STEPUPGRADED"), "bedrock"));
                  // before the tab is opened, the scan's own count says what is left (ON TM1 v12 findings)
                  var onNow = $scope.summary() ? $scope.summary().onTm112 || 0 : 0;
                  ver.push(item("datafiles", !df ? (onNow ? "todo" : "unknown") : df.counts.done < df.counts.all ? "todo" : "done",
                     !df ? (onNow ? t("SAASMIG_STEPTOUPLOAD", { n: onNow }) : t("SAASMIG_STEPNOTCHECKED")) : t("SAASMIG_STEPUPLOADED", { n: df.counts.done, m: df.counts.all }), "datafiles"));
               }
               steps.push({ n: 5, key: "verify", items: ver, done: !!mine && v12 && allDone(ver) });
               // the current step: on v11 the first one not done; on TM1 12, Verify
               var current = v12 ? 5 : (_.find(steps, function (x) { return !x.done && x.n < 4; }) || { n: 4 }).n;
               steps.forEach(function (x) {
                  var k = STEP_KEYS[x.n];
                  x.state = x.done ? "done" : x.blocked ? "blocked" : x.n === current ? "current" : v12 && x.n < 4 ? "elsewhere" : "later";
                  x.count = x.items.length ? x.items.filter(function (i) { return i.state === "done" && !i.head; }).length : null;
                  x.name = t(k[0]); x.title = t(k[1]); x.help = t(k[2]);
                  x.summary = x.state === "elsewhere" ? t("SAASMIG_STEPONV11")
                     : x.n === 1 ? assess[0].text
                     : x.n === 3 && x.blocked ? t("SAASMIG_STEPCFGBLOCKED")
                     : x.n === 4 ? (v12 ? t("SAASMIG_STEP4DONE") : x.done ? t("SAASMIG_STEP4PICKED", { db: st.target }) : t("SAASMIG_STEP4LATER"))
                     : x.n === 5 && !v12 ? t("SAASMIG_STEP5LATER")
                     : !x.items.length ? t("SAASMIG_STEPAFTERSCAN")
                     : t("SAASMIG_STEPCOUNT", { n: x.count, m: x.items.filter(function (i) { return i.state !== "optional" && !i.head; }).length });
                  x.items.forEach(function (i) { i.name = i.name || t(ITEM_KEYS[i.key]); i.act = /^type:/.test(i.action || "") ? t("SAASMIG_ACTTYPE") : ACT_KEYS[i.action] ? t(ACT_KEYS[i.action]) : null; });
               });
               return sameAs("steps", [JSON.stringify(steps)], function () { return steps; });
            };
            // the compile check's one-line summary: the text of its row in the step's checklist
            $scope.compileSummary = function () {
               var c = $scope.state.v12check;
               if (!c) return t($scope.isV12() ? "SAASMIG_V12SUMNOTRUN" : "SAASMIG_V12SUMNOTRUNV11");
               if (!c.finished) return t("SAASMIG_V12SUMRUNNING", { i: c.done, n: c.total });
               return t("SAASMIG_V12SUMDONE", { n: c.failed.length, m: c.total, target: c.target }) + (c.cancelled ? " · " + t("SAASMIG_CANCELLED") : "");
            };
            $scope.openStep = function () {
               var open = $scope.state.stepOpen, list = $scope.steps();
               return open && _.find(list, { n: open }) ? open : (_.find(list, { state: "current" }) || _.find(list, { state: "blocked" }) || list[0]).n;
            };
            // on the Overview a click opens or closes the step; from any other tab it opens it there
            $scope.toggleStep = function (n) {
               if ($scope.state.tab !== "overview") return $scope.openStepPanel(n);
               $scope.state.stepOpen = $scope.openStep() === n ? -1 : n;
            };
            /* Stage 2 (user, 2026-10-05): the tab strip shows the open step's work areas, plus
             * the tab in use (a tile, a checklist row or Arc's tree can open one from another
             * step). "All tabs" shows the rest; Backups, Guide and Log are always on the right. */
            var STEP_TABS = { 1: ["findings"], 2: ["apps", "bedrock", "findings", "cloud", "datafiles"], 3: [], 4: [], 5: ["findings", "bedrock", "datafiles"] };
            var WORK_TABS = ["findings", "apps", "bedrock", "datafiles", "cloud"];
            $scope.tabShown = function (k) {
               return !!$scope.state.allTabs || $scope.state.tab === k || (STEP_TABS[$scope.openStep()] || []).indexOf(k) >= 0;
            };
            $scope.hiddenTabs = function () { return WORK_TABS.filter(function (k) { return !$scope.tabShown(k); }).length; };
            var noteFigures = function () {
               var sum = $scope.summary(), p = $scope.processTiles();
               return sum && p ? { pct: p.ready, blockers: sum.bySeverity.BLOCKER, act: sum.bySeverity.BLOCKER + sum.bySeverity.BREAKS + sum.bySeverity.REVIEW, fixable: sum.fixable } : null;
            };
            var noteChanges = function (a, b) {
               if (!a || !b) return "";
               var out = [];
               if (a.blockers !== b.blockers) out.push(t("SAASMIG_NOTEBLOCKERS", { a: a.blockers, b: b.blockers }));
               if (a.pct !== b.pct) out.push(t("SAASMIG_NOTECOMPILE", { a: a.pct, b: b.pct }));
               if (a.fixable !== b.fixable) out.push(t("SAASMIG_NOTEFIXABLE", { a: a.fixable, b: b.fixable }));
               return out.length ? out.join(", ") + "." : t("SAASMIG_NOTENOCHANGE");
            };
            /* Step 4 -> 5 (user, 2026-10-06): the restored TM1 12 database, picked and checked in step 4's
             * row, becomes the page's database. A project records it as its TM1 12 database (asking before
             * replacing another one) and the v11 database stays the compare target. Once the database
             * answers, it is scanned; with files to upload, the page lands on Data files, else on step 5.
             * The watch on state.instance clears the v11 state and brings back what the project kept. */
            var handoff = null;
            $scope.useV12 = function () {
               var from = $scope.state.instance, to = $scope.state.target;
               if (!to || !/^12\./.test($scope.state.targetVersion || "") || $scope.state.busy || $scope.isV12()) return;
               if (project.canWrite()) {
                  var m = project.current.project;
                  if (m.databases.v12 && m.databases.v12 !== to && !window.confirm(t("SAASMIG_V12REPLACE", { old: m.databases.v12, db: to }))) return;
                  m.databases.v12 = to;
                  if (!m.databases.v11) m.databases.v11 = from;
                  core.projectNote(m, from, { restore: { v12: to, at: new Date().toISOString() } });
                  prjSave();
               }
               log("restore", t("SAASMIG_LOGHANDOFF", { from: from, to: to }));
               handoff = { from: from, to: to };
               $scope.state.instance = to;
               $timeout(function () { $scope.state.target = from; });
               var stop = $scope.$watch(function () {
                  var s = $scope.state.scan;
                  // a scan the project kept refreshes itself (refreshWhenReady); only a page with no scan starts one here
                  return $scope.state.instance === to && $scope.isV12() && !$scope.state.busy && !s;
               }, function (ready) { if (ready) { stop(); $scope.scan(); } });
               $timeout(stop, 120000, false);
            };
            // where the hand-off lands, once its first TM1 12 scan is in
            var landHandoff = function (inst, result) {
               if (!handoff || handoff.to !== inst) return;
               handoff = null;
               // step 5 is where this is: the first-scan rule would have opened step 1
               $scope.state.stepOpen = 5;
               if (core.summarise(result.findings).onTm112) $scope.openDataFiles(); else $scope.openStepPanel(5);
            };
            $scope.scanNext = function () { $scope.state.scanNote = null; $scope.openStepPanel($scope.isV12() ? 5 : 2); };
            $scope.showResult = function () { $scope.state.scanNote = null; $scope.openStepPanel(1); };
            // the line under the picker: what the database is, and who is signed in
            $scope.dbFacts = function () {
               var st = $scope.state;
               return st.productVersion ? t("SAASMIG_DBFACTS", { v: st.productVersion, u: st.user ? st.user.Name : "…" }) : t("SAASMIG_DBCONNECTING", { inst: st.instance || "" });
            };
            // the breakdown by object type, for the step 1 result and the Findings tab's filter
            var TYPE_KEYS = { Process: "SAASMIG_OTPROCESS", Rules: "SAASMIG_OTRULES", Subset: "SAASMIG_OTSUBSET", View: "SAASMIG_OTVIEW",
               Chore: "SAASMIG_OTCHORE", Cube: "SAASMIG_OTCUBE", Dimension: "SAASMIG_OTDIMENSION", Other: "SAASMIG_OTOTHER" };
            $scope.typeLabel = function (k) { return t(TYPE_KEYS[k] || "SAASMIG_OTOTHER"); };
            $scope.byType = function () {
               var s = $scope.state.scan;
               if (!s) return null;
               return sameAs("byType", [s.findings, skips.instance, skips.version], function () {
                  var rows = core.findingsByType(s.findings, $scope.isSkipped);
                  return { shown: rows.filter(function (r) { return r.n; }),
                     none: rows.filter(function (r) { return !r.n && r.type !== "Other"; }).map(function (r) { return $scope.typeLabel(r.type).toLowerCase(); }).join(", ") };
               });
            };
            // a breakdown count opens the list it counts: every group shown, as the tiles do
            $scope.openType = function (k) {
               var f = $scope.state.filters;
               f.severity = "ACT"; f.objectType = k; f.text = ""; f.fixableOnly = false; f.deprecatedOnly = false; f.showApps = true; f.showBedrock = true;
               $scope.state.tab = "findings";
            };
            $scope.openStepPanel = function (n) { $scope.state.tab = "overview"; $scope.state.stepOpen = n; };
            $scope.stepAction = function (a) {
               if (a === "compile") { $scope.state.compileOpen = !$scope.state.compileOpen; return; }
               // SaveDataAll asks first (saveData's own confirm), needs an admin, and waits for anything running
               if (a === "save") {
                  if ($scope.state.busy) return $q.when();
                  if (!$scope.isAdmin()) { Notification.error({ message: t("SAASMIG_SAVEDATANOTADMIN") }); return $q.when(); }
                  return $scope.saveData();
               }
               if (a === "scan") return $scope.scan();
               if (a === "apps") return $scope.openTile("apps");
               if (a === "bedrock") return $scope.openBedrock();
               if (a === "cloud") { $scope.state.tab = "cloud"; if (!$scope.state.cloud && $scope.cloudAllowed()) $scope.loadCloud(); return; }
               if (a === "datafiles") return $scope.openDataFiles();
               var f = $scope.state.filters;
               // a group of step 2: its findings to act on, outside TM1 Applications and Bedrock
               f.severity = /^type:/.test(a) ? "ACT" : ""; f.objectType = /^type:/.test(a) ? a.slice(5) : ""; f.text = ""; f.fixableOnly = false; f.deprecatedOnly = false; f.showApps = false; f.showBedrock = false;
               $scope.state.tab = "findings";
            };
            // step 3's sections, each opened and closed by its row's text; independent, closed at first
            $scope.state.convOpen = {};
            $scope.toggleConv = function (k) { $scope.state.convOpen[k] = !$scope.state.convOpen[k]; };
            /* The command's two folders, typed per database and kept in this browser and in the project.
             * A change makes a copied command stale, so the row is not done until it is copied again. */
            var CMD_DIRS = "tm1Readiness.cmdDirs.";
            $scope.cmdDirs = function () {
               var inst = $scope.state.instance, all = $scope.state.cmdDirsBy || ($scope.state.cmdDirsBy = {});
               if (!all[inst]) all[inst] = readStore(CMD_DIRS + inst, null) || { utility: "", output: "" };
               return all[inst];
            };
            // the project's migration folder, when a picked project knows its path on the v11 host
            $scope.prjOutputDir = function () {
               var c = project.current;
               return c && c.project && c.backend && c.mode === "folder" ? core.projectOutputDir(c.project) : null;
            };
            // a typed output folder wins; empty, the project's migration folder; neither, the old command
            $scope.cmdText = function () {
               var m = $scope.state.migrateCmd, d = $scope.cmdDirs();
               return m ? core.migrateCommandLine(m.cfgDir, m.name, { utility: d.utility, output: d.output || $scope.prjOutputDir() || "" }) : "";
            };
            $scope.prjHostPathSave = function (path) {
               if (!project.canWrite()) return $q.when();
               core.projectSetHostPath(project.current.project, path);
               if ($scope.state.cmdCopied) $scope.state.cmdCopied = null;   // the command changed
               return prjSave().then(function () {
                  if (project.current.project.hostPath) return project.ensureDir(core.PROJECT_OUTPUT_DIR);
               });
            };
            /* migrate.log from the project's migration folder: no file pick. The .tgz is looked for
             * beside it, which settles the one thing the log can never say. */
            $scope.readLogFromProject = function () {
               var m = $scope.state.migrateCmd, file = (m ? m.name : $scope.state.instance) + "-migrate.log";
               $scope.state.logFromProject = null;
               return $q.all([project.read(core.PROJECT_OUTPUT_DIR + "/" + file), project.list(core.PROJECT_OUTPUT_DIR)]).then(function (x) {
                  if (x[0] === null) { $scope.state.logFromProject = { missing: file }; return; }
                  var tgz = (m ? m.name : $scope.state.instance) + ".tgz";
                  var has = (x[1] || []).some(function (n) { return n.toLowerCase() === tgz.toLowerCase(); });
                  $scope.readLog(x[0], file, false, { tgz: has });
               }, function (e) { $scope.state.logFromProject = { error: String(e && e.message || e) }; });
            };
            $scope.cmdDirsChanged = function () {
               var inst = $scope.state.instance, d = $scope.cmdDirs();
               writeStore(CMD_DIRS + inst, d);
               if ($scope.state.cmdCopied === inst) $scope.state.cmdCopied = null;
               prjNote(inst, { cmdDirs: { utility: d.utility, output: d.output }, cmdCopied: null });
            };
            // copied by the button, or by hand from the command itself (ng-copy): either way the row is done
            $scope.cmdCopiedNow = function (byHand) {
               if (!byHand) $scope.copyText($scope.cmdText());
               $scope.state.cmdCopied = $scope.state.instance;
            };
            $scope.stepGuide = function (n) { return "__/plugins/tm1-12-readiness/USER-GUIDE.html#" + ["", "step-1--assess-the-v11-model", "step-2--prepare-the-v11-model", "step-3--convert-with-ibms-utility", "step-4--create-and-restore-the-tm1-12-database", "step-5--verify-on-tm1-12"][n]; };
            $scope.openTile = function (k) {
               if (k === "apps") { $scope.state.tab = "apps"; if (!$scope.state.tp) $scope.loadTp(); return; }
               var f = $scope.state.filters;
               f.severity = ""; f.objectType = ""; f.text = ""; f.fixableOnly = false; f.deprecatedOnly = false;
               // the list must hold what the number counts: TM1 Applications and Bedrock
               // are hidden by default, and every tile but "dropped" counts them
               f.showApps = k !== "dropped"; f.showBedrock = k !== "dropped";
               if (k === "dropped") f.deprecatedOnly = true;
               else if (k === "fixable") f.fixableOnly = true;
               else if (k === "uses") f.text = "dep.usesRemoved";
               else f.severity = k;
               $scope.state.tab = "findings";
            };
            $scope.actionLabel = function (a) { return t(ACTION_KEYS[a] || a); };

            $scope.planCallers = function () {
               var s = $scope.state.scan, b = $scope.state.bedrock;
               if (!s || !b.inv) return;
               var upgrading = {};
               if ($scope.isV12()) {
                  b.inv.rows.forEach(function (r) { if (b.choice[r.name] === "upgrade") upgrading[r.name.toLowerCase()] = true; });
                  b.inv.missing.forEach(function (m) { if (b.install[m.name]) upgrading[m.name.toLowerCase()] = true; });
               }
               b.callers = core.bedrockCallerPlan(s.model, b.reference, upgrading);
               b.callers.processes.forEach(function (p) {
                  p.hunks = core.PROCEDURES.filter(function (k) { return p.fix.procedures[k] !== (p.before[k] || ""); }).map(function (k) {
                     return { procedure: core.PROCEDURE_LABEL[k], rows: core.diffHunks(p.before[k], p.fix.procedures[k], 1) };
                  });
               });
            };

            $scope.bedrockCounts = function () {
               var b = $scope.state.bedrock, c = { upgrade: 0, delete: 0, install: 0, callers: 0, chores: 0 };
               if (!b.inv) return c;
               b.inv.rows.forEach(function (r) { if (b.choice[r.name] === "upgrade" || b.choice[r.name] === "delete") c[b.choice[r.name]]++; });
               if ($scope.isV12()) {
                  b.inv.missing.forEach(function (m) { if (b.install[m.name]) c.install++; });
                  if (b.fixCallers && b.callers) { c.callers = b.callers.processes.length; c.chores = b.callers.chores.length; }
               }
               return c;
            };
            $scope.bedrockWork = function () {
               var c = $scope.bedrockCounts();
               return c.upgrade + c.delete + c.install + c.callers + c.chores;
            };

            /* Makes one process the Bedrock 5 one, by PATCH (upgrade) or POST
             * (install): a dry-run compile of the Bedrock 5 body first, then the
             * write, a re-read that must match the Bedrock 5 code, and a compile
             * of what was saved. Any failure after the write puts the original
             * back (or deletes what was installed). */
            var writeBedrock = function (inst, ref, original) {
               var enc = core.path([["Processes", ref.Name]]), written = false;
               return call(inst, "POST", "/CompileProcess", core.compileBody(ref)).then(function (r) {
                  must(r);
                  var errs = r.data.value || [];
                  if (errs.length) throw new Error(t("SAASMIG_DRYRUN") + ": " + errs.map(function (e) { return e.Procedure + " " + e.LineNumber + " " + core.compileMessage(e.Message); }).join("; "));
                  return original ? call(inst, "PATCH", enc, core.bedrockBody(ref)) : call(inst, "POST", "/Processes", core.bedrockBody(ref, true));
               }).then(function (r) {
                  must(r); written = true;
                  return call(inst, "GET", enc);
               }).then(function (r) {
                  must(r);
                  if (!core.sameProcessCode(r.data, ref)) throw new Error(t("SAASMIG_REREADMISMATCH") + " " + ref.Name);
                  return call(inst, "POST", enc + "/tm1.Compile", {});
               }).then(function (r) {
                  must(r);
                  var errs = r.data.value || [];
                  if (errs.length) throw new Error(t("SAASMIG_COMPILE") + ": " + errs.map(function (e) { return e.Procedure + " " + e.LineNumber + " " + core.compileMessage(e.Message); }).join("; "));
               }).catch(function (e) {
                  if (!written) throw e;
                  var undo = original ? call(inst, "PATCH", enc, core.processBody(original)) : call(inst, "DELETE", enc);
                  return undo.then(function (r) {
                     throw new Error(e.message + " -- " + (ok(r) ? t("SAASMIG_ROLLEDBACK") : t("SAASMIG_ROLLBACKFAILED") + " " + errorText(r)));
                  });
               });
            };

            /* A chore's tasks, one PATCH each for the tasks that change. */
            var writeChoreTasks = function (inst, choreName, tasks) {
               var chain = $q.when();
               tasks.forEach(function (task) {
                  if (!task.changed) return;
                  chain = chain.then(function () {
                     return call(inst, "PATCH", core.path([["Chores", choreName]]) + "/Tasks(" + task.step + ")", { Parameters: task.Parameters }).then(must);
                  });
               });
               return chain;
            };

            /* One run: backup, then upgrades and installs, then the callers of
             * the processes that made it, then deletions. A failure stops only
             * its own object; its callers are left alone. */
            $scope.applyBedrock = function () {
               var inst = $scope.state.instance, b = $scope.state.bedrock, v12 = $scope.isV12();
               b.confirm = false;
               var rows = b.inv.rows, ref = b.reference;
               var ups = v12 && ref ? rows.filter(function (r) { return b.choice[r.name] === "upgrade"; }) : [];
               var ins = v12 && ref ? b.inv.missing.filter(function (m) { return b.install[m.name]; }) : [];
               var dels = rows.filter(function (r) { return b.choice[r.name] === "delete"; });
               var callers = v12 && b.fixCallers && b.callers ? b.callers.processes : [];
               var chores = v12 && b.fixCallers && b.callers ? b.callers.chores : [];
               var results = [], failed = {};
               $scope.state.cancel = false;
               var full = null;
               return readFullProcesses(inst).then(function (procs) {
                  full = procs;
                  var entries = [];
                  ups.concat(dels).forEach(function (r) { entries.push({ type: "ProcessFull", name: r.name, before: full[r.name.toLowerCase()] }); });
                  callers.forEach(function (c) { entries.push({ type: "ProcessFull", name: c.name, before: full[c.name.toLowerCase()] }); });
                  ins.forEach(function (m) { entries.push({ type: "Created", objectType: "Process", name: m.name }); });
                  chores.forEach(function (c) { entries.push({ type: "ChoreTasks", name: c.name, before: { Tasks: (c.before.Tasks || []).map(function (t, k) { return { step: t.Step !== undefined ? t.Step : k, process: t.Process && t.Process.Name, Parameters: t.Parameters || [] }; }) } }); });
                  if (entries.some(function (e) { return e.type === "ProcessFull" && !e.before; })) throw new Error(t("SAASMIG_BACKUPREADFAILED", { name: "" }));
                  var chain = saveBackup(inst, entries), total = ups.length + ins.length + callers.length + chores.length + dels.length, i = 0;
                  var stepDo = function (label, name, fn, key) {
                     chain = chain.then(function () {
                        if ($scope.state.cancel) { results.push({ action: label, name: name, outcome: "skipped" }); return; }
                        i++;
                        $scope.state.busy = t("SAASMIG_BEDROCKDOING", { action: label, name: name, i: i, n: total });
                        return $q.when(fn()).then(function (outcome) {
                           outcome = typeof outcome === "string" ? outcome : "done";
                           results.push({ action: label, name: name, outcome: outcome });
                           log("bedrock", label + " " + name + ": " + outcome);
                        }, function (e) {
                           if (key) failed[key] = true;
                           results.push({ action: label, name: name, outcome: "error", message: e.message });
                           log("error", label + " " + name + ": " + e.message);
                        });
                     });
                  };
                  ups.forEach(function (r) {
                     stepDo("upgrade", r.name, function () { return writeBedrock(inst, ref.byName[r.name.toLowerCase()], full[r.name.toLowerCase()]); }, r.name.toLowerCase());
                  });
                  ins.forEach(function (m) {
                     stepDo("install", m.name, function () { return writeBedrock(inst, ref.byName[m.name.toLowerCase()], null); }, m.name.toLowerCase());
                  });
                  callers.forEach(function (c) {
                     stepDo("callers", c.name, function () {
                        var bad = c.fix.edits.filter(function (e) { return failed[e.callee.toLowerCase()]; });
                        if (bad.length) throw new Error(t("SAASMIG_CALLEEFAILED", { name: bad[0].callee }));
                        return applyProcess(inst, { before: c.before, fix: c.fix, name: c.name });
                     });
                  });
                  chores.forEach(function (c) {
                     stepDo("callers", c.name, function () {
                        var bad = c.fix.edits.filter(function (e) { return failed[e.callee.toLowerCase()]; });
                        if (bad.length) throw new Error(t("SAASMIG_CALLEEFAILED", { name: bad[0].callee }));
                        return writeChoreTasks(inst, c.name, c.fix.tasks);
                     });
                  });
                  dels.forEach(function (r) {
                     stepDo("delete", r.name, function () { return deleteObject(inst, { type: "Process", name: r.name }); });
                  });
                  return chain;
               }).then(function () {
                  var nFailed = results.filter(function (r) { return r.outcome === "error"; }).length;
                  b.result = { at: new Date(), results: results, failed: nFailed };
                  if (nFailed) Notification.error({ message: t("SAASMIG_BEDROCKDONE", { n: results.length - nFailed, f: nFailed }) });
                  else Notification.success({ message: t("SAASMIG_BEDROCKDONE", { n: results.length - nFailed, f: nFailed }) });
               }).catch(function (e) {
                  Notification.error({ message: e.message });
                  b.result = { at: new Date(), results: results, failed: 0, error: e.message };
               }).finally(function () {
                  $scope.state.busy = null;
                  $scope.scan();
               });
            };

            // ------------------------------------------------------------- exports

            $scope.exportCsv = function () {
               var s = $scope.state.scan;
               if (s) exportFile("tm1-12-readiness-findings-" + s.instance + ".csv", core.findingsCsv(s.findings, $scope.isSkipped), "text/csv");
            };

            // --------------------------------------------------------------- CloudID

            /* CloudID is prepared on the v11 model only: TM1 v12 has no
             * }ClientProperties (§2.4), and the migration is what reads the
             * element (user, 2026-09-29). Nothing here reads or writes until the
             * version probe has said the database is v11. */
            $scope.cloudAllowed = function () { return !!$scope.state.productVersion && !$scope.isV12(); };
            var cloudRefused = function () {
               if ($scope.cloudAllowed()) return false;
               Notification.error({ message: t("SAASMIG_CLOUDV12") });
               return true;
            };
            // the tab was opened before the version probe answered
            $scope.$watch("state.productVersion", function () {
               if ($scope.state.tab === "cloud" && !$scope.state.cloud && $scope.cloudAllowed()) $scope.loadCloud();
            });

            $scope.loadCloud = function () {
               if (!$scope.cloudAllowed()) return $q.when();
               var inst = $scope.state.instance;
               var cloud = { loading: true, exists: false, clients: [], edits: {}, loadedValues: {}, import: null };
               $scope.state.cloud = cloud;
               var users = {};
               return call(inst, "GET", CP_ELEMENTS + "('CloudID')?$select=Name").then(function (r) {
                  cloud.exists = ok(r);
                  if (!ok(r) && r.status !== 404) throw new Error(errorText(r));
                  return call(inst, "GET", "/Users?$select=Name,FriendlyName&$expand=Groups($select=Name)");
               }).then(function (r) {
                  must(r);
                  r.data.value.forEach(function (u) { users[u.Name] = { name: u.Name, displayName: u.FriendlyName || "", groups: (u.Groups || []).map(function (g) { return g.Name; }), cloudId: "" }; });
                  if (!cloud.exists) return;
                  var mdx = "SELECT {[}ClientProperties].[}ClientProperties].[CloudID]} ON 0, {[}Clients].[}Clients].MEMBERS} ON 1 FROM [}ClientProperties]";
                  return call(inst, "POST", "/ExecuteMDX?$expand=Axes($expand=Tuples($expand=Members($select=Name))),Cells($select=Value)", { MDX: mdx }).then(function (x) {
                     must(x);
                     x.data.Axes[1].Tuples.forEach(function (tuple, i) {
                        var c = users[tuple.Members[0].Name];
                        if (c) c.cloudId = x.data.Cells[i].Value || "";
                     });
                     if (x.data.ID) call(inst, "DELETE", "/Cellsets('" + x.data.ID + "')");
                  });
               }).then(function () {
                  cloud.clients = _.sortBy(_.values(users), function (c) { return c.name.toLowerCase(); });
                  cloud.clients.forEach(function (c) { cloud.loadedValues[c.name] = c.cloudId || ""; });
                  cloud.validation = core.validateCloudIds(cloud.clients);
               }).catch(function (e) { cloud.error = e.message; })
                  .finally(function () { cloud.loading = false; });
            };

            $scope.createCloudId = function () {
               if (cloudRefused()) return $q.when();
               var inst = $scope.state.instance, cloud = $scope.state.cloud;
               cloud.confirmCreate = false;
               return call(inst, "POST", CP_ELEMENTS, { Name: "CloudID", Type: "String" }).then(function (r) {
                  must(r);
                  log("cloud", t("SAASMIG_LOGCLOUDCREATED"));
                  return $scope.loadCloud();
               }).catch(function (e) { cloud.error = e.message; });
            };

            $scope.cloudChanged = function (c) {
               var cloud = $scope.state.cloud;
               cloud.edits[c.name] = (c.cloudId || "").trim() !== (cloud.loadedValues[c.name] || "");
               if (!cloud.edits[c.name]) delete cloud.edits[c.name];
               cloud.validation = core.validateCloudIds(cloud.clients);
            };
            $scope.cloudDirty = function () { return $scope.state.cloud ? Object.keys($scope.state.cloud.edits).length : 0; };

            /* CloudID values, one cell each, after backing up the old values
             * (the Backups tab restores them). */
            var writeCloud = function (changes) {
               var inst = $scope.state.instance;
               if (!changes.length || cloudRefused()) return $q.when();
               var chain = saveBackup(inst, changes.map(function (ch) { return { type: "CloudID", name: ch.client, before: { CloudID: ch.from } }; }), true), done = 0;
               changes.forEach(function (ch) {
                  chain = chain.then(function () {
                     $scope.state.busy = t("SAASMIG_WRITINGCLOUD", { i: done + 1, n: changes.length });
                     return call(inst, "POST", "/Cubes('%7DClientProperties')/tm1.Update", core.cloudIdCell(ch.client, ch.to)).then(function (r) { must(r); done++; });
                  });
               });
               return chain.then(function () {
                  log("cloud", t("SAASMIG_LOGCLOUDWRITE", { n: done }));
                  Notification.success({ message: t("SAASMIG_LOGCLOUDWRITE", { n: done }) });
               }).catch(function (e) {
                  Notification.error({ message: e.message });
               }).finally(function () { $scope.state.busy = null; return $scope.loadCloud(); });
            };

            $scope.saveCloudEdits = function () {
               var cloud = $scope.state.cloud;
               var changes = cloud.clients.filter(function (c) { return cloud.edits[c.name]; }).map(function (c) {
                  return { client: c.name, from: cloud.loadedValues[c.name] || "", to: (c.cloudId || "").trim() };
               });
               return writeCloud(changes);
            };

            $scope.exportCloud = function () {
               exportFile("cloudid-" + $scope.state.instance + ".csv", core.cloudIdCsv($scope.state.cloud.clients), "text/csv");
            };

            $scope.importCloud = function (text, name) {
               if (cloudRefused()) return;
               var cloud = $scope.state.cloud;
               var current = cloud.clients.map(function (c) { return { name: c.name, cloudId: cloud.loadedValues[c.name] || "" }; });
               cloud.import = core.cloudIdImport(text, current);
               cloud.import.fileName = name;
            };
            $scope.applyCloudImport = function () {
               var cloud = $scope.state.cloud, imp = cloud.import;
               cloud.import = null;
               if (!imp || !imp.validation.ok) return $q.when();
               return writeCloud(imp.changes.map(function (c) { return { client: c.client, from: c.from, to: c.to }; }));
            };

            // ------------------------------------------------------- group CloudID

            /* The utility reads a CloudID for groups from }GroupProperties, which
             * TM1 does not have (its README): a dimension with a CloudID element,
             * and a cube }Groups x }GroupProperties. The plugin creates what is
             * missing, after a confirm, and records what it created so the
             * Backups tab can take it away again. */
            var GP_DIM = "/Dimensions('%7DGroupProperties')", GP_CUBE = "/Cubes('%7DGroupProperties')";
            $scope.loadGroupCloud = function () {
               if (!$scope.cloudAllowed()) return $q.when();
               var inst = $scope.state.instance, groups = {};
               var g = { loading: true, dim: false, element: false, cube: false, groups: [], edits: {}, loadedValues: {}, import: null };
               $scope.state.groupCloud = g;
               return call(inst, "GET", GP_DIM + "?$select=Name").then(function (r) {
                  if (!ok(r) && r.status !== 404) throw new Error(errorText(r));
                  g.dim = ok(r);
                  if (!g.dim) return;
                  return call(inst, "GET", GP_DIM + "/Hierarchies('%7DGroupProperties')/Elements('CloudID')?$select=Name").then(function (e) { g.element = ok(e); });
               }).then(function () {
                  return call(inst, "GET", GP_CUBE + "?$select=Name").then(function (r) { g.cube = ok(r); });
               }).then(function () {
                  return call(inst, "GET", "/Groups?$select=Name");
               }).then(function (r) {
                  must(r);
                  r.data.value.forEach(function (x) { groups[x.Name] = { name: x.Name, cloudId: "", always: core.isAlwaysGroup(x.Name) }; });
                  if (!$scope.groupCloudReady()) return;
                  var mdx = "SELECT {[}GroupProperties].[}GroupProperties].[CloudID]} ON 0, {[}Groups].[}Groups].MEMBERS} ON 1 FROM [}GroupProperties]";
                  return call(inst, "POST", "/ExecuteMDX?$expand=Axes($expand=Tuples($expand=Members($select=Name))),Cells($select=Value)", { MDX: mdx }).then(function (x) {
                     must(x);
                     x.data.Axes[1].Tuples.forEach(function (tuple, i) {
                        var gr = groups[tuple.Members[0].Name];
                        if (gr) gr.cloudId = x.data.Cells[i].Value || "";
                     });
                     if (x.data.ID) call(inst, "DELETE", "/Cellsets('" + x.data.ID + "')");
                  });
               }).then(function () {
                  g.groups = _.sortBy(_.values(groups), function (x) { return x.name.toLowerCase(); });
                  g.groups.forEach(function (x) { g.loadedValues[x.name] = x.cloudId || ""; });
                  g.validation = core.validateCloudIds(g.groups, "group");
               }).catch(function (e) { g.error = e.message; })
                  .finally(function () { g.loading = false; });
            };
            $scope.groupCloudReady = function () {
               var g = $scope.state.groupCloud;
               return !!g && g.dim && g.element && g.cube;
            };

            $scope.createGroupCloud = function () {
               if (cloudRefused()) return $q.when();
               var inst = $scope.state.instance, g = $scope.state.groupCloud, created = [];
               g.confirmCreate = false;
               var chain = $q.when();
               if (!g.dim) {
                  chain = chain.then(function () {
                     return call(inst, "POST", "/Dimensions", { Name: "}GroupProperties", Hierarchies: [{ Name: "}GroupProperties", Elements: [{ Name: "CloudID", Type: "String" }] }] })
                        .then(must).then(function () { created.push({ type: "Created", objectType: "Dimension", name: "}GroupProperties" }); });
                  });
               } else if (!g.element) {
                  chain = chain.then(function () {
                     return call(inst, "POST", GP_DIM + "/Hierarchies('%7DGroupProperties')/Elements", { Name: "CloudID", Type: "String" }).then(must);
                  });
               }
               if (!g.cube) {
                  chain = chain.then(function () {
                     return call(inst, "POST", "/Cubes", { Name: "}GroupProperties", "Dimensions@odata.bind": ["Dimensions('}Groups')", "Dimensions('}GroupProperties')"] })
                        // the cube goes first in the backup: a restore deletes it before its dimension
                        .then(must).then(function () { created.unshift({ type: "Created", objectType: "Cube", name: "}GroupProperties" }); });
                  });
               }
               return chain.then(function () {
                  log("cloud", t("SAASMIG_LOGGCLOUDCREATED"));
               }).catch(function (e) { g.error = e.message; }).finally(function () {
                  if (created.length) saveBackup(inst, created, true);
                  return $scope.loadGroupCloud();
               });
            };

            $scope.groupCloudChanged = function (x) {
               var g = $scope.state.groupCloud;
               g.edits[x.name] = (x.cloudId || "").trim() !== (g.loadedValues[x.name] || "");
               if (!g.edits[x.name]) delete g.edits[x.name];
               g.validation = core.validateCloudIds(g.groups, "group");
            };
            $scope.groupCloudDirty = function () { return $scope.state.groupCloud ? Object.keys($scope.state.groupCloud.edits).length : 0; };

            /* Every changed value in one tm1.Update (an array body writes them
             * all, §2.6), after backing up the old values. */
            var writeGroupCloud = function (changes) {
               var inst = $scope.state.instance;
               if (!changes.length || cloudRefused()) return $q.when();
               return saveBackup(inst, changes.map(function (ch) { return { type: "GroupCloudID", name: ch.group, before: { CloudID: ch.from } }; }), true).then(function () {
                  $scope.state.busy = t("SAASMIG_WRITINGCLOUD", { i: changes.length, n: changes.length });
                  return call(inst, "POST", GP_CUBE + "/tm1.Update", changes.map(function (ch) { return core.groupCloudIdCell(ch.group, ch.to); }));
               }).then(function (r) {
                  must(r);
                  log("cloud", t("SAASMIG_LOGGCLOUDWRITE", { n: changes.length }));
                  Notification.success({ message: t("SAASMIG_LOGGCLOUDWRITE", { n: changes.length }) });
               }).catch(function (e) {
                  Notification.error({ message: e.message });
               }).finally(function () { $scope.state.busy = null; return $scope.loadGroupCloud(); });
            };

            $scope.saveGroupCloudEdits = function () {
               var g = $scope.state.groupCloud;
               return writeGroupCloud(g.groups.filter(function (x) { return g.edits[x.name]; }).map(function (x) {
                  return { group: x.name, from: g.loadedValues[x.name] || "", to: (x.cloudId || "").trim() };
               }));
            };
            $scope.exportGroupCloud = function () {
               exportFile("group-cloudid-" + $scope.state.instance + ".csv", core.groupCloudIdCsv($scope.state.groupCloud.groups), "text/csv");
            };
            $scope.importGroupCloud = function (text, name) {
               if (cloudRefused()) return;
               var g = $scope.state.groupCloud;
               var current = g.groups.map(function (x) { return { name: x.name, cloudId: g.loadedValues[x.name] || "" }; });
               g.import = core.cloudIdImport(text, current, "group");
               g.import.fileName = name;
            };
            $scope.applyGroupCloudImport = function () {
               var g = $scope.state.groupCloud, imp = g.import;
               g.import = null;
               if (!imp || !imp.validation.ok) return $q.when();
               return writeGroupCloud(imp.changes.map(function (c) { return { group: c.client, from: c.from, to: c.to }; }));
            };

            // --------------------------------------------------------------- backups

            $scope.readBackup = function (text, name) {
               var r = core.readBackup(text);
               $scope.state.restore = r.error ? { error: r.error, fileName: name } : { backup: r.backup, fileName: name };
            };
            /* A row of the Backups tab: one kept in the project is read from its
             * folder first. */
            $scope.restoreRow = function (b) {
               if (b.backup) return $scope.restoreFrom(b.backup);
               return project.read("backups/" + b.name).then(function (text) {
                  var r = core.readBackup(text || "");
                  if (r.error) { Notification.error({ message: b.name + ": " + (text === null ? t("SAASMIG_PRJBACKUPGONE") : r.error) }); return; }
                  b.backup = r.backup;
                  return $scope.restoreFrom(b.backup);
               });
            };
            $scope.restoreFrom = function (backup) {
               var inst = $scope.state.instance;
               if (backup.instance !== inst) {
                  Notification.error({ message: t("SAASMIG_RESTOREWRONGINSTANCE", { file: backup.instance, now: inst }) });
                  return $q.when();
               }
               var chain = $q.when(), done = 0, skipped = [];
               restoreOrder(backup.entries).forEach(function (e) {
                  chain = chain.then(function () {
                     $scope.state.busy = t("SAASMIG_RESTORING", { name: e.name });
                     if (e.type === "FileReplaced") {
                        // the old bytes back, read back by size; the folder is never touched
                        return call(inst, "PUT", core.filesPath(e.parts) + "/Content", new Blob([fromBase64(e.base64)])).then(must).then(function () {
                           return call(inst, "GET", core.filesPath(e.parts) + "?$select=Name,Size");
                        }).then(function (r) {
                           must(r);
                           if (r.data.Size !== e.size) throw new Error(t("SAASMIG_DFSIZEMISMATCH", { name: e.name, want: e.size, got: r.data.Size }));
                           done++;
                        });
                     }
                     if (e.type === "Deleted" || e.type === "ProcessFull" || e.type === "Created" || e.type === "ChoreTasks" || e.type === "FileUploaded") {
                        return restoreObject(inst, e).then(function (note) {
                           if (note) { skipped.push(e.name + ": " + note); log("restore", e.name + ": " + note); } else done++;
                        });
                     }
                     if (e.type === "Process") {
                        var body = {};
                        core.PROCEDURES.forEach(function (k) { body[k] = e.before[k] || ""; });
                        var path = core.path([["Processes", e.name]]);
                        return call(inst, "PATCH", path, body).then(must).then(function () {
                           return call(inst, "GET", path + "?$select=PrologProcedure,MetadataProcedure,DataProcedure,EpilogProcedure");
                        }).then(function (r) {
                           must(r);
                           core.PROCEDURES.forEach(function (k) { if ((r.data[k] || "") !== body[k]) throw new Error(t("SAASMIG_REREADMISMATCH") + " " + e.name); });
                           var p = $scope.state.scan && $scope.state.scan.processByName[e.name];
                           if (p) core.PROCEDURES.forEach(function (k) { p[k] = body[k]; });
                           done++;
                        });
                     }
                     if (e.type === "Subset") {
                        var sp = core.path([["Dimensions", e.subset.dimension], ["Hierarchies", e.subset.hierarchy], ["Subsets", e.subset.name]]);
                        return call(inst, "PATCH", sp, { Expression: e.before.Expression }).then(must).then(function () {
                           if ($scope.state.scan) updateSubsetModel(e.subset, e.before.Expression);
                           done++;
                        });
                     }
                     if (e.type === "View") {
                        return call(inst, "PATCH", viewPath(e.view), { "@odata.type": "ibm.tm1.api.v1.MDXView", MDX: e.before.MDX }).then(must).then(function () {
                           if ($scope.state.scan) updateViewModel(e.view, e.before.MDX);
                           done++;
                        });
                     }
                     if (e.type === "CloudID") {
                        return call(inst, "POST", "/Cubes('%7DClientProperties')/tm1.Update", core.cloudIdCell(e.name, e.before.CloudID)).then(must).then(function () { done++; });
                     }
                     if (e.type === "ElementSecurity") {
                        return writeCells(inst, e.name, [e.dimension, "}Groups"], e.cells).then(function () { return refreshSecurity(inst); }).then(function () { done++; });
                     }
                     if (e.type === "GroupCloudID") {
                        return call(inst, "POST", "/Cubes('%7DGroupProperties')/tm1.Update", core.groupCloudIdCell(e.name, e.before.CloudID)).then(must).then(function () { done++; });
                     }
                  });
               });
               var whole = backup.entries.some(function (e) { return e.type === "Deleted" || e.type === "ProcessFull" || e.type === "Created"; });
               return chain.then(function () {
                  log("restore", t("SAASMIG_LOGRESTORED", { n: done }));
                  Notification.success({ message: t("SAASMIG_LOGRESTORED", { n: done }) + (skipped.length ? " " + t("SAASMIG_RESTORESKIPPED", { n: skipped.length }) : "") });
                  return { done: done, skipped: skipped };
               }).catch(function (e) {
                  Notification.error({ message: e.message });
                  return { done: done, error: e.message, skipped: skipped };
               }).finally(function () {
                  $scope.state.busy = null; $scope.state.restore = null;
                  /* loadTp keeps the last delete's result line across the rescan
                   * that follows a delete; after a restore it was still saying
                   * "155 deleted" over the restored objects (manual test). */
                  if (whole && $scope.state.tp) $scope.state.tp.result = null;
                  // objects came back or went: the scan's copy of the model is stale
                  if (whole && $scope.state.scan) $scope.scan(); else $scope.rescanQuiet();
               });
            };

            /* Deleted objects come back parents first: dimensions, cubes, then
             * what lives in them, then processes and the chores that run them.
             * A delete is undone in the opposite order to the one it ran in. */
            var RESTORE_RANK = { Dimension: 0, Cube: 1, Subset: 2, View: 3, Process: 4, Chore: 5 };
            var restoreOrder = function (entries) {
               return entries.map(function (e, i) { return { e: e, i: i }; }).sort(function (a, b) {
                  var ra = a.e.type === "Deleted" ? RESTORE_RANK[a.e.objectType] : -1, rb = b.e.type === "Deleted" ? RESTORE_RANK[b.e.objectType] : -1;
                  return (ra - rb) || (a.i - b.i);
               }).map(function (x) { return x.e; });
            };

            var writeCells = function (inst, cube, dims, rows) {
               if (!rows || !rows.length) return $q.when();
               return call(inst, "POST", core.path([["Cubes", cube]]) + "/tm1.Update", core.cellUpdates(dims, rows)).then(must);
            };

            /* One whole object back. Returns a note when it was not restored
             * (it exists already, or it is a control object TM1 recreates with
             * its parent, or a native view), or nothing when it was. */
            var restoreObject = function (inst, e) {
               var p;
               // the document only: a folder DELETE is recursive on 12.6.4 (plan §2.13)
               if (e.type === "FileUploaded") {
                  return call(inst, "DELETE", core.filesPath(e.parts)).then(function (r) {
                     if (r.status === 404) return t("SAASMIG_RESTOREGONE");
                     must(r);
                  });
               }
               if (e.type === "Created") {
                  return call(inst, "DELETE", core.objectPath({ type: e.objectType, name: e.name })).then(function (r) {
                     if (r.status === 404) return t("SAASMIG_RESTOREGONE");
                     must(r);
                  });
               }
               if (e.type === "ProcessFull") {
                  p = core.path([["Processes", e.name]]);
                  return call(inst, "GET", p + "?$select=Name").then(function (r) {
                     if (ok(r)) return call(inst, "PATCH", p, core.processBody(e.before));
                     return call(inst, "POST", "/Processes", core.processBody(e.before, true));
                  }).then(must).then(function () { });
               }
               if (e.type === "ChoreTasks") {
                  return writeChoreTasks(inst, e.name, (e.before.Tasks || []).map(function (x) { return { step: x.step, Parameters: x.Parameters, changed: true }; }))
                     .then(function () { });   // resolves to nothing: a value here would read as a "not restored" note
               }
               // Deleted
               var item = { type: e.objectType, name: e.name, parent: e.parent, hierarchy: e.hierarchy };
               if (e.control) return $q.when(t("SAASMIG_RESTORECONTROL"));
               if (e.objectType === "View" && !/MDXView/.test(e.definition["@odata.type"] || "")) return $q.when(t("SAASMIG_RESTORENATIVEVIEW"));
               var def = e.definition;
               return call(inst, "GET", core.objectPath(item) + (e.objectType === "Process" || e.objectType === "Chore" ? "?$select=Name" : "")).then(function (r) {
                  if (ok(r)) return t("SAASMIG_RESTOREEXISTS");
                  var step;
                  switch (e.objectType) {
                     case "Dimension":
                        /* An attribute on a hierarchy with no elements is refused,
                         * "Cannot create element attribute for an empty dimension"
                         * (400; manual test, }tp_applications: 0 elements, 18
                         * attributes), and stopped the whole restore. Such an
                         * attribute can hold no value, so it is left out and noted. */
                        var noAttributes = 0;
                        step = call(inst, "POST", "/Dimensions", core.dimensionCreateBody(def)).then(must).then(function () {
                           var chain = $q.when();
                           (def.Hierarchies || []).forEach(function (h) {
                              if (/^leaves$/i.test(h.Name)) return;
                              var hp = core.path([["Dimensions", def.Name], ["Hierarchies", h.Name]]);
                              var empty = !(h.Elements || []).length;
                              (h.ElementAttributes || []).forEach(function (a) {
                                 if (empty) { noAttributes++; return; }
                                 chain = chain.then(function () { return call(inst, "POST", hp + "/ElementAttributes", { Name: a.Name, Type: a.Type }).then(must); });
                              });
                              (h.Subsets || []).forEach(function (s) {
                                 chain = chain.then(function () { return call(inst, "POST", hp + "/Subsets", core.subsetCreateBody(s)).then(must); });
                              });
                           });
                           return chain.then(function () {
                              var ac = "}ElementAttributes_" + def.Name;
                              return writeCells(inst, ac, [def.Name, ac], e.attributeCells);
                           });
                        });
                        break;
                     case "Cube":
                        step = call(inst, "POST", "/Cubes", core.cubeCreateBody(def)).then(must).then(function () {
                           return writeCells(inst, def.Name, (def.Dimensions || []).map(function (d) { return d.Name; }), e.cells);
                        });
                        break;
                     case "Subset":
                        step = call(inst, "POST", core.path([["Dimensions", e.parent], ["Hierarchies", e.hierarchy || e.parent]]) + "/Subsets", core.subsetCreateBody(def)).then(must);
                        break;
                     case "View":
                        step = call(inst, "POST", core.path([["Cubes", e.parent]]) + "/Views", { "@odata.type": "ibm.tm1.api.v1.MDXView", Name: def.Name, MDX: def.MDX }).then(must);
                        break;
                     case "Process":
                        step = call(inst, "POST", "/Processes", core.processBody(def, true)).then(must);
                        break;
                     case "Chore":
                        step = call(inst, "POST", "/Chores", core.choreCreateBody(def)).then(must);
                        break;
                  }
                  // structure back; cells this session could not read were never in the backup
                  return step.then(function () {
                     var notes = [];
                     if (noAttributes) notes.push(t("SAASMIG_RESTORENOATTRS", { n: noAttributes }));
                     if (e.cellsUnreadable || e.attributeCellsUnreadable) notes.push(t("SAASMIG_RESTORENOCELLS"));
                     return notes.length ? notes.join("; ") : undefined;
                  });
               });
            };

            // ---------------------------------------------------------------- where used

            /* Opened from Arc's tree menu (or the tab's Refresh). It reads the
             * scan's model, so a database not yet scanned is scanned first. */
            $scope.openWhereUsed = function (req) {
               var inst = $scope.state.instance;
               $scope.state.tab = "whereused";
               var w = $scope.state.whereUsed = { type: req.type, name: req.name, refs: null };
               var compute = function () {
                  var s = $scope.state.scan;
                  if (!s || $scope.state.whereUsed !== w) return;
                  w.refs = core.whereUsed(s.model, s.findings, req.type, req.name);
                  w.groups = core.groupWhereUsed(w.refs);
                  w.breaking = w.groups.filter(function (g) { return g.status === "BLOCKER" || g.status === "BREAKS"; }).length;
                  diag("whereUsed", { object: { type: req.type, name: req.name }, refs: w.refs.length, breaking: w.breaking });
               };
               if ($scope.state.scan && $scope.state.scan.instance === inst) { compute(); return $q.when(); }
               return $q.when($scope.scan()).then(compute);
            };
            $scope.whereUsedHref = function (r) {
               return $scope.objectHref({ objectType: r.fromType, object: r.from });
            };
            $scope.$on("tm1-readiness-request", function (event, r) {
               if (r && r.instance === $scope.state.instance && r.whereUsed && tm1ReadinessRequest.take(r.instance)) $scope.openWhereUsed(r.whereUsed);
            });

            // ---------------------------------------------------------------- lifecycle

            $scope.$watch("state.instance", function (now, was) {
               if (now && now !== was) {
                  $scope.state.scan = null; $scope.state.cloud = null; $scope.state.groupCloud = null; $scope.state.target = null;
                  $scope.state.cfg = null; $scope.state.migrateCmd = null; $scope.state.savedData = null; $scope.state.migrateLog = null; $scope.state.stepOpen = null; $scope.state.scanNote = null; $scope.state.v12check = null; $scope.state.compare = null;
                  $scope.state.tp = null; $scope.state.bedrock.inv = null; $scope.state.bedrock.choice = {}; $scope.state.bedrock.install = {};
                  // Where used named the other database's objects; only on a real switch, not the first assignment
                  if (was) { $scope.state.whereUsed = null; if ($scope.state.tab === "whereused") $scope.state.tab = "overview"; }
                  $scope.probeInstance();
                  restoreFromProject(now);
               }
            });

            $scope.loadInstances();

            // the project this browser had open: back once its folder answers, or waiting for a click
            project.ready.then(function () { if (project.isOpen()) { $scope.prj.view = "detail"; return afterOpen(); } });

            // a tree-menu click that opened this page

            var opened = tm1ReadinessRequest.take($scope.state.instance);
            if (opened && opened.whereUsed) $timeout(function () { $scope.openWhereUsed(opened.whereUsed); });

            // a sign-in anywhere in Arc: list and probe again (the old test compared with an undefined $scope.instance)
            $scope.$on("login-reload", function () {
               $scope.loadInstances();
               if ($scope.state.target) { var tg = $scope.state.target; $scope.state.target = null; $timeout(function () { $scope.state.target = tg; }); }
            });

            $scope.$on("close-tab", function (event, args) {
               if (args.page == "tm1Readiness" && args.instance == $scope.instance && args.name == null) {
                  $rootScope.close(args.page, { instance: $scope.instance });
               }
            });
         }]
   };
});
