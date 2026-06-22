import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const EMPTY_STATE = {
  processed: {},
  answers: [],
  counters: {
    ticks: 0,
    analyzed: 0,
    replied: 0,
    skipped: 0,
    errors: 0,
  },
};

export class StateStore {
  constructor(file) {
    this.file = file;
    this.state = structuredClone(EMPTY_STATE);
  }

  async load() {
    try {
      const raw = await readFile(this.file, "utf8");
      const parsed = JSON.parse(raw);
      this.state = {
        ...structuredClone(EMPTY_STATE),
        ...parsed,
        counters: { ...EMPTY_STATE.counters, ...(parsed.counters || {}) },
      };
    } catch {
      this.state = structuredClone(EMPTY_STATE);
    }
    return this.state;
  }

  async save() {
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
  }

  hasProcessed(key) {
    return Boolean(this.state.processed[key]);
  }

  async markProcessed(key, meta = {}) {
    this.state.processed[key] = { at: new Date().toISOString(), ...meta };
    await this.save();
  }

  async recordAnswer(entry) {
    this.state.answers.push({ at: new Date().toISOString(), ...entry });
    if (this.state.answers.length > 1000) this.state.answers = this.state.answers.slice(-1000);
    await this.save();
  }

  async increment(name, delta = 1) {
    this.state.counters[name] = (this.state.counters[name] || 0) + delta;
    await this.save();
  }

  snapshot() {
    return this.state;
  }
}
