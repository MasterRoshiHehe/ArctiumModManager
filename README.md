# Arctium Mod Manager

A local tool for Arctium model/texture mods (WoW). It previews modded models next to the original game models, lets you try on modded gear textures, mix hairstyles between versions of a body model, and builds your mod folders in a fixed load order into **one** Arctium mod folder plus **one** file-mapping file.

It only reads your game folder and mod folders. It writes only inside its own folder (`Output\`, `profile.json`, a few `.txt` files). It listens on localhost only and never connects to the internet.

By MasterRoshiHehe.

## Build (Windows 10/11, nothing to install)

There is no prebuilt exe on purpose: an unsigned downloaded exe gets flagged by antivirus heuristics. Build it on the PC that will run it:

```powershell
git clone https://github.com/MasterRoshiHehe/ArctiumModManager.git
cd ArctiumModManager
powershell -NoProfile -File .\build.ps1
```

This compiles `src\ArctiumModManager.cs` with the C# compiler built into Windows (`%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`) and puts `Arctium Mod Manager.exe` in the repo folder. Keep it there: it serves the `web\` folder next to it.

Put the folder on the **same drive as your mod folders**, so Build can use hard links (no extra disk space).

## Use

1. Run `Arctium Mod Manager.exe`. On first start it reads the Arctium app's settings to find your game folder, mods folder and Arctium data, and shows them for you to confirm.
2. A window opens with the tool (Edge or Chrome app window). A tray icon has Open / Change folders / Quit.
3. **Load order & build**: set the order (top wins), press **Build my Arctium folder**.
4. In the Arctium app, one time only: turn off your other mod folders, add `<this folder>\Output` as a mod folder, add `<this folder>\LoadOrder-mappings.txt` as a file mapping.
5. Start the game through Arctium. After any change: Build again and restart the game.

Bright green body/item in game = a texture with an unknown file ID. Build checks for this and reports it.

## For developers / Claude

`HANDOFF.md` explains the whole design: Arctium facts, the local HTTP API, CASC/DB2/M2/BLP formats, character and item tables, the hair merge, the build, and known pitfalls (most importantly: never write into an existing file in `Output\`, it can be a hard link to a mod file). `dev\` has Node test scripts for the parsers.
