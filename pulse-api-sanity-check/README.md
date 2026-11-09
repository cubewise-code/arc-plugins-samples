# Pulse API Sanity Check plugin
This plugin runs the Pulse API calls that Arc makes, and the Pulse data calls that read Pulse's collected history, through Arc's `/_pulse` proxy for one TM1 instance, and checks that each one returns the status code expected. Use it to check an Arc and Pulse pair after an upgrade, a Pulse URL change or a proxy change, or to find which Arc feature a Pulse problem affects.

1. Sign in to Pulse in Arc. If you are not signed in, the page shows a **Sign in to Pulse** link that opens Arc's Pulse sign-in (and reconnects Pulse first if it was disconnected in Arc).
2. Open **Tools > Pulse API Sanity Check** under the instance.
3. Select the requests to run and click **Run**. They run one after the other.
   - **Search all columns** shows only the rows that contain every word you type: the area, request, method, URL, expected status, result, message, or where Arc uses the call (for example `test hub`, `/api/arc/test/` or `getLockStatus`).
   - The status buttons (passed, warning, failed, skipped) filter the rows the same way, and the select-all checkbox acts on the rows shown.
4. Click a finished row to see the URL that was called, the body that was sent and Pulse's answer.

## What it needs
- `pulseurl` set in Arc's `settings.yml`, and `pulseenvironment` (and `pulseinstance` if the names differ) set for the instance, so Arc can match it to a Pulse server and service. Without them, the requests that need the server or service name are skipped and the page says why.
- A Pulse user signed in to Arc. Without one most requests answer 401. The plugin never opens Arc's Pulse sign-in dialog during a run.
- Pulse reports some errors as HTTP 200 with `{"Failed": true, "Message": ...}`. The plugin counts these as failures, as Arc does.

## What it calls
The requests are in `requests.json`, grouped by the Arc feature that uses them: connection and sign-in, instance state, change tracking (`changes`, `change`, `diff`, `changesbyauthor`, `changesbyfile`), model search, process and chore history, code validation of a process and of cube rules, object locking, and the Test Hub lists.

### Pulse data (not called by Arc)
The **Pulse data** groups read what Pulse has collected, mostly stored in its OpenSearch indices. Arc does not call these; they are the same calls Pulse's own pages and its MCP tools use, so they show whether Pulse's history can be read through Arc's proxy. All of them only read.

| Group | Calls |
|---|---|
| storage | `api/system/status` (OpenSearch health, each index with its document count, the H2 database), `api/system/state`, `api/system/logs/application` |
| monitoring | `api/performance/server`, `api/performance/instance`, `api/state/nearest`, `api/session/runtime`, `api/session/waittime`, `api/cancel/requests`, `api/disconnect/requests`, `api/service/requests` |
| history | `api/cubestats/{server}/{service}/{cube}`, `api/rulestats/{server}/{service}/{cube}`, `api/processhistory`, `api/processhistorygantt`, `api/raw`, `api/source/level`, `api/instance` |
| usage | `api/sessions`, `api/system/sessions`, `api/system/session/user`, `api/user`, `api/websheets`, `api/workbooks`, `api/canvaslogs` (and their `/open` variants) |
| alerts | `api/system/alert/list-simple`, `api/pulse/alert`, `api/systemsummaryreport/` |

Notes:
- `api/system/status` returns OpenSearch details only to a signed-in user; `api/system/status/check`, which Arc uses, returns them empty.
- `cubestats` and `rulestats` need the Pulse server in the path (`/api/cubestats/CWVV/tm1srv01/Employee`). Pulse's own JavaScript client documents them as `/{service}/{cube}`, which answers "An invalid path was used".
- `api/system/sessions` reads every session in the date range and can take a few seconds.
- There is no call that passes a query through to OpenSearch, and OpenSearch itself cannot be queried from outside Pulse: it listens on HTTPS and asks for a client certificate.

Values in braces are filled in before a request runs, URL-encoded in the URL:

