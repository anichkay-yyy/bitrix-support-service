import { loadConfig } from "./config.js";
import { Logger } from "./logger.js";
import { StateStore } from "./state.js";
import { BitrixClient } from "./bitrix.js";
import { OrderStatusClient } from "./order-status.js";
import { KbClient } from "./kb.js";
import { LlmClient } from "./llm.js";
import { SupportFlow } from "./flow.js";
import { StandaloneServer } from "./server.js";

const config = loadConfig();
const logger = new Logger(config.logFile);
const state = new StateStore(config.stateFile);
await state.load();

const bitrix = new BitrixClient(config, logger);
const orderStatusClient = new OrderStatusClient(config);
const kbClient = new KbClient(config, logger);
const llmClient = new LlmClient(config);
const flow = new SupportFlow({ config, logger, state, bitrix, orderStatusClient, kbClient, llmClient });
const server = new StandaloneServer({ config, logger, state, flow });

await server.start();

async function shutdown(signal) {
  await logger.info("service.stopping", { signal }).catch(() => {});
  await server.stop().catch(() => {});
  process.exit(0);
}

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
