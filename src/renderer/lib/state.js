// SPDX-License-Identifier: MIT OR Apache-2.0
// A small observable store and an event emitter for the renderer.

export class Emitter {
  constructor() {
    this.listeners = new Map();
  }
  on(name, fn) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(fn);
    return () => this.off(name, fn);
  }
  off(name, fn) {
    this.listeners.get(name)?.delete(fn);
  }
  emit(name, ...args) {
    for (const fn of [...(this.listeners.get(name) ?? [])]) {
      try {
        fn(...args);
      } catch (err) {
        console.error(`listener for ${name} failed`, err);
      }
    }
  }
}

/** Keyed state: `set('queue', q)` notifies subscribers of `queue`. */
export class Store extends Emitter {
  constructor(initial = {}) {
    super();
    this.state = { ...initial };
  }
  get(key) {
    return this.state[key];
  }
  set(key, value) {
    this.state[key] = value;
    this.emit(key, value);
  }
  update(key, fn) {
    this.set(key, fn(this.state[key]));
  }
  /** Subscribes and calls at once with the current value. */
  watch(key, fn) {
    fn(this.state[key]);
    return this.on(key, fn);
  }
}