| Placeholder | Value |
|---|---|
| `{serverName}`, `{serviceName}` | The instance's Pulse server and service, as Arc finds them |
| `{process}`, `{chore}`, `{ruleCube}` | The instance's first process, chore and cube (a cube with rules when there is one) |
| `{tm1User}`, `{pulseUser}` | The TM1 user and the Pulse user |
| `{today}`, `{monthAgo}` | Today, and 30 days ago (`YYYY-MM-DD`) |
| `{nowMs}` | The time the run started, in milliseconds (for `state/nearest`) |
| `{commitId}`, `{commitPath}`, `{commitAuthor}` | Taken from the latest change Pulse returns for the instance in the last 30 days (the change, its first file and its author) |
| `{testName}`, `{testId}`, `{testId2}` | `zzArcPulseSanityCheck` and new ids for each run, used by the write requests |

A request whose placeholder has no value (for example no change in the last 30 days) is shown as **skipped**, with the reason.

Each entry in `requests.json` can use:
- `group`, `name`, `method`, `url`, `statusCodeExpected` (a number, or a list of accepted numbers): required.
- `body`: the JSON body. `bodyFromTm1`: a TM1 REST path whose answer is sent as the body (used for code validation).
- `headers`: extra request headers.
- `capture`: `{ "key": "path" }` keeps a value from the answer (a lodash path such as `commits[0].id`) for later requests. Give a list of paths when the answer's shape differs between Pulse versions; the first one with a value is used.
- `delayBefore`: milliseconds to wait before the request, to give Pulse time to index what the previous request created.
- `sets` / `needs`: a request with `needs` runs only if the request with the same `sets` value succeeded.
- `writes: true`: not selected by default, and asks you to confirm before it runs.
- `usedBy`: where Arc (or, for the Pulse data groups, Pulse) uses the call, shown as a tooltip and in the details.

An answer that is not JSON (`api/raw` returns the file itself) is kept as text and shown as text in the details.

## What it changes
The read requests change nothing. The write requests, which are not selected by default and ask you to confirm first:
- lock a process called `zzArcPulseSanityCheck` in Pulse object locking (no process with that name is needed or created), read the lock and unlock it;
- create a Test Hub category called `zzArcPulseSanityCheck-<new id>`, read it and delete it. Each run uses a new label: Pulse keeps one folder per category label (`tests\units\<server>\<service>\<label>`), and deleting a category removes that folder even when another category still uses the label, after which that other category can no longer be deleted;
- **Test Hub update**, a separate group: create a second category, rename it and delete it.

If a step that removes a test object fails, the page tells you what to remove by hand.

**Known Pulse issue (8.0.1):** renaming a test category (`PUT .../category/update`, which is what Arc's Test Centre sends) leaves the category in Pulse's index twice. After that Pulse cannot read or delete it (`Cursor returned more than one result` in `pulse.log`), so the **Test Hub update** group leaves a category called `zzArcPulseSanityCheck-<id> (updated)` behind on an affected Pulse. Waiting between the requests does not help. Select that group only when you want to check this.

No TM1 object is changed. The plugin only reads from TM1 to find the sample process, chore and cube, and the process or rules sent for validation.

## What it does not call
These calls change data or need a payload that Arc builds itself, so they are not run: Pulse sign-in and sign-out (`POST _pulse/login`), change logging (`POST _pulse/arclog`), migration packages (`_pulse/api/package/create/start-items`, `_pulse/api/package/create/save`), rollback (`_pulse/api/package/rollback`), the PDF reports (`_pulse/report/technical.pdf`, `_pulse/report/validation.pdf`), the flow diagram (`_pulse/report/diagram/generate`) and the notifications websocket.

## Add this plugin to your application
1. In Arc, open **Tools > Plugins Manager**.
2. Find this plugin and click **Install**, then reload Arc.
3. The plugin appears under an instance's **Tools** node.

To install it by hand instead, copy this folder into the `plugins` folder of your Arc installation, add it to `plugins.yml`, and restart Arc.

## About Plugins
Before going any further we recommend you reading these two Help articles:
* [How plugins work](https://code.cubewise.com/arc-docs/how-plugins-work)
* [How to create your plugins](https://code.cubewise.com/arc-docs/how-to-create-your-plugins)

More plugins help articles and examples can be found [here](https://code.cubewise.com/arc-plugins).
