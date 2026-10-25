import { MongoClient, type Db } from "mongodb";

let client: MongoClient | undefined;

export function getDatabase(uri: string, databaseName: string): Db {
  assertDatabaseName(databaseName);
  if (!client) {
    // One local process and one investigation at a time. The driver default pool is enough.
    // Fail fast when Atlas cannot be selected instead of leaving a request hanging.
    client = new MongoClient(uri, { serverSelectionTimeoutMS: 10_000 });
  }
  return client.db(databaseName);
}

export async function closeMongoClient(): Promise<void> {
  await client?.close();
  client = undefined;
}

export function assertDatabaseName(databaseName: string): void {
  if (databaseName === "sample_mflix" || databaseName === "admin" || databaseName === "local") {
    throw new Error(`Refusing to use the ${databaseName} database. Set MONGODB_DATABASE=k8s_KBase.`);
  }
}
