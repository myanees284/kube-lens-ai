import path from "node:path";
import { fileURLToPath } from "node:url";

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
  modelId(): string;
  dimensions(): number;
}

type FeatureExtractor = (
  texts: string[],
  options: { pooling: "mean"; normalize: true },
) => Promise<{ tolist: () => number[][] }>;

const modelRepos: Record<string, string> = {
  "all-MiniLM-L6-v2": "onnx-community/all-MiniLM-L6-v2-ONNX",
};

export async function createLocalEmbeddingProvider(input: {
  model: string;
  dimensions: number;
}): Promise<EmbeddingProvider> {
  const repo = modelRepos[input.model] ?? input.model;
  const transformers = await import("@huggingface/transformers");
  const cacheDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../.transformers-cache");
  transformers.env.cacheDir = cacheDir;
  let extractor: FeatureExtractor | undefined;

  return {
    modelId: () => input.model,
    dimensions: () => input.dimensions,
    async embed(texts: string[]) {
      extractor ??= (await transformers.pipeline("feature-extraction", repo)) as FeatureExtractor;
      const output = await extractor(texts, { pooling: "mean", normalize: true });
      const vectors = output.tolist() as number[][];
      for (const vector of vectors) {
        if (vector.length !== input.dimensions) {
          throw new Error(
            `Embedding length ${vector.length} does not match EMBEDDING_DIMENSIONS ${input.dimensions} for ${input.model}.`,
          );
        }
      }
      return vectors;
    },
  };
}
