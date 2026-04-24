import { describe, it, expect } from "vitest";
import { parseEnv, generateEnvExample } from "../src/parsers/env";

describe("env parser", () => {
  describe("dbt convention", () => {
    it("should parse simple key-value pairs", () => {
      const envVars = {
        SERVER__PORT: "3000",
        SERVER__HOST: "localhost",
      };

      const result = parseEnv(envVars, { convention: "dbt" });

      expect(result._tag).toBe("Ok");
      if (result._tag === "Ok") {
        expect(result.value).toEqual({
          server: {
            port: 3000,
            host: "localhost",
          },
        });
      }
    });

    it("should handle nested structures", () => {
      const envVars = {
        DATABASE__CONNECTION__HOST: "localhost",
        DATABASE__CONNECTION__PORT: "5432",
        DATABASE__CONNECTION__SSL: "true",
      };

      const result = parseEnv(envVars, { convention: "dbt" });

      expect(result._tag).toBe("Ok");
      if (result._tag === "Ok") {
        expect(result.value).toEqual({
          database: {
            connection: {
              host: "localhost",
              port: 5432,
              ssl: true,
            },
          },
        });
      }
    });

    it("should convert SCREAMING_SNAKE to camelCase", () => {
      const envVars = {
        API__RATE_LIMIT__MAX_REQUESTS: "100",
        API__RATE_LIMIT__TIME_WINDOW: "60000",
      };

      const result = parseEnv(envVars, { convention: "dbt" });

      expect(result._tag).toBe("Ok");
      if (result._tag === "Ok") {
        expect(result.value).toEqual({
          api: {
            rateLimit: {
              maxRequests: 100,
              timeWindow: 60000,
            },
          },
        });
      }
    });

    it("should handle arrays with numeric indices", () => {
      const envVars = {
        CORS__ORIGINS__0: "http://localhost:3000",
        CORS__ORIGINS__1: "https://example.com",
        CORS__ORIGINS__2: "https://api.example.com",
      };

      const result = parseEnv(envVars, { convention: "dbt" });

      expect(result._tag).toBe("Ok");
      if (result._tag === "Ok") {
        expect(result.value).toEqual({
          cors: {
            origins: ["http://localhost:3000", "https://example.com", "https://api.example.com"],
          },
        });
      }
    });

    it("should parse different value types correctly", () => {
      const envVars = {
        FEATURES__ENABLED: "true",
        FEATURES__DISABLED: "false",
        FEATURES__COUNT: "42",
        FEATURES__RATIO: "3.14",
        FEATURES__NAME: "test",
        FEATURES__EMPTY: "",
        FEATURES__NULL_VALUE: "null",
        FEATURES__UNDEFINED_VALUE: "undefined",
      };

      const result = parseEnv(envVars, { convention: "dbt" });

      expect(result._tag).toBe("Ok");
      if (result._tag === "Ok") {
        expect(result.value).toEqual({
          features: {
            enabled: true,
            disabled: false,
            count: 42,
            ratio: 3.14,
            name: "test",
            empty: "",
            nullValue: null,
            undefinedValue: undefined,
          },
        });
      }
    });

    it("should handle prefix filtering", () => {
      const envVars = {
        APP_SERVER__PORT: "3000",
        APP_SERVER__HOST: "localhost",
        OTHER_VALUE: "ignored",
      };

      const result = parseEnv(envVars, { convention: "dbt", prefix: "APP_" });

      expect(result._tag).toBe("Ok");
      if (result._tag === "Ok") {
        expect(result.value).toEqual({
          server: {
            port: 3000,
            host: "localhost",
          },
        });
      }
    });

    it("should handle negative numbers", () => {
      const envVars = {
        LIMITS__MIN: "-100",
        LIMITS__MAX: "100",
        LIMITS__THRESHOLD: "-0.5",
      };

      const result = parseEnv(envVars, { convention: "dbt" });

      expect(result._tag).toBe("Ok");
      if (result._tag === "Ok") {
        expect(result.value).toEqual({
          limits: {
            min: -100,
            max: 100,
            threshold: -0.5,
          },
        });
      }
    });

    it("should handle sparse arrays", () => {
      const envVars = {
        ITEMS__0: "first",
        ITEMS__2: "third",
        ITEMS__5: "sixth",
      };

      const result = parseEnv(envVars, { convention: "dbt" });

      expect(result._tag).toBe("Ok");
      if (result._tag === "Ok") {
        const value = result.value as { items: unknown[] };
        expect(value.items[0]).toBe("first");
        expect(value.items[1]).toBe(undefined);
        expect(value.items[2]).toBe("third");
        expect(value.items[5]).toBe("sixth");
      }
    });

    it("should handle mixed object and array nesting", () => {
      const envVars = {
        CONFIG__SERVERS__0__HOST: "server1.com",
        CONFIG__SERVERS__0__PORT: "8080",
        CONFIG__SERVERS__1__HOST: "server2.com",
        CONFIG__SERVERS__1__PORT: "8081",
      };

      const result = parseEnv(envVars, { convention: "dbt" });

      expect(result._tag).toBe("Ok");
      if (result._tag === "Ok") {
        expect(result.value).toEqual({
          config: {
            servers: [
              { host: "server1.com", port: 8080 },
              { host: "server2.com", port: 8081 },
            ],
          },
        });
      }
    });

    it("should ignore undefined values", () => {
      const envVars = {
        DEFINED: "value",
        UNDEFINED: undefined,
      } as NodeJS.ProcessEnv;

      const result = parseEnv(envVars, { convention: "dbt" });

      expect(result._tag).toBe("Ok");
      if (result._tag === "Ok") {
        expect(result.value).toEqual({
          defined: "value",
        });
      }
    });
  });

  describe("flat convention", () => {
    it("should parse flat key-value pairs", () => {
      const envVars = {
        SERVER_PORT: "3000",
        SERVER_HOST: "localhost",
        DATABASE_URL: "postgres://localhost/db",
      };

      const result = parseEnv(envVars, { convention: "flat" });

      expect(result._tag).toBe("Ok");
      if (result._tag === "Ok") {
        expect(result.value).toEqual({
          serverPort: 3000,
          serverHost: "localhost",
          databaseUrl: "postgres://localhost/db",
        });
      }
    });

    it("should handle prefix with flat convention", () => {
      const envVars = {
        APP_PORT: "3000",
        APP_HOST: "localhost",
        OTHER: "ignored",
      };

      const result = parseEnv(envVars, { convention: "flat", prefix: "APP_" });

      expect(result._tag).toBe("Ok");
      if (result._tag === "Ok") {
        expect(result.value).toEqual({
          port: 3000,
          host: "localhost",
        });
      }
    });
  });

  describe("edge cases", () => {
    it("should handle empty env vars", () => {
      const result = parseEnv({}, { convention: "dbt" });

      expect(result._tag).toBe("Ok");
      if (result._tag === "Ok") {
        expect(result.value).toEqual({});
      }
    });

    it("should handle values that look like numbers but aren't", () => {
      const envVars = {
        VALUES__LEADING_ZERO: "0123",
        VALUES__HEX: "0x123",
        VALUES__INFINITY: "Infinity",
        VALUES__NAN: "NaN",
      };

      const result = parseEnv(envVars, { convention: "dbt" });

      expect(result._tag).toBe("Ok");
      if (result._tag === "Ok") {
        expect(result.value).toEqual({
          values: {
            leadingZero: 123, // Parsed as number
            hex: "0x123", // Kept as string
            infinity: "Infinity", // Kept as string
            nan: "NaN", // Kept as string
          },
        });
      }
    });

    it("should handle special characters in values", () => {
      const envVars = {
        CONFIG__URL: "https://example.com?key=value&foo=bar",
        CONFIG__PATH: "/path/to/file.txt",
        CONFIG__REGEX: "^[a-z]+$",
        CONFIG__JSON: '{"key":"value"}',
      };

      const result = parseEnv(envVars, { convention: "dbt" });

      expect(result._tag).toBe("Ok");
      if (result._tag === "Ok") {
        expect(result.value).toEqual({
          config: {
            url: "https://example.com?key=value&foo=bar",
            path: "/path/to/file.txt",
            regex: "^[a-z]+$",
            json: '{"key":"value"}',
          },
        });
      }
    });
  });

  describe("generateEnvExample", () => {
    it("should generate example with dbt convention", () => {
      const paths = [
        { path: "server.port", type: "number", required: true, defaultValue: 3000 },
        { path: "server.host", type: "string", required: false, defaultValue: "localhost" },
        { path: "database.url", type: "string", required: true },
      ];

      const example = generateEnvExample(paths, { convention: "dbt" });

      expect(example).toContain("SERVER__PORT=3000");
      expect(example).toContain("SERVER__HOST=localhost");
      expect(example).toContain("DATABASE__URL=");
      expect(example).toContain("# server.port: number (required)");
    });

    it("should handle prefix in generated example", () => {
      const paths = [{ path: "port", type: "number", required: true, defaultValue: 3000 }];

      const example = generateEnvExample(paths, { convention: "dbt", prefix: "APP_" });

      expect(example).toContain("APP_PORT=3000");
      expect(example).toContain("# Prefix: APP_");
    });
  });
});
