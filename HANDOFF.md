# Arctium Mod Manager: build handoff

This document is for a Claude (or any developer) who will build this tool on a new PC. It explains what the tool does, how the working prototype is built, the file formats it reads, the mistakes already made and how they were fixed, and a suggested build plan.

The working source is in this repository. `build.ps1` compiles the server (see README.md). The parts most worth reusing are the parsers for game data (CASC, DB2, M2, BLP) and the hair merge. Reuse them instead of writing them again: each one took several rounds of debugging against real game files.

---

## 0. TL;DR for the builder

- The tool is a **local web app**. A small local HTTP server reads files from disk, and a browser page does all of the parsing, previewing and planning in JavaScript.
- **Never modify the user's mod folders.** The tool only reads them. Every output goes into the tool's own `Output\` folder and a few text files next to it.
- Do **not** hand the user a downloaded unsigned `.exe` or a `.bat` that uses `-ExecutionPolicy Bypass`. Windows Defender flags both (see section 9). Build and run it **on the user's own PC**. Anything you compile there yourself has no download mark and is not a problem.
- The fastest route: copy `web/` as is, then write a small local server that exposes the HTTP API in section 5. Any language works: Node, Python, C# or PowerShell. The C# version in `src/ArctiumModManager.cs` is complete and compiles with the `csc.exe` that ships with Windows.

---

## 1. What the tool is for

Arctium is a WoW launcher that can load **file replacement mods**: a folder of loose files laid out like game paths, for example `character/orc/female/orcfemale_hd.m2`. The user has many model and texture mod packs (body mods, creature replacers, armour texture packs) in one "mods root" folder. In the Arctium app they turn the folders on or off and add "file mappings" (text files of `fileId;path` lines).

Three problems this tool solves:
1. When two folders ship the same file, it isn't clear which one wins. The tool gives a clear **load order** (top wins) and **per-file picks**.
2. Previewing what a mod changes needs a model viewer. The tool shows the **modded model next to the original game model** in 3D.
3. Many mods use **custom texture file IDs** that need a mapping file. Without it, the model shows **solid bright green** in game. The tool collects mappings and finds missing ones.

### Features (all working in the prototype)

| Tab / feature | What it does |
|---|---|
| **Models** | Lists every model touched by a mod: playable races, creatures/NPCs, items. Two 3D views side by side, each with a source dropdown (Your build, Original game, any single mod). Geoset toggles (body parts, hair, etc.), texture slot pickers, creature texture variations from CreatureDisplayInfo. |
| **Playable character customization** | For player race models, applies the real character-creation options (skin colour, face, hair style, etc.) from the game's customization DB2s and composites the body texture the way the game does. |
| **Gear try-on** | Lists armour texture sets found in mods (`item/texturecomponents/...`), grouped by set and piece. You can put them on the character, mix pieces from different mods, and turn a set or piece on or off in the build. |
| **Texture swap ("use another texture")** | Puts any texture (modded, or a game texture no item uses) under another texture's file name, so an item you own shows it. Stored as `remap[targetPath] = {lc: sourcePath, src: sourceKey or "@game"}`. |
| **Items** | Search game items by name, show the textures/models each one uses, and pick which mod's replacer it uses. Groups items into official sets (ItemSet) and "look-alike sets". |
| **Hair mixer** | For a body model, take each hair style (geoset 0xx) from any mod's version of that model, or from the game, and merge it into the chosen body's .m2/.skin. |
| **Load order & build** | Order the mod folders, turn them on or off, see conflicts, press Build. That fills `Output\` with hard links and writes one combined mapping file. |
| **Missing texture check** | Scans each built .m2's TXID chunk for file IDs that are neither in the game nor in a mapping. It guesses when there is exactly one candidate new .blp in the same folder, and reports the rest. |

### User workflow
1. Start the tool. On first start it detects the folders from the Arctium app's own settings (section 3).
2. It imports the Arctium app's current folder order and on/off states into `profile.json`.
3. The user sets the order and picks, then presses **Build**.
4. One time only, in the Arctium app: turn off the individual mod folders, add `<tool>\Output` as a mod folder, and add `<tool>\LoadOrder-mappings.txt` as a file mapping.
5. After every later change: Build again, then restart the game.

---

## 2. Architecture

```
browser page (web/*.js, ES modules, three.js r160 vendored)
   |  fetch()  http://127.0.0.1:<port>/api/...
local server (only listens on localhost; serves web/ and a tiny file API)
   |
disk: game folder (read), mods root (read), Arctium LocalState (read),
      tool folder: profile.json, *.txt, Output\ (write)
```

Why it is split this way: browsers can't read arbitrary disk paths or make hard links. The server stays thin (list/read/write/hard-link). All game format logic lives in JS and can be tested in Node (see `dev/`).

### Source files (`web/`)
| File | Lines | Role |
|---|---|---|
| `index.html` | | Layout, tabs, CSS. Loads `app.js` as a module. |
| `app.js` | ~1580 | Everything UI and logic: state `S`, listfile, profile, source scan, mappings, file resolution, model list, rendering, gear, items, swap, hair panel, order page, build, mapping check. |
| `casc.js` | 189 | Local CASC reader (game data archive). Environment independent: it takes an `io` object. |
| `db2.js` | 126 | WDC5 DB2 table reader. |
| `m2.js` | 90 | M2 model + .skin parser (just enough for rendering). |
| `blp.js` | 91 | BLP texture decoder (DXT1/3/5, palettized, raw) → RGBA. |
| `chr.js` | 119 | Character customization tables → which textures/geosets a choice uses, layered composite. |
| `hair.js` | 219 | Hair merge: writes new .m2 and .skin binaries. |
| `viewer.js` | 119 | three.js scene, two views, orbit controls, skinned mesh in bind pose. |
| `vendor/` | | `three.module.min.js` (r160), `OrbitControls.js`. |

`src/ArctiumModManager.cs` is the server as a C# 5 / .NET Framework 4 WinForms tray app. `server.ps1` is not included because the PowerShell route got flagged. The C# file is the reference for the API.

`dev/` has Node test scripts: `nodeio.mjs` gives a Node `io` for `Casc`, and the `test_*.mjs` scripts each exercise one parser against a real game folder. Their paths assume the game is mounted at `$HOME/mnt/World of Warcraft`; change that line.

---

## 3. Arctium facts (verified)

- The Arctium app is an MSIX package. Its data folder is
  `%LOCALAPPDATA%\Packages\<something>Arctium.ArctiumApp_<hash>\LocalState`. Find it by globbing `Packages\*Arctium*` and checking that `LocalState\config` exists.
- `LocalState\config\appsettings.Mods.json` has the mod folders and mapping files. Its shape (groups are dictionaries; iterate all values):
  ```json
  { "Mods": {
      "Folders":  { "<group>": { "<id>": { "Path": "X:\\...\\SomeMod", "IsEnabled": true, "Order": 3 } } },
      "Mappings": { "<group>": { "<id>": { "Path": "X:\\...\\mappings.txt", "IsEnabled": true, "IsInternal": false } } }
  } }
  ```
  Read it defensively: walk the JSON and collect every `"Path"` string. The tool never writes this file (the server refuses to).
- `LocalState\config\appsettings.GameClients.json` contains the path(s) to `Wow.exe`. Its parent folder is the **product folder** (e.g. `_retail_`, `_classic_`, or a private build like `_forever_`). That folder's parent is the **WoW root** (it holds `Data\` and `.build.info`).
- **Listfile**: `LocalState\apps\<appId>\mappings\filemapping.txt` (the prototype found it at `apps\704159964\...`; search `apps\` recursively for `filemapping.txt`). It holds `fileId;path` lines for the game build Arctium targets. **Use this as the listfile.** The community listfile (github.com/wowdev/wow-listfile releases, `community-listfile.csv`, CRLF) is a fallback.
- Mod folders: each file is matched by its **path relative to the folder root**, case-insensitively. Example: `<ModFolder>\creature\imp\imp.m2` replaces `creature/imp/imp.m2`.
- Arctium **ignores `.txt` files inside mod folders**. Many mod authors ship a `<model>.txt` with `fid;path` lines next to the model and expect it to work. It does not. A custom file ID only resolves if a **File Mapping** is added in the app (Mods > File Mappings).
- **Solid bright green body/texture in game = the model references a texture file ID that can't be found** (missing mapping).
- Priority between two enabled Arctium folders that ship the same file was never tested. That is the reason the tool builds one merged folder instead.
- Arctium blocks some files (e.g. `LightData.db2` gives "Disallowed File Id"). Only model/texture replacements are in scope.

### Folder auto-detection (first start)
1. ArctiumState: as above.
2. WowRoot + Product: from GameClients.json. Prefer a product folder that has a `Wow.exe` and whose root has `Data\`. If there is no GameClients.json, list the root's subfolders whose names start and end with `_`.
3. ModsRoot: the **longest common parent folder** of all mod folder paths in Mods.json (if that is a drive root or there is only one folder, use the first folder's parent).
4. Show a confirmation dialog with three folder boxes, Browse buttons and a product combo. Save the result to `settings.json`.

---

## 4. Tool state files (in the tool's folder)

| File | Content |
|---|---|
| `settings.json` | `{ "WowRoot", "Product", "ModsRoot", "ArctiumState" }` |
| `profile.json` | `{ version:1, sources:[{path, enabled}] (ordered, top wins), picks:{ lcPath: sourceKey or "@game" }, remap:{ targetLc: {lc, src} }, hair:{ modelLc: { geosetId: {src, fit} } }, extraMappings:[paths], imported:true }` |
| `extra-mappings.txt` | Mapping lines the tool worked out itself (guessed fixes). |
| `LoadOrder-mappings.txt` | **Written by Build**: every mapping line needed by the current build. The user adds this one file in Arctium. |
| `build-report.txt` | Optional. |
| `Output\` | **Written by Build**: the merged mod folder. |

"lc" everywhere means lowercase forward-slash game path.

A **source key** is the mod root's absolute path. Variant subfolders get `root + "#" + subdir` (see 6.2).

---

## 5. Local server API

Listen on `127.0.0.1` only. Try ports 8765–8784. Serve `web/` at `/web/...` and redirect `/` to `/web/index.html`. All paths are Windows absolute paths in query parameter `p`.

| Endpoint | Method | Behaviour |
|---|---|---|
| `/api/info` | GET | JSON `{wowRoot, product, modsRoot, configFile, fileMapping, appDir, outputDir, arctiumRunning}` |
| `/api/config` | GET | Raw `appsettings.Mods.json`. |
| `/api/ls?p=` | GET | `D\tname` lines for folders; `F\tname\tsize` for files (files only under read roots). |
| `/api/tree?p=` | GET | Recursive file list: `rel/path\tsize` per line, `/` separators. Must be under read roots. |
| `/api/read?p=[&o=&n=]` | GET | File bytes, or a byte range. `p=FILEMAPPING` is an alias for the Arctium listfile. Open with share ReadWrite+Delete. **The CASC reader calls this thousands of times with ranges, so it has to be fast.** |
| `/api/write?p=` | POST body | Write bytes. Writable targets only. **Delete the target first, then write (see 8.1).** |
| `/api/copy?from=&to=` | POST | Copy (delete target first). |
| `/api/delete?p=` | POST | Delete a writable file (never the Arctium config). |
| `/api/build` | POST body | See 7.2. |
| `/api/quit` | POST | Shut down. |

**Read roots**: WowRoot, ModsRoot, the tool folder, ArctiumState, and every absolute `Path` in Mods.json (refresh every few seconds).
**Writable**: `profile.json`, `extra-mappings.txt`, `LoadOrder-mappings.txt`, `build-report.txt` in the tool folder, and anything under `Output\` and `backups\`.
Normalize paths with a full-path call and check "under root" with a trailing separator, to block `..` tricks.

The page also needs `inflate` (zlib) for CASC. The prototype uses the browser's `DecompressionStream("deflate")`; see `app.js` `inflate()`.

---

## 6. Data pipeline in the page

### 6.1 Startup (`start()` in app.js)
1. `/api/info`, `/api/config`.
2. Open CASC with an `io` built from `/api/read` and `/api/ls` (`casc.js`).
3. Load the listfile (`loadListfile`). Keep only model-related extensions (`.m2 .skin .blp .anim .bone .skel .phys`) because the full list is huge. Build `pathById`, `idByPath`, and a `dirIndex` (folder → m2/skin/blp files).
4. `loadProfile` (or import from Arctium on first run).
5. `scanSources` (6.2) and `loadMappings` (6.3).

### 6.2 Finding mod roots (`scanSources`)
Users nest folders freely (`Mods\Author\Pack v2\creature\...`). For every file under ModsRoot (from `/api/tree`), split the path into segments and find the index where the **game path starts**:
- first try: the shortest suffix of the segments that is a known listfile path;
- otherwise: the first segment in the top-level game folders set (`character creature item world spells environments models textures interface sound dungeons particles cameras tileset dbfilesclient fonts xtextures`).

The folder before that index is a **mod root**. Files with extensions `txt png rar zip 7z json db ini md jpg` and `thumbs.db` are not game files. `.txt` files are remembered as possible mapping files.

**Variant subfolders**: some packs ship alternates like `creature/alleria/topless/alleria.m2`. The path is unknown, but removing the second to last segment gives a known path. Each such subfolder becomes its own source (`key = root#subdir`), shown as "Pack › alleria/topless". It is placed **directly above** its parent in the order, starts off, and wins when switched on.

Order: the profile's sources first, in their saved order. Then newly found roots, switched off. Profile entries that are only containers (no game files of their own) under ModsRoot are skipped. Others are shown as "missing".

### 6.3 Mappings (`loadMappings`)
Mapping lines come from three places, and the first one wins on a duplicate ID:
1. the tool's `extra-mappings.txt`,
2. `profile.extraMappings` (non-internal enabled mappings imported from Arctium),
3. `.txt` files inside **enabled** sources (lines matching `^\s*(\d+)\s*;\s*(.+?)\s*$`).

Conflicts are listed on the order page. The result is `customMap` (fid → path) and `customPaths` (path → fid).

### 6.4 File resolution (`sourceFor(lc, mode)`)
- `mode = "game"`: always the game.
- `mode = <source>`: that source if it has the file, else the game.
- `mode = "build"`: `picks[lc]` (`"@game"` means the game), else the **first enabled source** in order that has the file, else the game.

`readLC` reads from the source file through `/api/read`, or from CASC by fid. `remap` in build mode overrides it.

---

## 7. Build

### 7.1 Planning (`plan()`)
- For each enabled source and each file: resolve with `sourceFor(lc,"build")`. Files whose path the game doesn't know (no listfile entry, no custom mapping) are **skipped and reported**, because Arctium can't place them.
- Add explicit picks. `"@game"` picks are written from CASC so they override.
- Remaps are processed separately.

### 7.2 Build body (`/api/build`)
The page sends lines:
- `L\t<absolute source file>\t<rel target>`: hard link source to `Output\rel`. Fall back to copy (keep the mtime). Skip it if the target exists with the same length and mtime.
- `K\t\t<rel target>`: keep. The page already wrote this file through `/api/write` (game files, swapped textures, hair-merged models).

The server then **deletes every file in Output that is not in the list**, then empty folders. It returns `{linked, copied, unchanged, removed, errors}`.

Hard links need the tool on the **same drive** as the mods. Otherwise it copies, which works but takes disk space. Use `CreateHardLinkW` (P/Invoke), `fs.link` in Node, or `os.link` in Python.

### 7.3 Mapping file + green check (`checkMappings`)
- `LoadOrder-mappings.txt` = every custom mapping whose path is in the build or is a known game path.
- For each built `.m2`, read the MD21 header size, then walk the chunks after it (`id(4) size(4) data`) and collect `TXID` (u32 fids). Any fid that isn't in CASC, the listfile or the mapping lines will show green. If exactly one new `.blp` (not a game path) exists in the same folder in the build, assume that's it and add `fid;path` to `extra-mappings.txt`. Otherwise report the candidates.
- Write a readable report: counts, duplicates, problems, and mapping lines left out because their mod is off.

---

## 8. Hard-won bugs and gotchas (read this)

### 8.1 Hard-link write-through (CRITICAL)
Files in `Output\` are **hard links to the user's mod files**. Writing into an existing Output file in place (e.g. `File.WriteAllBytes` on an existing path) **changes the original mod file**. Every write into Output must **delete the target first**, then create a new file. This was caught in a mock before it did any damage. Keep it in `/api/write` and `/api/copy`.

### 8.2 CASC
- `.build.info` is `|`-separated with a `Name!TYPE:n` header. Pick the row with `Active=1`. The prototype prefers `Product=wowf` (a private build); for retail use the row matching the chosen product.
- Local `.idx`: use the newest file per bucket (by name), 18-byte entries, 9-byte ekey. Archive offset packing is in `indexLookup`.
- The data archive entry has a **30-byte header** before the BLTE.
- BLTE chunks: `N` raw, `Z` zlib, `E` encrypted. Encrypted chunks are zero-filled when the size is known. This happens in some DB2 hotfix sections and is harmless for our use.
- Root `TSFM`: version 2+ has a different block header (17 bytes). **The same fid can be listed several times** (locale/content flags). Keep all ckeys, prefer locale enUS (bit 0x2) or all-locales, and **try each one** when reading, because some aren't stored locally.
- "file not stored locally" is normal: the listfile names files from other builds. Filter pickers with `casc.has(fid)`.

### 8.3 DB2 (WDC5)
`db2.js` supports compression types: none, bitpacked, common, pallet, pallet array, signed bitpacked. It also handles copy tables, relationship maps (`row.rel`), sparse tables (`row.raw`), and the string block via `db.str(row, field)`. Values come back as `row.v[fieldIndex]` (arrays for array fields). Field indexes below are those `v[]` indexes as used in the prototype. **Check them against your build**: they can shift between game versions.

### 8.4 M2 / .skin
- MD21 chunked file. The model data starts at byte 8, so header offsets are relative to that: `0x2C` bones (88-byte entries), `0x3C` vertices (48 bytes: pos, boneWeights[4], boneIdx[4], normal, uv×2), `0x44` numSkinProfiles, `0x50` textures, `0x78` boneCombos (u16), `0x80` textureLookup.
- Chunks after MD21: `SFID` (skin fids), `TXID` (texture fids), `SKID` (skeleton fid), `BFID`, `AFID`, ...
- **Bones**: either inside the m2, or (newer character models) in a `.skel` via `SKID`. The skel has `SKB1` (bones), and `SKPD` names a parent skel fid at offset 8. Follow the chain.
- `.skin` (header `SKIN`): arrays at offsets 4 vertex map (u16), 12 indices (u16), 20 bone bytes (4 per vertex), 28 submeshes (48 bytes each), 36 batches (24 bytes each); 44 boneCountMax; 48 shadow batches.
- **Submesh index start**: real start = `indexStart + (level << 16)`. `vertexStart` gets **no** level offset.
- Per-vertex bone bytes in the skin index into `boneCombos[submesh.boneComboIndex + i]`. Vertex boneIdx in the m2 are global bone indexes (verified).
- A skin's vertex map can address at most 65535 vertices.

### 8.5 Character geosets
- Geoset id = `type*100 + variant`. Type 0 = hair styles (0 = bald scalp). By default turn on `x01` of each group. **Use 3202 for group 32** (the face; 3201 is the "under helmet" version). **Hide 17xx** (death knight eye glow).
- Creatures: just turn on everything by default.

### 8.6 Character customization (`chr.js`)
DB2 fids (verified on the prototype's build):

| Table | fid | Fields used |
|---|---|---|
| ChrModel | 3384313 | v[4] CreatureDisplayID, v[5] layout |
| ChrCustomizationOption | 3384247 | v[4] ChrModelID, v[5] order, str 0 name |
| ChrCustomizationChoice | 3450554 | v[2] option, v[3] requirement, v[5] order, str 0 name |
| ChrCustomizationElement | 3512765 | [choice, relatedChoice, geoset, skinnedModel, material] |
| ChrCustomizationMaterial | 3459652 | [textureTarget, MaterialResourcesID] |
| ChrModelTextureLayer | 3548976 | rel = layout; [textureType, layer, flags, blendMode, sectionMask, ..., textureTargets[2]] |
| CharComponentTextureSections | 1360263 | section rectangles per layout |
| CharComponentTextureLayouts | 1360262 | layout width/height |
| ChrCustomizationGeoset | 3456171 | v[0] type, v[1] id |
| ChrCustomizationReq | 3450453 | v[2] class mask |
| TextureFileData | 982459 | v[2] MaterialResourcesID, row id = fid |
| CreatureDisplayInfo | 1108759 | v[1] modelId, last field = texture variations[3] |
| CreatureModelData | 1365368 | v[2] model fid |

Model file → ChrModel: model fid → CreatureModelData id → CreatureDisplayInfo → ChrModel.v[4].
Blend modes for compositing on a canvas: 1 and 15 → source-over, 9 → multiply, 6 → overlay, 7 → screen.

`chr.js` has `CLASS_BIT = 0` (show choices of every class). Set it to a class bit (e.g. `1 << 3` for rogue) to grey out choices that class can't use.

Body texture layout (the simpler path in `composeBody`): HD bodies are 2:1 (2048 wide layout), older ones square (1024). Section rectangles are in `LAYOUT` in app.js. Paint the skin, then face lower/upper (sections 9/10), then underwear (`nakedpelvisskin`, `nakedtorsoskin`), then gear overlays in section order legs, feet, chest, arms, hands (5,6,7,3,4,0,1,2).

### 8.7 Items
| Table | fid |
|---|---|
| Item | 841626 (v[3] InventoryType; also class/subclass) |
| ItemSparse | 1572924 (name = 5th string in the raw record) |
| ItemModifiedAppearance | 982457 (v[1] itemId, v[3] appearanceId) |
| ItemAppearance | 982462 (v[1] displayInfoId) |
| ItemDisplayInfo | 1266429 (v[10] model resources[2], v[11] model material resources[2]) |
| ItemDisplayInfoMaterialRes | 1280614 (rel = displayId; [section, materialRes]) |
| TextureFileData | 982459 |
| ModelFileData | 1337833 (v[4] modelResourcesId, v[1] fid) |
| ItemSet | 1343609 (name, v[4] item IDs) |

Chain: item → IMA → ItemAppearance → IDI → IDIMatRes (section, materialRes) → TextureFileData → fid → listfile path.

**Filler textures**: display data often lists textures for sections an item never paints. Filter by InventoryType with `SLOT_SECTIONS`:
`4 shirt:[0,1,3,4], 5 chest:[0,1,3,4,5,6], 20 robe:[0,1,3,4,5,6], 19 tabard:[3,4], 6 waist:[4,5], 7 legs:[5,6], 8 feet:[6,7], 9 wrists:[1], 10 hands:[1,2]`.
Sections: 0 ArmUpper, 1 ArmLower, 2 Hand, 3 TorsoUpper, 4 TorsoLower, 5 LegUpper, 6 LegLower, 7 Foot.
Texture folders: `item/texturecomponents/{armuppertexture, armlowertexture, handtexture, torsouppertexture, torsolowertexture, leguppertexture, leglowertexture, foottexture}/`. Suffix `_f`/`_m`/`_u` is the gender.
Overlay stacking order on the body: Shirt, Legs, Chest, Feet, Wrists, Hands, Waist, Robe, Tabard.

**Look-alike sets** (items not in an ItemSet that belong together): union-find over
(a) the name stem (strip a leading colour word and the last word: "Black Tuxedo Pants" → "Tuxedo"), groups of 2–12 items covering at least 2 slots; and
(b) the shared texture family (`texBase`: file name without gender/section/piece suffixes), groups of 2–6.
Drop components bigger than 16 or with fewer than 2 slots: common families chain everything together otherwise.

**Gear grouping from mod files** (`gearSets`): parse the file name into base / piece (chest, sleeve, glove, belt, pant, boot, robe, bracer, shirt, tabard with synonyms) / section / gender.

### 8.8 Hair merge (`hair.js`, `mixHair`)
Goal: body model T (e.g. the game's orc female) with hair style geoset 0N taken from donor D (another mod's version of the same model).
1. Parse T and every donor: vertices, bones (from the m2 or the skel chain), skin0 submeshes/batches.
2. **Bone mapping** donor → target: match by bone CRC, then by key bone id, then walk up the donor's parent chain until something maps. Fall back to the head bone (key bone 6). Titaa orc → game orc matched 223/223.
3. If "fit" is on, offset donor vertices by the difference between the head bone pivots of the two skeletons.
4. Append the donor's submesh vertices **after the highest vertex skin0 actually uses** (the game orc HD m2 has ~254k vertices but the skins reference fewer). Keep the skin vertex map ≤ 65535.
5. Create a new submesh with the same geoset id. Add the bone slice it needs to `boneCombos` and point the per-vertex bone bytes at it.
6. Clone a batch from **T's own hair batch with the same texture type**, so the hair uses T's hair texture/material. Point it at the new submesh.
7. Zero T's own submesh for that geoset (`indexCount = 0`) so only the donor's version shows.
8. Rewrite MD21 with the vertex array and boneCombos appended (update counts/offsets; the other chunks are copied). Write the skin with the new arrays appended.
9. Build writes the merged m2 (`K` line) and writes the merged skin to **every** skin path in SFID, because all LOD skins must stay consistent with the vertex array.
10. Parse the result again before writing it (`parseM2`/`parseSkin`). If that fails, leave the model unmixed and report it.

The UI shows hair choices as "Style N · Name" from `chr.hairNames(chrModelId)` and greys out donors that lack that geoset.

---

## 9. Distribution and antivirus (lessons)

- A `.bat` that runs `powershell -ExecutionPolicy Bypass -File ...` was blocked by Chrome/Defender ("Virus detected"). Don't ship it.
- An **unsigned C# exe** that starts an HTTP listener, opens a browser and makes hard links was flagged as `Trojan:Script/Wacatac.B!ml`. That is a **machine-learning false positive** (`!ml`), not a signature. Downloads through Discord/browsers carry the Mark of the Web, which triggers it.
- What works: **build on the PC that runs it.** Windows ships `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`:
  ```
  csc /nologo /target:winexe /platform:anycpu /optimize+ /win32icon:src\app.ico ^
      /out:"Arctium Mod Manager.exe" ^
      /r:System.Web.Extensions.dll /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Core.dll ^
      src\ArctiumModManager.cs
  ```
  (The prototype also embedded `web/*` with `/resource:web\X,web/X` per file. That isn't needed when `web\` sits next to the exe: the server serves from disk first.)
- Alternatives: Node (`npx` or a small `server.mjs`) or Python (`python -m` with a small script) if those are installed, or a browser-only version with the File System Access API. That version has no server, so it can't make hard links (it copies), and the browser may refuse to open folders under AppData.

---

## 10. Suggested build plan for the new Claude

1. Ask the user where the WoW folder, the mods root and the Arctium app are (or auto-detect, section 3). Confirm which product folder they play (`_retail_`, `_classic_`, ...).
2. Put `web/` in a tool folder **on the same drive as the mods**.
3. Write the local server (section 5). Port `ArctiumModManager.cs`, or write about 250 lines of Node/Python. Keep the read/write rules and the **delete-before-write** rule.
4. Check the game build: run `dev/test_casc.mjs` and `test_db2.mjs` with Node against their game folder, or open the page and watch the status line. If DB2 field indexes differ (wrong names, empty lists), fix the `v[]` indexes in `chr.js`/`app.js`. If the fids differ, look up the tables in the listfile (`dbfilesclient/<table>.db2`).
5. Adjust `.build.info` product selection in `casc.js` if needed (`Product === "wowf"` prefers the WoW Forever build; other active rows are used otherwise).
6. Test with a mock first: copy one small mod folder somewhere, point ModsRoot at it, Build, and check that `Output\` contains hard links (`fsutil hardlink list <file>`) and that the original files are unchanged (compare hashes before and after).
7. Then the real thing: turn off the other folders in Arctium, add `Output` and `LoadOrder-mappings.txt`, start the game.

### Rules to keep
- Never write inside the user's mod folders. Only read.
- Never write to Arctium's config. The user makes the one-time changes in the Arctium app.
- Ask before deleting anything outside `Output\`.
- Close the game before Build if Arctium locks files (it usually doesn't; hard links are fine).

---

## 11. Known limits / ideas not done
- Animations aren't played; models show in bind pose.
- Item models (shoulders, helmets) preview as models, but not attached to the character.
- Hair mixing only works between versions of the **same** body model (same skeleton family).
- The mapping guess only handles the "exactly one new .blp in the same folder" case.
- No undo history except `profile.json` itself (make a copy before experimenting).
