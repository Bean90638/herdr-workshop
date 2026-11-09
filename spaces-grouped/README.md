# Space Groups

English | [繁體中文](README.zh-TW.md) | [All projects](../README.md)

Collapsible groups for the Herdr Space sidebar. Organize workspaces with drag and drop without closing existing tabs or terminals.

![Space Groups interface illustration, not an actual screenshot](preview.png)

> The preview uses fictional data and is not an actual screenshot. The current mod UI is in Traditional Chinese; this English guide does not imply an English UI.

## Features

- Create, rename, delete, and collapse groups. New spaces start in Uncategorized.
- Drag spaces between groups, reorder spaces on the same machine, and reorder groups.
- Synchronizes group order within each machine with Herdr's native workspace order, so `Ctrl + Shift + PageUp / PageDown` follows the displayed order.
- Collapsed groups still show the currently active space as a single row. Switching spaces updates that row without expanding the group or changing its saved collapse preference.
- Insertion lines indicate placement. No line appears when a same-group space would stay in place.
- Drop in the blank area below the list to target the final group’s end.
- Deleting a group requires confirmation and returns its members to Uncategorized without closing terminals.
- Retains colored avatars and Git summaries, using Herdr theme colors.

## Installation

Ask an agent working inside Herdr to read [RECIPE.md](RECIPE.md) and all runtime files in this folder before installing the mod into your personal layout. Alternatively:

1. Find the configuration directory: `~/.config/herdr-app`, usually `%USERPROFILE%\.config\herdr-app` on Windows. Use `HERDR_APP_HOME` instead if set.
2. Copy this project's `mods/spaces-grouped/` into the configuration directory's `mods/`. Back up an existing folder with the same name before replacing it.
3. If using a shipped layout, clone it first. This command switches to the new layout; choose a different name if it already exists:

   ```text
   herdr-app do layout.clone --name main --as grouped-layout
   ```

4. Edit your personal `layouts/<layout-name>.json`. In the Space block, replace `"mod": "spaces"` with `"mod": "spaces-grouped"`. A simple content object looks like this:

   ```json
   "content": { "mod": "spaces-grouped" }
   ```

   Preserve other properties and layout blocks.

5. Check the mod and runtime status. For the default Windows path in PowerShell:

   ```powershell
   herdr-app check "$HOME/.config/herdr-app/mods/spaces-grouped"
   herdr-app status
   ```

   Adjust the path if needed. Saves hot-reload; terminal restarts are unnecessary.

## Controls

| Control | Action |
| --- | --- |
| Folder-plus / plain plus | Create a group / create a space |
| Pencil / trash | Rename / confirm deletion |
| Click a group heading | Collapse or expand |
| Drag a group heading | Reorder groups |
| Drop a space on a heading or empty-group hint | Change its group |
| Drop on another space | Upper half inserts before, lower half after; ordering is same-machine only |
| Drop below the list | Target the end of the final group |
| Right-click a space | Open the built-in menu |

Uncategorized cannot be renamed or deleted. Names cannot be blank, duplicated, or the reserved UI name `未分類`. Herdr stores group membership, group order, and collapse state under `spaces-grouped.v1`, outside this repository.

## Requirements and Limitations

- Based on Herdr App 0.1.14's shipped `spaces` mod, provided by `mods/spaces/` in the local Herdr configuration directory; this project does not keep a separate copy. Requires compatible Herdr mod APIs; compatibility with every version is not guaranteed.
- Uses `gpui-kit`, `gpui-base`, `herdr`, shipped `menu`, and `workspace-chrome` icons. No other custom mods are required.
- Below a sidebar width of 160px, compact mode hides group management.
- Machines form the first level, with groups inside each machine. Cross-machine drops are rejected; remote work environments are not moved. Each machine heading has its own add-group button. Groups belong to a machine, and different machines may use the same group name. Legacy groups without a machine are treated as local, preserving existing data; collapse state is separate for each machine.
- Retains the original worktree ordering. Parent and child spaces keep tree indentation when in the same group; spaces in different groups are displayed independently.
- Full drag auto-scroll, release outside the window, and keyboard dragging are not implemented.
- Runs Git queries, watches local Git directories, and queries machine status. Remote queries may use existing connections. Retains the original machine headings, connection status, reconnect flow after a machine rebuild, and controls for creating a space on a specific machine.

## Files and Development

Runtime files are `main.js`, `mod.json`, and `trash.svg` under `mods/spaces-grouped/`. Local editor helpers `jsconfig.json` and `gpui-kit.d.ts` are not needed for distribution.

[RECIPE.md](RECIPE.md) documents rebuilding and acceptance criteria; it is not a passed-test report. Initial mod checks and simulated tests do not replace real pointer testing.

## Disable

Change `"mod": "spaces-grouped"` back to `"mod": "spaces"` in your personal layout. Keep the mod and saved group data for later use.
