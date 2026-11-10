# Workbook Flow Diagram plugin
This plugin draws a flow diagram that starts from an Excel workbook. Pulse records which cubes each worksheet of a workbook reads; the diagram starts from the workbook, goes to those cubes, then to the objects Pulse's documentation relates to each cube: processes, dimensions, other cubes (through rules and processes), chores and data sources.

1. Sign in to Pulse in Arc. If you are not signed in, or Pulse answers that the session has expired, the page shows a warning with a **Sign in to Pulse** button that opens Arc's Pulse sign-in (reconnecting Pulse first if it was disconnected in Arc). Once you are signed in, the page reloads the workbook list and redraws the diagram it was showing.
2. Open **Tools > Workbook Flow Diagram** under the instance.
3. Choose the period above the list: **Last 7 days**, **Last month** (the default), **Last 3 months**, **Last 12 months**, **All time**, or **Specific dates...** (a first and a last day, both included, then **Apply**). The list shows the workbooks Pulse saw opened in that period that read a cube of this instance, with the cubes they read. The period chosen is remembered in this browser.
4. Choose what to draw:
   - **All workbooks** (the default) draws every workbook in the list, as filtered by the search box, in one diagram, starting at level 1. Typing in the search box redraws it.
   - **One workbook** draws a single workbook. Clicking a workbook in the list switches to it; **One workbook** goes back to the last one drawn on its own.

   Each workbook shows when Pulse last recorded its sheets. The Pulse add-in records a workbook's sheets and the cubes they read when the workbook is opened, so a sheet added or renamed since then (and its cube) is missing from the list and the diagram until the workbook is next opened. Saving or closing the workbook was not seen to update them on Pulse 8.0.1.

   Pulse lists the workbooks opened in the period. Pulse's workbook list does not say which TM1 instance a workbook uses, so the page reads each workbook's worksheets (six at a time, with a progress bar) and keeps those whose worksheets use this instance; workbooks appear as they are found. Type in the search box to filter the list by name, path, last user or cube.
5. The diagram is drawn from left to right by distance from the workbooks:
   - **Levels** says how far the diagram follows the relationships. Level 1 draws the objects directly related to the workbook's cubes; each level more also draws the objects related to the cubes found in the level before. **+ levels** and **- levels** add or remove one level (from 1 to 5). **+ levels** turns off once every related cube is drawn, since another level would add nothing.
   - **Worksheets** adds each worksheet between the workbook and its cubes.
   - The type buttons show or hide a type (for example dimensions, which can be many).
   - Click an object to highlight its links and list them; double-click a cube, process, dimension or chore to open it in Arc.
   - Drag to move the diagram, scroll to zoom, **Fit** to see all of it. **SVG** downloads the diagram as an SVG file.

Each object shows Arc's own icon and colour for its type, as in Arc's tree: `fa Excel` for the workbook, `fa cubes`, `fa dimensions`, `fa processes` and `fa chores`. The page reads the glyph and colour from Arc's stylesheet when it opens, so the diagram follows Arc. In the downloaded SVG, each icon is a small image drawn from Arc's font when you click **SVG**, so the icons show in any program that opens the file, without the FontAwesome font.

Each process is followed to its data source: a **data source** node to its right shows the source's type and name. The types are File (ASCII), ODBC, Cube view (cube » view) and Subset (dimension » subset); a process with no data source gets no node. Click a data source, or its process, to see the type, the name, the view or subset, the ODBC user and the ODBC query. The ODBC password is never read into the page. Pulse's relationships stop at the process, so the page reads the data sources from TM1 (`GET /Processes?$select=Name,DataSource`, once per page); a user who cannot read the processes sees the diagram without them and a message saying so.

Dashed lines come from Pulse's workbook tracking (worksheet to cube). Solid lines are Pulse's documented relationships, drawn in the direction Pulse stores them (source to target).

## What it needs
- `pulseurl` set in Arc's `settings.yml`, and `pulseenvironment` (and `pulseinstance` if the names differ) for the instance, so Arc can match it to a Pulse server and service.
- A Pulse user signed in to Arc with access to the workbook reports.
- Pulse workbook tracking (the Pulse Excel add-in) for the workbooks, and Pulse documentation up to date for the instance: the relationships are those of Pulse's last documentation run.

## What it calls
It only reads. From TM1, `GET /Processes?$select=Name,DataSource` for the data sources (the page keeps the type, name, view, subset, ODBC user and query, not the password). The rest goes through Arc's `/_pulse` proxy:

| Call | Used for |
|---|---|
| `api/workbooks?start=2000-01-01&end={tomorrow}` | Every workbook Pulse has recorded. Pulse only lists workbooks opened between two dates (without dates it uses its report window), so the page asks from 2000. Through this call Pulse does not cap the range; the 31-day `MaxReportDaySpan` limit applies only to Pulse's MCP tools. The list covers every environment; the page keeps this instance's Pulse environment |
| `api/workbook?servername=&path=&logVersion=&start={last opened}&end={day after}` | Once per workbook: its `worksheets`, each with its `cubeName` and `TM1ServerName`. Worksheets do not depend on the dates, but Pulse 8.0.1 answers "Unable to get excel workbook" when the period holds no opening of the workbook, so the page asks for the day the workbook was last opened (from the list) and the day after. A workbook is listed when a worksheet reads this instance (a worksheet with no TM1 server recorded, or `Unknown` as Pulse 8.0.1 records it, counts as this instance). The answers are kept and reused to draw the diagram |
| `relationship/{server}/{service}/{cube}` | Pulse's documented relationships of one cube: a list of `{id, name, type, edges: [{id, name, type}]}`. Rule relationships are shown as cube relationships, and control objects (`}...`) are left out by Pulse |

Worksheets that read cubes on another TM1 instance are not drawn: relationships are per instance. The page says which other instances the workbook uses.

Pulse field names were read from Pulse 8.0.1. The page reads them case-insensitively, so it copes with small differences between versions.

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
