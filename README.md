# Factorio Flow Planner

A desktop production planner for Factorio 2.0 and Space Age, in the style of Satisfactory Modeler. You plan factories as nodes on a canvas, and the planner works out machine counts, rates, belts, power, byproducts and loops for you.

## Install (Windows)

1. Open the **[Releases](../../releases/latest)** page and download **`Factorio Flow Planner Setup x.y.z.exe`**.
2. Run it. Windows may show **"Windows protected your PC"** because the installer isn't signed: click **More info → Run anyway**.
3. Start **Factorio Flow Planner** from the desktop or Start menu.
4. On first start, close Factorio if it's running and click **Import game data**. The planner reads recipes, buildings, planets and icons from your own Factorio install, so it always matches your game version and mods. It runs Factorio briefly in the background; a window may appear for up to a minute.

You need **Factorio 2.0** installed (Steam or standalone). Space Age is optional; with it enabled, all planets are available.

Updates install themselves: when a new version is released, the planner shows **"Version x is ready"**. Click **Restart and update**.

## Using it

- **Plan production** (Ctrl+P): pick one or more products and rates, a planet and optional modules. The planner builds the whole chain with the recipes that use the least raw resources. Every item can be switched to another recipe or to "Import".
- **Outposts**: each plan is an outpost (a named group) on its planet's canvas. The planet bar switches between planet canvases. Right-click an outpost for its settings: name, planet, colour, note, links, re-plan, duplicate, collapse.
- **Links between outposts**: in an outpost's right-click menu, under *Supplies*, choose another outpost to supply an input. The supplier grows to cover both.
- **Byproducts and loops**: leftovers such as heavy and light oil are used where possible (cracking and so on). Recipes that feed themselves (coal liquefaction, Kovarex) are built as loops with a **priority splitter**.
- **Nodes**: choose the building, quality, modules, beacons and research bonuses under ▾. Productivity built into foundries, electromagnetic plants and biochambers is applied automatically.
- **Wiring**: drag from a port to a matching port. Drop a wire on empty space to add a recipe that connects to it. Grab a connected input to move or remove its wire.
- **Auto-balance** resizes machines and supplies after every change. A count you type yourself is pinned 📌 and kept.
- **Buildings** (Settings): untick buildings you haven't unlocked. Outposts are re-planned for what you have.
- **Arrange** (Ctrl+L) lays everything out neatly; right-drag selects several nodes.
- **Save** (Ctrl+S) writes to `Documents\Factorio Flow Planner`; your last session is also restored on launch. Undo with Ctrl+Z.

## Not modelled yet

Spoilage timers, quality outputs (the quality % is shown, but outputs count as normal quality), mining productivity research (use the Bonus field), pumpjack yields (crude oil extraction assumes 100%), agricultural towers, asteroid collector rates, boilers, and fluid temperatures.

## How game data is read

The planner has no built-in recipe list. It runs your copy of Factorio with `--dump-data` (all prototypes, to `script-output/data-raw-dump.json`) and `--dump-icon-sprites` (all icons), and reads names from the game's English locale files. The result is stored in `%APPDATA%\Factorio Flow Planner\gamedata`. Re-import after a game update or after changing mods (**Game data → Import from Factorio…**). The Steam build normally relaunches itself through Steam, which drops the command-line flags; the importer sets `SteamAppId` to stop that.

No Factorio files are included in this repository.

## Development

Written in JavaScript on Electron.

```bash
npm install
npm start               # run the app
npm run test:import     # rebuild the model from an existing dump without launching Factorio
npm run dist            # build the Windows installer into dist/
```

`FFP_DEV_SCRIPT=<file.js> FFP_DEV_SHOT=<out.png> npm start` runs a script inside an off-screen window, saves a screenshot and quits. `FFP_USER_DATA=<dir>` uses a different data folder.
