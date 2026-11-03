# TM1 REST API Sanity Check plugin
This plugin runs a set of TM1 REST API requests against an instance and checks that each one returns the status code you expect.

1. Open **Tools > TM1 REST API Sanity Check**.
2. Select the requests to run, or select all of them.
3. Click a finished row to see the response, or the body that was sent.

The requests are defined in `requests.json`. Add your own by copying an existing entry and changing the method, the query, the body and the expected status.

The requests create, change and delete objects named **Test**, so run it on a development instance.

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
