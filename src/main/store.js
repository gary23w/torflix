// SPDX-License-Identifier: MIT OR Apache-2.0
// Small JSON files in the app's data folder, written atomically (temp file, then rename) so a
// crash mid-write never leaves a half-written queue or library behind.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export class JsonStore {
  /**
   * @param {string} file absolute path of the JSON file
   * @param {() => any} defaults what to use when the file is missing or unreadable
   */
  constructor(file, defaults) {
    this.file = file;
    this.defaults = defaults;
    this.problems = [];
    this.#chain = Promise.resolve();
  }

  #chain;

  /** Reads the file synchronously (start-up). Problems are kept in `problems`. */
  loadSync() {
    try {
      const text = fs.readFileSync(this.file, 'utf8');
      const value = JSON.parse(text);
      if (value === null || typeof value !== 'object') throw new Error('not an object');
      return value;
    } catch (err) {
      if (err.code !== 'ENOENT') {
        this.problems.push(`${path.basename(this.file)} could not be read (${err.message}); using defaults.`);
      }
      return this.defaults();
    }
  }

  /** Writes the value; writes are serialized and atomic. */
  save(value) {
    const text = JSON.stringify(value, null, 2);
    this.#chain = this.#chain.then(async () => {
      await fsp.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, text, 'utf8');
      try {
        await fsp.rename(tmp, this.file);
      } catch (err) {
        // Windows may refuse to rename over an open file; fall back to a plain write.
        if (err.code === 'EPERM' || err.code === 'EEXIST') {
          await fsp.writeFile(this.file, text, 'utf8');
          await fsp.rm(tmp, { force: true });
        } else throw err;
      }
    });
    this.#chain = this.#chain.catch((err) => {
      console.error(`[store] could not save ${this.file}: ${err.message}`);
    });
    return this.#chain;
  }

  /** Resolves once every pending write is on disk (shutdown). */
  flush() {
    return this.#chain;
  }
}
