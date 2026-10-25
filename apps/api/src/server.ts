import { buildApp } from "./app.ts";
import { ConfigError, loadConfig, type AppConfig } from "./config/env.ts";
import { safeErrorMessage } from "./modules/evidence/sanitize.ts";
import { createLiveInvestigationApi } from "./modules/investigation/live.ts";
import { closeMongoClient, getDatabase } from "./modules/persistence/client.ts";
import { failInterruptedInvestigations } from "./modules/persistence/repositories.ts";

function readConfig(): AppConfig {
  try {
    return loadConfig();
  } catch (error) {
    const message = error instanceof ConfigError ? error.message : "Configuration failed.";
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}

const config = readConfig();
const database = getDatabase(config.mongodbUri, config.mongodbDatabase);
try {
  await database.command({ ping: 1 });
  await failInterruptedInvestigations(database);
} catch (error) {
  process.stderr.write(`MongoDB is not ready. ${safeErrorMessage(error)}\n`);
  process.exit(1);
}
const app = buildApp(config, { api: createLiveInvestigationApi(config, database) });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void app.close().then(async () => {
      await closeMongoClient();
      process.exit(0);
    });
  });
}

try {
  await app.listen({ host: config.appHost, port: config.appPort });
} catch (error) {
  app.log.error({ err: error }, "backend failed to start");
  process.exit(1);
}
