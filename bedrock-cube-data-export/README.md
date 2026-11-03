# Bedrock Export plugin
This plugin exports the data of a cube to a file with the **Bedrock.Cube.Data.Export** process.

1. Right-click a cube and choose **Bedrock Export**.
2. Set the file name and the folder. The folder defaults to the TM1 data directory.
3. Optionally filter the data, either by typing a filter or by picking elements per dimension with the subset editor.
4. Click **OK** to run the process.

The plugin needs the **Bedrock.Cube.Data.Export** process on the instance.

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
