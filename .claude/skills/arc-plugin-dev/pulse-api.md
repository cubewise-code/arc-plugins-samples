# Pulse API from an Arc plugin

Reference for plugins that read from or write to Pulse through Arc. Every call in the
**Verified** tables was run from a plugin page in Arc 6.1.2810 against Pulse 8.0.1
(November 2026), and is kept runnable in the `pulse-api-sanity-check` plugin
(`requests.json`). Calls marked **from Arc source** were read in Arc's code but not run.

When Pulse or Arc changes, run that plugin first: it tells you which of these still work.

## How Arc reaches Pulse

- Arc's server proxies every request under `/_pulse/` to the Pulse URL in Arc's
  `settings.yml` (`pulseurl`, or the server group's `pulseurloverrides`). See
  `server/pulse.go` (`pulseProxy`) in the Arc source.
- From a plugin, call the proxy with a **relative** URL and `$http`, not `$tm1`:
  `$http.get("_pulse/api/state/after")`. Do not call the Pulse URL directly: the
  browser has no Pulse session on that origin.
- The Pulse session is a cookie set when the user signs in to Pulse **in Arc**.
  Signing in on the Pulse site itself (port 8099) does not give Arc a session.
- Arc caches `GET api/object-locking/locks` answers in its proxy
  (`objectlockingsettings.cachetimeout` in `settings.yml`, default 2s). A lock you
  just made can be missing from a cached answer for that long. A POST or DELETE to
  the locks URL clears the cache.

## Rules for calling Pulse

1. **Find the Pulse server and service of the instance** with Arc's `$pulse` service:
   ```js
   // inject "$pulse"
   $pulse.serviceFromInstance($scope.instance).then(function (service) {
      // service.serverName  e.g. "CWVV"      (the Pulse environment)
      // service.serviceName e.g. "tm1srv01"  (the instance as Pulse names it)
   }, function (error) {
      // error.message says why: no pulseurl, no pulseenvironment for the
      // instance, Pulse disconnected, or the instance not found in Pulse
   });
   ```
   It reads `pulseenvironment` / `pulseinstance` from Arc's settings and matches them
   against `api/state/after`.
2. **Send `x-login-no-prompt: true` and `x-non-interactive: true`** on calls the plugin
   makes by itself. Without them, a 401 makes Arc's interceptor open the Pulse sign-in
   dialog, or sign the user out of Pulse. With them, the 401 comes back to your code.
3. **Check `status` and then `data.Failed`.** Pulse reports many errors as HTTP 200 with
   `{"Success": false, "Failed": true, "Message": "..."}`. Arc's own code checks
   `!success.data.Failed`; do the same. Errors can also be 400 with the same body.
4. **Handle both `.then` callbacks.** With the headers above, a 4xx may resolve or reject
   depending on Arc's interceptor; pass one handler to both and read `response.status`.
5. **Not every answer is JSON.** `api/raw` returns a file as text, `login` returns HTML,
   reports return PDFs. Use a `transformResponse` that parses JSON only when the text
   starts with `{` or `[`.
6. **No CSRF token is needed** for the `api/...` writes listed here (locking, Test Hub,
   validation). Only `login` uses one (`GET _pulse/login` with `X-CSRF-Token: Fetch`,
   then send the returned `x-csrf-token`).
7. **Parameter names are not consistent.** Copy them exactly from the tables:
   `servername` vs `server-name`, `service` vs `service-name` vs `serviceName`,
   `start`/`end` vs `dayfrom`/`dayto`. A wrong name usually gives 200 with
   `Failed: true` or an empty result, not a 400.
8. **Dates** are `yyyy-MM-dd` unless noted. `state/nearest` takes Unix milliseconds.
9. **Signed in or not:** `isLoggedIn()` is `$pulse.isLoggedIn()`. To ask the user to sign
   in, call `$pulse.loginRequired()`. It does nothing when Pulse is *disconnected* in Arc
   (the user pressed Cancel in Arc's Pulse sign-in dialog), so reconnect first:
   ```js
   if ($rootScope.uiPrefs.pulseDisconnected) { $pulse.setConnectedStatus(); }
   $pulse.loginRequired();
   ```
   Listen for `$scope.$on("pulse-login-change", ...)` to reload once signed in.
   `$dialogs.pulseConnection()` exists in newer Arc source but not in Arc 6.1.

Minimal helper:

```js
var pulseGet = function (url) {
   var done = function (r) { return r || {}; };
   return $http({
      method: "GET",
      url: url,                                   // e.g. "_pulse/api/state/after"
      headers: { "x-login-no-prompt": true, "x-non-interactive": true },
      transformResponse: function (text) {
         if (!_.isString(text) || !/^\s*[\[{]/.test(text)) { return text; }
         try { return JSON.parse(text); } catch (e) { return text; }
      }
   }).then(done, done).then(function (r) {
      if (r.status !== 200) { return $q.reject("Pulse answered " + r.status); }
      if (r.data && r.data.Failed === true) { return $q.reject(r.data.Message || "Pulse reported a failure"); }
      return r.data;
   });
};
```

In the tables, `{server}` is `service.serverName`, `{service}` is `service.serviceName`,
and every URL is relative to `_pulse/`.

## Verified: calls Arc makes

### Connection and sign-in

| Method | URL | Expected | Notes |
|---|---|---|---|
| GET | `login` (header `X-CSRF-Token: Fetch`) | 200 | HTML page; the CSRF token is in the `x-csrf-token` response header |
| GET | `api/system/status/check` | 200 | `version` (e.g. `8.0.1`), `overallStatus`, `storageStatus`. Arc uses `version` for feature checks (`$pulse.getFeatureSupport`) |
| GET | `api/system/account` | 200 | Signed in: `name`, `displayName`, `isAdmin`... Signed out: still 200, without `name` |
| GET | `api/setting/?include-connection-url=true` | 200 | Array of Pulse environments with their `Services` and connection URLs |

### Monitoring and change tracking

| Method | URL | Expected | Notes |
|---|---|---|---|
| GET | `api/state/after` | 200 | Array of `{State: {ServerName, ServiceStates: [{ServiceName, Status...}]}}`. Arc polls it with `logindex-<server>=` / `alertindex-<server>=` params |
| GET | `api/changes/all?max=10` | 200 | Object keyed by server; Arc polls it with `index-<server>=` params |
| GET | `api/changes?service={service}&start=&end=&types=All&servername={server}&max=100` | 200 | **Pulse 8:** `{count, pages, commits: [{id, userName, message, timeStamp, filesInCommit: [{path, changeType}]}]}`. Older Pulse: the array alone. Read both |
| GET | `api/change?service={service}&id={commitId}&servername={server}` | 200 | One commit |
| GET | `api/diff?service={service}&id={commitId}&path={file}&servername={server}` | 200 | `{content, commit}`; `content` has `&quot;` to unescape |
| GET | `api/changesbyauthor?service={service}&author={user}&start=&end=&servername={server}` | 200 | |
| GET | `api/changesbyfile?service={service}&path={file}&start=&end=&servername={server}` | 200 | `path` is a file Pulse tracks, e.g. `}Academy.SaveProgress.pro`. A file with no history answers `Failed: ERRUNABLETORETREIVEFILECHANGES` |

`types` for `changes`: `All`, or a comma list such as `Applications` (see Arc's
`change-tracking.js`). Dates for `changes` are `DD-MM-YYYY` on Pulse 7.1.0 only
(see **Feature versions** below).

### Search, process history, validation, locking

| Method | URL | Expected | Notes |
|---|---|---|---|
| GET | `api/search?service={service}&query={text}::pro%2Crux%2Ccho%2Ccubx%2Cdimx%2Cdimd&servername={server}&max=100` | 200 | After `::`, the URL-encoded object types to search |
| GET | `api/processhistory?servername={server}&service={service}` | 200 | **Fails on Pulse 8.0.1** with `Failed: Unable to load process history` (no detail in `pulse.log`). Arc's process and chore pages use it (`$pulse.getHistoryStats`) |
| GET | `api/processhistorysearch?servername={server}&service={service}&dayfrom=&dayto=&timefrom=&timeto=` | 200 | `{maxResults, items: [...]}`. Add `&chore=false&name={process}` or `&chore=true&name={chore}` for one object |
| POST | `api/validation/{server}/process/{process}` | 200 | Body: the process as `GET /Processes('name')` returns it from TM1. Answer: array of `{level, items: [{location, ...}]}` |
| POST | `api/validation/{server}/rule/{cube}` | 200 | Body: `{Name, Rules}` |
| GET | `api/object-locking/locks?server-name={server}&service-name={service}` | 200 | All locks of the instance |
| GET | `...locks?server-name=&service-name=&object-type=process&object-path={name}` | 200 / 204 / 404 | One object; "not locked" differs by Pulse version |

### Test Hub (Arc Test Centre)

| Method | URL | Expected | Notes |
|---|---|---|---|
| GET | `api/arc/test/category/list?server-name={server}&service-name={service}` | 200 | Array of `{id, label, color, description}` |
| GET | `api/arc/test/unit/list?server-name=&service-name=&page=0&size=10` | 200 | Total in the `arc-test-unit-total` response header |
| GET | `api/arc/test/package/list?...&page=0&size=10` | 200 | Collections; total in `arc-test-package-total` |
| GET | `api/arc/test/result/list?...&page=0&size=10` | 200 | Total in `arc-test-result-total` |
| GET | `api/arc/test/coverage/list?...&page=0&size=10` | 200 | |

List filters (from Arc's `$unit-testing.js`): `filter-text`, `filter-test-category-names`,
`filter-target-objects`, `filter-action-types`, `filter-test-package-ids`,
`filter-test-test-ids`, `order-by`, `order`.

## Verified: writes

| Method | URL | Body | Expected |
|---|---|---|---|
| POST | `api/object-locking/locks?server-name={server}&service-name={service}` | `{serverName, serviceName, TM1ObjectType, TM1ObjectPath, TM1Username}` | 201 |
| DELETE | same URL | `{serverName, serviceName, TM1ObjectType, TM1ObjectPath}` | 200 |
| POST | `api/arc/test/category/create?server-name=&service-name=` | `{id, label, color}` (`id`: a new UUID made by the caller) | 204 |
| GET | `api/arc/test/category/item?server-name=&service-name=&test-category-id={id}` | | 200 |
| PUT | `api/arc/test/category/update?server-name=&service-name=` | `{id, label, color}` | 204, but see below |
| DELETE | `api/arc/test/category/delete?server-name=&service-name=` | `{id, label}` | 204 |

`TM1ObjectType` values are Arc's `$tm1.objectTypes`: `process`, `rule`, `cube`,
`dimension`, `chore`... `DELETE` with a body: `$http({method: "DELETE", url, data, headers: {"Content-Type": "application/json"}})`.

**Test Hub categories: two Pulse 8.0.1 problems.**
- Pulse keeps one folder per category **label**, at
  `C:\Program Files\Pulse for TM1\tests\units\<server>\<service>\<label in lower case>`.
  Deleting a category deletes that folder even if another category has the same label;
  the other category can then not be deleted (`Could not delete folder with name [...]`).
  Give test or temporary categories unique labels.
- `PUT .../category/update` indexes the category twice. After that `item` and `delete`
  fail (`Cursor returned more than one result` in `pulse.log`). Waiting does not help.
  Avoid updating categories from a plugin until this is fixed.

## Verified: Pulse data (Arc does not call these)

What Pulse has collected, mostly stored in its OpenSearch indices. These are the calls
Pulse's own pages and its MCP tools use (see `resources/js/api/*.api.js` inside
`pulse.jar`). There is no call that passes a raw query to OpenSearch, and OpenSearch
(HTTPS on a local port, client certificate required) cannot be reached from a plugin.

| Method | URL | Notes |
|---|---|---|
| GET | `api/system/status` | `storageStatus`: OpenSearch `elasticStatus`, `clusterHealth`, `indices` (name, health, `docs_count`, size), `totalElasticSpace`, `databaseHealth` (H2). **Signed in only**: signed out the block is empty |
| GET | `api/system/state` | Pulse configuration, settings, license |
| GET | `api/system/logs/application` | `{index, lines}`; `api/system/logs/monitor` for the monitor log |
| GET | `api/performance/server?server-name={server}&start=&end=` | Memory and CPU by day, alerts |
| GET | `api/performance/instance?server-name={server}&service={service}&start=&end=` | Uptime, thread states, memory and CPU by day |
| GET | `api/state/nearest?servername={server}&date={unix ms}` | Full server state nearest to that time |
| GET | `api/session/runtime?server-name={server}&start=&end=` | Tree `{name, color, children}` |
| GET | `api/session/waittime?server-name={server}&start=&end=` | Same shape |
| GET | `api/cancel/requests?server-name=&start=&end=` | Array; also `api/disconnect/requests`, `api/service/requests` |
| GET | `api/cubestats/{server}/{service}/{cube}?start=0&max=50` | `{hasRuleFile, items}`. **The server is in the path.** Pulse's JS client documents `/{service}/{cube}`, which answers `Failed: An invalid path was used` |
| GET | `api/rulestats/{server}/{service}/{cube}[/{lineNo}]?start=0&max=50` | `{statistics}`. Same path rule |
| GET | `api/processhistory?servername={server}&service={service}&start=&end=` | Process and chore history by day (with dates this answered on Pulse 8.0.1; without them it fails, see above) |
| GET | `api/processhistorygantt?servername={server}&service={service}&day={yyyy-MM-dd}` | Array of tasks; add `&chore=true` for chores |
| GET | `api/raw?servername={server}&service={service}&file={file}` | **Plain text**: the file as Pulse stores it (e.g. a `.pro`) |
| GET | `api/source/level?servername={server}&service={service}` | `{maxElements, dimensions: [{name, elements, sourceControlLevel...}]}` |
| GET | `api/instance?servername={server}&service={service}` | Documentation: `apps`, `dims`, `lastUpdate`... |
| GET | `api/sessions?server-name={server}&service={service}&start=&end=` | `{sessions, sessionsByDay, namedUsersByDay, totalUniqueUsers...}` |
| GET | `api/system/sessions?start=&end=` | All instances: `{summary, sessions, logSummary, logs}`. **Slow** (about 3.5 s for 30 days) |
| GET | `api/system/session/user?username={user}&start=&end=` | `{sessions, logs}` for one user |
| GET | `api/user?id={user}&servername={server}&start=&end=` | `{userName, services, sessionsByDay, operationsByDay, summary, sessions...}` |
| GET | `api/websheets?start=&end=` / `api/websheets/open` | Arrays; also `api/workbooks`, `api/workbooks/open`, `api/canvaslogs`, `api/canvaslogs/open` |
| GET | `api/system/alert/list-simple?servername={server}` | `{alerts}`; `api/system/alert` (full) and `api/system/alert/type/list` also exist |
| GET | `api/pulse/alert?servername={server}` | `{repeatInterval, pulseServerAlerts}` |
| GET | `api/systemsummaryreport/?serviceName={service}&servername={server}` | `{reportSettings}` |

Single-item variants (not run): `api/websheet`, `api/canvaslog`
(`servername`, `path`, `start`, `end`); `api/elements/{service}/{dimension}?servername=`;
`api/dashboard[?profileName=]`. CSV downloads exist for most lists (e.g.
`api/sessions/usersessions.csv`, `api/processhistory/processeshistory.csv`).

### Excel workbooks (verified November 2026, Pulse 8.0.1, in `workbook-flow-diagram`)

| Method | URL | Notes |
|---|---|---|
| GET | `api/workbooks?start=&end=` | Every environment's workbooks opened in the period: `[{serverName, path, openCount, lastOpened, lastOpenedBy, sheets, tm1Sheets, logVersion...}]`. Without dates Pulse uses its report window. Any range is accepted through Arc (`start=2000-01-01` lists them all); the 31-day `MaxReportDaySpan` limit applies only to Pulse's MCP tools. It does not say which TM1 instance a workbook reads |
| GET | `api/workbook?servername={server}&path={path}&logVersion={logVersion}&start=&end=` | `{worksheets, usage, openByDay, saveByDay...}`. Each worksheet has `name`, `sheetType` (e.g. `Slice`), `cubeName` and `TM1ServerName`; a sheet Pulse cannot tie to a server has `TM1ServerName: "Unknown"` and no `cubeName`. Pass the list's `logVersion` (2 for current add-ins) |

**`api/workbook` fails when the period holds no opening of the workbook.** It answers 200 with
`{"Failed": true, "Message": "Unable to get excel workbook..."}`, whether the period is one day or
several, although the worksheets themselves do not depend on the dates. Ask for the day the workbook
was last opened (the list's `lastOpened`, first 10 characters) through the day after. "Today only"
works on the day a workbook is opened and breaks the next day.

## From Arc source, not run

| Method | URL | Used by in Arc | Why not run |
|---|---|---|---|
| POST | `login` with `Authorization` or `x-authorization` and `X-CSRF-Token` | `$pulse.loginWithStoredCredentials` | Changes the session. `x-authorization` is Arc-encrypted; the proxy decrypts it |
| POST | `login?logout=true` with `X-CSRF-Token` | `$pulse.logout` | Signs the user out |
| POST | `arclog?servername={server}` | `$pulse` change logging (`pulsetracking: true`) | Writes a tracked change; Arc adds an `id` hash in the proxy |
| POST | `api/package/create/start-items?server-name=&service-name=` | Migration | Body `{items: [{name, type}]...}`; creates a package |
| GET | `api/package/create/save?id={id}` | Migration | Polled: 202 while running |
| POST | `api/package/rollback?servername={server}` | Change diff, roll back | Creates a package |
| POST | `report/technical.pdf`, `report/validation.pdf?servername=` | Instance page reports | Form-encoded body Arc builds; answer is a PDF (`responseType: "arraybuffer"`) |
| POST | `report/diagram/generate?servername=&servicename=` | Flow diagram | Same |
| POST/PUT/DELETE | `api/arc/test/unit/{create,update,delete}`, `api/arc/test/package/...`, `api/arc/test/result/create`, `api/arc/test/coverage/{create,delete}` | Test Centre | Same shape as categories; `unit` calls also take `test-category-id=` |
| GET | `api/arc/test/{unit,package,result}/item?...&test-{unit,package,result}-id={id}` | Test Centre | Needs an existing id |
| WS | `notifications/connect` | Notifications | Websocket |

## Feature versions Arc checks

From `$pulse.js` (`getFeatureSupport`), against `api/system/status/check` `version`:

| Feature | Pulse version |
|---|---|
| Chore / Process History | 6.0.0.20201214 |
| Code Validation, Migration | 6.2.1.20230414 |
| Test Hub | 6.3.1.20231115 |
| Flow Diagram | 6.4.0.20240528 |
| Change Tracking API Update | 7.1.0.20250909, **exactly** (`==`): on that version `api/changes` takes `start`/`end` as `DD-MM-YYYY`; on every other version `yyyy-MM-dd` |
| TM1 Object Locking | 7.2.0.20251113 |

Use `$pulse.getFeatureSupport("Test Hub")` (resolves `{versionIncompatible, versionMessage}`)
before calling a feature that an older Pulse may not have.
