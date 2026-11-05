# TM1 REST API Sanity Check plugin
This plugin runs a set of TM1 REST API requests against an instance and checks that each one returns the status code you expect.

1. Open **Tools > TM1 REST API Sanity Check**.
2. Select the requests to run, or select all of them.
3. Click a finished row to see the response, or the body that was sent.

The requests are defined in `requests.json`. Add your own by copying an existing entry and changing the method, the query, the body and the expected status.

**What it changes on the instance**
- It creates a dimension called `zzArcSanityCheck` (with a hierarchy and an element), reads it, and deletes it again. It asks you to confirm first.
- If a dimension with that name already exists it does not run, so it never deletes an existing object.
- If a step fails it stops, and tells you the dimension may need deleting by hand.
- Every other request only reads. `{cube}` and `{dimension}` in `requests.json` are replaced with the first cube of the instance and its first dimension, so it works on any model.

## Add this plugin to your application
1. In Arc, open **Tools > Plugins Manager**.
2. Find this plugin and click **Install**, then reload Arc.
3. The plugin appears in the menu it registers in (see the table in the repository [README](../README.md)).

To install it by hand instead, copy this folder into the `plugins` folder of your Arc installation and reload Arc.

## About Plugins
Before going any further we recommend you reading these two Help articles:
* [How plugins work](https://code.cubewise.com/arc-docs/how-plugins-work)
* [How to create your plugins](https://code.cubewise.com/arc-docs/how-to-create-your-plugins)

More plugins help articles and examples can be found [here](https://code.cubewise.com/arc-plugins).
