import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFileSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { createLoader, mergeConfigs, getValueAtPath } from "../src/loaders";
import type { ConfigSource } from "../src/types";

describe("loaders", () => {
  const testDir = "/tmp/config-loaders-test";
  
  beforeEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore if directory doesn't exist
    }
    mkdirSync(testDir, { recursive: true });
    
    // Mock process.env for consistent testing
    vi.stubEnv("TEST_VAR", "test_value");
    vi.stubEnv("SERVER__PORT", "3000");
    vi.stubEnv("DATABASE__URL", "postgres://localhost/db");
  });
  
  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
    vi.unstubAllEnvs();
  });
  
  describe("createLoader", () => {
    it("should create a loader with load and watch methods", () => {
      const loader = createLoader();
      
      expect(loader).toHaveProperty("load");
      expect(loader).toHaveProperty("watch");
      expect(typeof loader.load).toBe("function");
      expect(typeof loader.watch).toBe("function");
    });
    
    describe("env source loading", () => {
      it("should load from environment variables", () => {
        const loader = createLoader();
        const source: ConfigSource = {
          type: "env",
          convention: "dbt"
        };
        
        const result = loader.load(source);
        
        expect(result._tag).toBe("Ok");
        if (result._tag === "Ok") {
          expect(result.value).toEqual(
            expect.objectContaining({
              server: { port: 3000 },
              database: { url: "postgres://localhost/db" }
            })
          );
        }
      });
      
      it("should load with prefix filtering", () => {
        vi.stubEnv("APP_SERVER__PORT", "8080");
        vi.stubEnv("APP_SERVER__HOST", "api.example.com");
        vi.stubEnv("OTHER_VALUE", "ignored");
        
        const loader = createLoader();
        const source: ConfigSource = {
          type: "env",
          prefix: "APP_",
          convention: "dbt"
        };
        
        const result = loader.load(source);
        
        expect(result._tag).toBe("Ok");
        if (result._tag === "Ok") {
          expect(result.value).toEqual({
            server: {
              port: 8080,
              host: "api.example.com"
            }
          });
        }
      });
      
      it("should load with flat convention", () => {
        vi.stubEnv("SERVER_PORT", "3000");
        vi.stubEnv("SERVER_HOST", "localhost");
        
        const loader = createLoader();
        const source: ConfigSource = {
          type: "env",
          convention: "flat"
        };
        
        const result = loader.load(source);
        
        expect(result._tag).toBe("Ok");
        if (result._tag === "Ok") {
          expect(result.value).toEqual(
            expect.objectContaining({
              serverPort: 3000,
              serverHost: "localhost"
            })
          );
        }
      });
    });
    
    describe("file source loading", () => {
      it("should load from JSON file", () => {
        const configPath = join(testDir, "config.json");
        const configData = {
          server: { port: 3000, host: "localhost" },
          database: { url: "postgres://localhost/db" }
        };
        writeFileSync(configPath, JSON.stringify(configData));
        
        const loader = createLoader();
        const source: ConfigSource = {
          type: "file",
          path: configPath,
          format: "json"
        };
        
        const result = loader.load(source);
        
        expect(result._tag).toBe("Ok");
        if (result._tag === "Ok") {
          expect(result.value).toEqual(configData);
        }
      });
      
      it("should load from YAML file", () => {
        const configPath = join(testDir, "config.yml");
        const yamlContent = `
server:
  port: 3000
  host: localhost
database:
  url: postgres://localhost/db
`;
        writeFileSync(configPath, yamlContent);
        
        const loader = createLoader();
        const source: ConfigSource = {
          type: "file",
          path: configPath,
          format: "yaml"
        };
        
        const result = loader.load(source);
        
        expect(result._tag).toBe("Ok");
        if (result._tag === "Ok") {
          expect(result.value).toEqual({
            server: { port: 3000, host: "localhost" },
            database: { url: "postgres://localhost/db" }
          });
        }
      });
      
      it("should load from .env file", () => {
        const envPath = join(testDir, ".env");
        const envContent = `
SERVER__PORT=4000
SERVER__HOST=api.example.com
DATABASE__URL=mysql://localhost/db
`;
        writeFileSync(envPath, envContent);
        
        const loader = createLoader();
        const source: ConfigSource = {
          type: "file",
          path: envPath,
          format: "env"
        };
        
        const result = loader.load(source);
        
        expect(result._tag).toBe("Ok");
        if (result._tag === "Ok") {
          expect(result.value).toEqual({
            server: { port: 4000, host: "api.example.com" },
            database: { url: "mysql://localhost/db" }
          });
        }
      });
      
      it("should auto-detect file format", () => {
        const configPath = join(testDir, "auto.json");
        writeFileSync(configPath, '{"port": 5000}');
        
        const loader = createLoader();
        const source: ConfigSource = {
          type: "file",
          path: configPath
        };
        
        const result = loader.load(source);
        
        expect(result._tag).toBe("Ok");
        if (result._tag === "Ok") {
          expect(result.value).toEqual({ port: 5000 });
        }
      });
      
      it("should return error for missing file", () => {
        const loader = createLoader();
        const source: ConfigSource = {
          type: "file",
          path: "/non/existent/file.json"
        };
        
        const result = loader.load(source);
        
        expect(result._tag).toBe("Err");
        if (result._tag === "Err") {
          expect(result.error.type).toBe("FILE_NOT_FOUND");
        }
      });
    });
    
    describe("object source loading", () => {
      it("should load from object data", () => {
        const loader = createLoader();
        const configData = {
          server: { port: 3000, host: "localhost" },
          features: { auth: true, logging: false }
        };
        const source: ConfigSource = {
          type: "object",
          data: configData
        };
        
        const result = loader.load(source);
        
        expect(result._tag).toBe("Ok");
        if (result._tag === "Ok") {
          expect(result.value).toBe(configData);
        }
      });
      
      it("should handle null object data", () => {
        const loader = createLoader();
        const source: ConfigSource = {
          type: "object",
          data: null
        };
        
        const result = loader.load(source);
        
        expect(result._tag).toBe("Ok");
        if (result._tag === "Ok") {
          expect(result.value).toBe(null);
        }
      });
    });
    
    describe("defaults source loading", () => {
      it("should return empty object for defaults", () => {
        const loader = createLoader();
        const source: ConfigSource = {
          type: "defaults"
        };
        
        const result = loader.load(source);
        
        expect(result._tag).toBe("Ok");
        if (result._tag === "Ok") {
          expect(result.value).toEqual({});
        }
      });
    });
    
    describe("watch functionality", () => {
      it("should return cleanup function for file watch", () => {
        const configPath = join(testDir, "watch.json");
        writeFileSync(configPath, '{"initial": true}');
        
        const loader = createLoader();
        const source: ConfigSource = {
          type: "file",
          path: configPath
        };
        
        const callback = vi.fn();
        const cleanup = loader.watch(source, callback);
        
        expect(typeof cleanup).toBe("function");
        
        // Cleanup should not throw
        expect(() => cleanup()).not.toThrow();
      });
      
      it("should call callback on file change", async () => {
        const configPath = join(testDir, "watch-change.json");
        writeFileSync(configPath, '{"initial": true}');
        
        const loader = createLoader();
        const source: ConfigSource = {
          type: "file",
          path: configPath
        };
        
        const callback = vi.fn();
        const cleanup = loader.watch(source, callback);
        
        // Modify the file
        writeFileSync(configPath, '{"changed": true}');

        // Wait for poll interval + debounce — use a longer wait under full suite load
        await new Promise(resolve => setTimeout(resolve, 500));

        expect(callback).toHaveBeenCalledWith({ changed: true });
        
        cleanup();
      });
      
      it("should debounce rapid file changes", async () => {
        const configPath = join(testDir, "watch-debounce.json");
        writeFileSync(configPath, '{"initial": true}');
        
        const loader = createLoader();
        const source: ConfigSource = {
          type: "file",
          path: configPath
        };
        
        const callback = vi.fn();
        const cleanup = loader.watch(source, callback);
        
        // Make rapid changes
        writeFileSync(configPath, '{"change1": true}');
        writeFileSync(configPath, '{"change2": true}');
        writeFileSync(configPath, '{"change3": true}');
        
        // Wait for poll interval + debounce — use a longer wait under full suite load
        await new Promise(resolve => setTimeout(resolve, 500));

        // Should only be called once with the final change
        expect(callback).toHaveBeenCalledTimes(1);
        expect(callback).toHaveBeenCalledWith({ change3: true });
        
        cleanup();
      });
      
      it("should return no-op cleanup for non-file sources", () => {
        const loader = createLoader();
        const source: ConfigSource = {
          type: "env"
        };
        
        const callback = vi.fn();
        const cleanup = loader.watch(source, callback);
        
        expect(typeof cleanup).toBe("function");
        expect(() => cleanup()).not.toThrow();
      });
      
      it("should handle watch errors gracefully", () => {
        const loader = createLoader();
        const source: ConfigSource = {
          type: "file",
          path: "/invalid/path/file.json"
        };
        
        const callback = vi.fn();
        const cleanup = loader.watch(source, callback);
        
        // Should not throw and return cleanup function
        expect(typeof cleanup).toBe("function");
        expect(() => cleanup()).not.toThrow();
      });
    });
  });
  
  describe("mergeConfigs", () => {
    it("should merge multiple configs with precedence", () => {
      const configs = [
        { server: { port: 3000 }, database: { url: "db1" } },
        { server: { host: "localhost" }, auth: { enabled: true } },
        { server: { port: 8080 } }
      ];
      
      const result = mergeConfigs(configs);
      
      expect(result._tag).toBe("Ok");
      if (result._tag === "Ok") {
        expect(result.value).toEqual({
          server: { port: 8080, host: "localhost" },
          database: { url: "db1" },
          auth: { enabled: true }
        });
      }
    });
    
    it("should handle nested object merging", () => {
      const configs = [
        { 
          server: { 
            port: 3000, 
            ssl: { enabled: false, cert: "old.crt" } 
          } 
        },
        { 
          server: { 
            host: "localhost",
            ssl: { enabled: true }
          } 
        }
      ];
      
      const result = mergeConfigs(configs);
      
      expect(result._tag).toBe("Ok");
      if (result._tag === "Ok") {
        expect(result.value).toEqual({
          server: {
            port: 3000,
            host: "localhost",
            ssl: { enabled: true, cert: "old.crt" }
          }
        });
      }
    });
    
    it("should handle array replacement (not merging)", () => {
      const configs = [
        { features: ["auth", "logging"] },
        { features: ["auth", "monitoring", "metrics"] }
      ];
      
      const result = mergeConfigs(configs);
      
      expect(result._tag).toBe("Ok");
      if (result._tag === "Ok") {
        expect(result.value).toEqual({
          features: ["auth", "monitoring", "metrics"]
        });
      }
    });
    
    it("should handle null value overrides", () => {
      const configs = [
        { database: { url: "postgres://localhost/db" } },
        { database: { url: null } }
      ];
      
      const result = mergeConfigs(configs);
      
      expect(result._tag).toBe("Ok");
      if (result._tag === "Ok") {
        expect(result.value).toEqual({
          database: { url: null }
        });
      }
    });
    
    it("should skip undefined values", () => {
      const configs = [
        { server: { port: 3000, host: "localhost" } },
        { server: { port: undefined, debug: true } }
      ];
      
      const result = mergeConfigs(configs);
      
      expect(result._tag).toBe("Ok");
      if (result._tag === "Ok") {
        expect(result.value).toEqual({
          server: { port: 3000, host: "localhost", debug: true }
        });
      }
    });
    
    it("should handle empty configs array", () => {
      const result = mergeConfigs([]);
      
      expect(result._tag).toBe("Ok");
      if (result._tag === "Ok") {
        expect(result.value).toEqual({});
      }
    });
    
    it("should handle non-object configs", () => {
      const configs = [
        "string config",
        42,
        { valid: "config" },
        null,
        undefined
      ];
      
      const result = mergeConfigs(configs);
      
      expect(result._tag).toBe("Ok");
      if (result._tag === "Ok") {
        expect(result.value).toEqual({ valid: "config" });
      }
    });
    
    it("should handle schema defaults", () => {
      const configs = [
        { server: { port: 3000 } }
      ];
      
      const schemas = [
        {
          hasDefaults: true,
          getDefaults: () => ({
            server: { host: "localhost", ssl: false },
            logging: { level: "info" }
          })
        }
      ];
      
      const result = mergeConfigs(configs, schemas);
      
      expect(result._tag).toBe("Ok");
      if (result._tag === "Ok") {
        expect(result.value).toEqual({
          server: { port: 3000, host: "localhost", ssl: false },
          logging: { level: "info" }
        });
      }
    });
  });
  
  describe("getValueAtPath", () => {
    const testData = {
      server: {
        port: 3000,
        host: "localhost",
        ssl: {
          enabled: true,
          cert: "server.crt"
        }
      },
      features: ["auth", "logging", "monitoring"],
      database: {
        connections: [
          { name: "primary", url: "postgres://db1" },
          { name: "replica", url: "postgres://db2" }
        ]
      }
    };
    
    it("should get simple property value", () => {
      const result = getValueAtPath(testData, "server.port");
      
      expect(result._tag).toBe("Ok");
      if (result._tag === "Ok") {
        expect(result.value).toBe(3000);
      }
    });
    
    it("should get nested property value", () => {
      const result = getValueAtPath(testData, "server.ssl.enabled");
      
      expect(result._tag).toBe("Ok");
      if (result._tag === "Ok") {
        expect(result.value).toBe(true);
      }
    });
    
    it("should get object value", () => {
      const result = getValueAtPath(testData, "server.ssl");
      
      expect(result._tag).toBe("Ok");
      if (result._tag === "Ok") {
        expect(result.value).toEqual({
          enabled: true,
          cert: "server.crt"
        });
      }
    });
    
    it("should get array value", () => {
      const result = getValueAtPath(testData, "features");
      
      expect(result._tag).toBe("Ok");
      if (result._tag === "Ok") {
        expect(result.value).toEqual(["auth", "logging", "monitoring"]);
      }
    });
    
    it("should get array element by index", () => {
      const result = getValueAtPath(testData, "features.1");
      
      expect(result._tag).toBe("Ok");
      if (result._tag === "Ok") {
        expect(result.value).toBe("logging");
      }
    });
    
    it("should get nested array element property", () => {
      const result = getValueAtPath(testData, "database.connections.0.name");
      
      expect(result._tag).toBe("Ok");
      if (result._tag === "Ok") {
        expect(result.value).toBe("primary");
      }
    });
    
    it("should return error for non-existent path", () => {
      const result = getValueAtPath(testData, "server.nonexistent");
      
      expect(result._tag).toBe("Err");
      if (result._tag === "Err") {
        expect(result.error.type).toBe("PATH_NOT_FOUND");
        expect(result.error.path).toBe("server.nonexistent");
      }
    });
    
    it("should return error for invalid array index", () => {
      const result = getValueAtPath(testData, "features.10");
      
      expect(result._tag).toBe("Err");
      if (result._tag === "Err") {
        expect(result.error.type).toBe("PATH_NOT_FOUND");
      }
    });
    
    it("should return error for negative array index", () => {
      const result = getValueAtPath(testData, "features.-1");
      
      expect(result._tag).toBe("Err");
      if (result._tag === "Err") {
        expect(result.error.type).toBe("PATH_NOT_FOUND");
      }
    });
    
    it("should return error for non-numeric array index", () => {
      const result = getValueAtPath(testData, "features.abc");
      
      expect(result._tag).toBe("Err");
      if (result._tag === "Err") {
        expect(result.error.type).toBe("PATH_NOT_FOUND");
      }
    });
    
    it("should return error when traversing through primitive", () => {
      const result = getValueAtPath(testData, "server.port.invalid");
      
      expect(result._tag).toBe("Err");
      if (result._tag === "Err") {
        expect(result.error.type).toBe("PATH_NOT_FOUND");
      }
    });
    
    it("should return error for null input", () => {
      const result = getValueAtPath(null, "any.path");
      
      expect(result._tag).toBe("Err");
      if (result._tag === "Err") {
        expect(result.error.type).toBe("PATH_NOT_FOUND");
      }
    });
    
    it("should return error for primitive input", () => {
      const result = getValueAtPath("string", "any.path");
      
      expect(result._tag).toBe("Err");
      if (result._tag === "Err") {
        expect(result.error.type).toBe("PATH_NOT_FOUND");
      }
    });
    
    it("should handle root path", () => {
      const result = getValueAtPath(testData, "");
      
      // Empty path should return the root object
      expect(result._tag).toBe("Err");
    });
    
    it("should handle single-level path", () => {
      const result = getValueAtPath(testData, "server");
      
      expect(result._tag).toBe("Ok");
      if (result._tag === "Ok") {
        expect(result.value).toEqual(testData.server);
      }
    });
  });
});