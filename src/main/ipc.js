// SPDX-License-Identifier: MIT OR Apache-2.0
//
// The Electron side of the commands in commands.js: each one is served over IPC to the app's
// own window, and what the commands need from the platform (folder pickers, opening a folder or
// a link, the version) is done with Electron's dialog, shell and app.

import { ipcMain, dialog, shell, app } from 'electron';
import { createCommands, invokeCommand } from './commands.js';

/** Serves the commands over Electron IPC, to the app's own window only. */
export function registerIpc(ctx) {
  const { win } = ctx;
  const platform = {
    version: app.getVersion(),
    chooseFolder: async ({ title, create = false }) => {
      const r = await dialog.showOpenDialog(win, { properties: create ? ['openDirectory', 'createDirectory'] : ['openDirectory'], title });
      return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
    },
    openPath: async (dir) => (await shell.openPath(dir)) === '',
    openExternal: (url) => shell.openExternal(url),
  };
  const commands = createCommands(ctx, platform);
  for (const name of Object.keys(commands)) {
    ipcMain.handle(`tp:${name}`, (event, ...args) => {
      if (event.sender !== win.webContents) return { ok: false, error: { kind: 'forbidden', message: 'Not allowed.' } };
      return invokeCommand(commands, name, args);
    });
  }
}
