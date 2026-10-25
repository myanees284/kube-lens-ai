import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config/env.ts";
import { validEnv } from "./helpers.ts";

describe("loadConfig", () => {
  it("applies local defaults for optional settings", () => {
    const config = loadConfig(validEnv());

    expect(config.appHost).toBe("127.0.0.1");
    expect(config.appPort).toBe(3001);
    expect(config.frontendOrigin).toBe("http://127.0.0.1:5173");
    expect(config.embeddingModel).toBe("all-MiniLM-L6-v2");
    expect(config.embeddingDimensions).toBe(384);
    expect(config.maxTimelineEvents).toBe(100);
    expect(config.mongodbDatabase).toBe("k8s_KBase");
    expect(config.ragRrfK).toBe(60);
    expect(config.ragIncidentMinScore).toBeNull();
    expect(config.defaultNamespace).toBeNull();
  });

  it("lists every missing required value and does not echo secrets", () => {
    const secret = "super-secret-groq-value";

    expect(() =>
      loadConfig(
        validEnv({
          APP_API_KEY: undefined,
          GROQ_API_KEY: secret,
          MONGODB_URI: "http://user:SuperSecretPassword@example",
        }),
      ),
    ).toThrow(ConfigError);

    try {
      loadConfig(
        validEnv({
          APP_API_KEY: undefined,
          GROQ_API_KEY: secret,
          MONGODB_URI: "http://user:SuperSecretPassword@example",
        }),
      );
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const message = error instanceof Error ? error.message : "";
      expect(message).toContain("APP_API_KEY");
      expect(message).toContain("MONGODB_URI");
      expect(message).not.toContain(secret);
      expect(message).not.toContain("SuperSecretPassword");
    }
  });

  it("rejects example placeholders", () => {
    expect(() =>
      loadConfig(validEnv({ APP_API_KEY: "replace-with-a-local-api-key" })),
    ).toThrow(/placeholder/);
  });
});
