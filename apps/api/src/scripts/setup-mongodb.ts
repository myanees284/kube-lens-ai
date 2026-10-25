import { loadConfig } from "../config/env.ts";
import { closeMongoClient, getDatabase } from "../modules/persistence/client.ts";
import { createInvestigation, getInvestigation } from "../modules/persistence/repositories.ts";
import { ensureKnowledgeBase } from "../modules/persistence/setup.ts";

const config = loadConfig();
const db = getDatabase(config.mongodbUri, config.mongodbDatabase);
await ensureKnowledgeBase(config);
const created = await createInvestigation(db, { question: "phase 2 setup probe", scope: { namespace: "book-prod" } });
const loaded = await getInvestigation(db, created._id.toString());
await db.collection("investigations").deleteOne({ _id: created._id });
if (!loaded || loaded.question !== created.question) {
  throw new Error("Investigation repository probe failed.");
}
await closeMongoClient();
process.stdout.write(`Knowledge base ready in ${config.mongodbDatabase}.\n`);
