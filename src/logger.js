import { mkdir, appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import { redact } from "./utils.js";

export class Logger {
  constructor(file = "") {
    this.file = file;
  }

  async write(level, event, payload = {}) {
    const row = {
      ts: new Date().toISOString(),
      level,
      event,
      ...payload,
    };
    const line = redact(JSON.stringify(row));
    if (level === "error") console.error(line);
    else console.log(line);

    if (this.file) {
      await mkdir(dirname(this.file), { recursive: true }).catch(() => {});
      await appendFile(this.file, `${line}\n`, "utf8").catch(() => {});
    }
  }

  info(event, payload) {
    return this.write("info", event, payload);
  }

  warn(event, payload) {
    return this.write("warn", event, payload);
  }

  error(event, payload) {
    return this.write("error", event, payload);
  }
}
