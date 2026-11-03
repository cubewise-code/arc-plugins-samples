# Arc for TM1 Plugins
The place for TM1 developers to share Arc for TM1 plugins.

## Install a plugin
In Arc, open **Tools > Plugins Manager**, pick this repository as the source, and install the plugins you want. The Plugins Manager reads the plugins from the latest release of this repository, not from the code on a branch.

| Plugin | What it does | Where it appears |
|---|---|---|
| [bedrock-cube-data-export](bedrock-cube-data-export) | Exports cube data to a file with Bedrock.Cube.Data.Export | Cube menu |
| [cheatsheet](cheatsheet) | Everything you should know about how to build plugins | Tools |
| [ghost-ti](ghost-ti) | Runs Turbo Integrator code without creating a process | Tools |
| [homepage](homepage) | A home page for an instance | Tools |
| [process-feeders](process-feeders) | Runs CubeProcessFeeders on selected cubes | Tools |
| [randomise-data](randomise-data) | Randomises the data of selected cubes | Tools |
| [rest-api-sanity-check](rest-api-sanity-check) | Runs TM1 REST API requests and checks the status codes | Tools |
| [services](services) | Lists the services available to plugins | Tools |

[template-page](template-page) is a starting point for writing your own page plugin. It is not published to the Plugins Manager.

## Write a plugin
Start from [template-page](template-page) and read the [cheatsheet](cheatsheet) plugin. Before you publish a change, review the plugin against the current Arc with the `review-arc-plugin` skill in `.claude/skills`.

## About Arc for TM1
<img align="right" width="50%" src="https://static1.squarespace.com/static/5268c662e4b0269256614e9a/t/5ab047476d2a73ff3a99a5fc/1521502030061/arc-logo.png?format=1000w" />

Arc for TM1 is the ultimate modern developer tool for TM1 and Planning Analytics both on-premise and in the cloud. 
  
* **Hierarchy aware**, built for the future of TM1.
* Multi-document tabbed interface.
* Turbo Integrator **debugging**.
* **Syntax highlighting**.
* **Auto-complete**.
* User-defined **snippets**.
* User-defined **plugins** and **pages**.

## About Plugins
Before going any further we recommend you reading these two Help articles:
* [How plugins work](https://code.cubewise.com/arc-docs/how-plugins-work)
* [How to create your plugins](https://code.cubewise.com/arc-docs/how-to-create-your-plugins)

More plugins help articles and examples can be found [here](https://code.cubewise.com/arc-plugins).
