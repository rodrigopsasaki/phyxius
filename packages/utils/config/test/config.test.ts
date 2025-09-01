import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFileSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { createSystemClock } from "@phyxiusjs/clock";
import { createInMemoryJournal } from "@phyxiusjs/journal";
import { z } from "zod";
import { createConfig } from "../src/config";
import type { ConfigOptions, ConfigEvent } from "../src/types";

describe("config", () => {
  const testDir = "/tmp/config-main-test";
  const clock = createSystemClock();
  const journal = createInMemoryJournal(clock);
  
  beforeEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore if directory doesn't exist
    }
    mkdirSync(testDir, { recursive: true });
    
    // Clear journal
    journal.clear();
    
    // Mock environment variables
    vi.stubEnv("SERVER__PORT", "3000");
    vi.stubEnv("SERVER__HOST", "localhost");
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
  
  describe("createConfig", () => {
    const serverSchema = z.object({
      server: z.object({
        port: z.number(),
        host: z.string()
      }),
      database: z.object({
        url: z.string()
      }).optional()
    });
    
    it("should create config instance with basic functionality", () => {
      const options: ConfigOptions = {
        sources: [{ type: "env", convention: "dbt" }],
        clock,
        environment: "test"
      };
      
      const config = createConfig(serverSchema, options);
      
      expect(config).toHaveProperty("get");
      expect(config).toHaveProperty("getOrDefault");
      expect(config).toHaveProperty("getAll");
      expect(config).toHaveProperty("reload");
      expect(config).toHaveProperty("subscribe");
      expect(config).toHaveProperty("generateExample");
      expect(config).toHaveProperty("getMetadata");
    });
    
    it("should load and validate config from env source", () => {
      const options: ConfigOptions = {
        sources: [{ type: "env", convention: "dbt" }],
        clock,
        environment: "test"
      };
      
      const config = createConfig(serverSchema, options);
      const result = config.getAll();
      
      expect(result._tag).toBe("Ok");
      if (result._tag === "Ok") {
        expect(result.value).toEqual({
          server: {
            port: 3000,
            host: "localhost"
          },
          database: {
            url: "postgres://localhost/db"
          }
        });
      }
    });
    
    it("should load config from file source", () => {
      const configPath = join(testDir, "config.json");
      const configData = {
        server: {
          port: 8080,
          host: "api.example.com"
        }
      };
      writeFileSync(configPath, JSON.stringify(configData));
      
      const options: ConfigOptions = {
        sources: [{ type: "file", path: configPath }],
        clock,
        environment: "test"
      };
      
      const config = createConfig(serverSchema, options);
      const result = config.getAll();
      
      expect(result._tag).toBe("Ok");
      if (result._tag === "Ok") {
        expect(result.value.server.port).toBe(8080);
        expect(result.value.server.host).toBe("api.example.com");
      }
    });
    
    it("should load config from object source", () => {
      const configData = {
        server: {
          port: 4000,
          host: "staging.example.com"
        }
      };
      
      const options: ConfigOptions = {
        sources: [{ type: "object", data: configData }],
        clock,
        environment: "test"
      };
      
      const config = createConfig(serverSchema, options);
      const result = config.getAll();
      
      expect(result._tag).toBe("Ok");
      if (result._tag === "Ok") {
        expect(result.value.server.port).toBe(4000);
        expect(result.value.server.host).toBe("staging.example.com");
      }
    });
    
    it("should merge multiple sources with precedence", () => {
      const configPath = join(testDir, "base.json");
      const baseConfig = {
        server: {
          port: 8080,
          host: "api.example.com"
        },
        database: {
          url: "postgres://prod/db"
        }
      };
      writeFileSync(configPath, JSON.stringify(baseConfig));
      
      const overrideData = {
        server: {
          port: 9000  // Override port only
        }
      };
      
      const options: ConfigOptions = {
        sources: [
          { type: "file", path: configPath },
          { type: "object", data: overrideData }
        ],
        clock,
        environment: "test"
      };
      
      const config = createConfig(serverSchema, options);
      const result = config.getAll();
      
      expect(result._tag).toBe("Ok");
      if (result._tag === "Ok") {
        expect(result.value).toEqual({
          server: {
            port: 9000,  // Overridden
            host: "api.example.com"  // From file
          },
          database: {
            url: "postgres://prod/db"  // From file
          }
        });
      }
    });
    
    it("should handle validation errors", () => {
      const invalidData = {
        server: {
          port: "not-a-number",  // Invalid type
          host: "localhost"
        }
      };
      
      const options: ConfigOptions = {
        sources: [{ type: "object", data: invalidData }],
        clock,
        environment: "test"
      };
      
      const config = createConfig(serverSchema, options);
      const result = config.getAll();
      
      expect(result._tag).toBe("Err");
      if (result._tag === "Err") {
        expect(result.error.type).toBe("VALIDATION_ERROR");
      }
    });
  });
  
  describe("config access methods", () => {
    const schema = z.object({
      server: z.object({
        port: z.number(),
        host: z.string(),
        ssl: z.object({
          enabled: z.boolean(),
          cert: z.string().optional()
        }).optional()
      }),
      features: z.array(z.string()).optional(),
      database: z.object({
        connections: z.array(z.object({
          name: z.string(),
          url: z.string()
        })).optional()
      }).optional()
    });
    
    let config: ReturnType<typeof createConfig<z.infer<typeof schema>>>;
    
    beforeEach(() => {
      const configData = {
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
      
      const options: ConfigOptions = {
        sources: [{ type: "object", data: configData }],
        clock,
        environment: "test"
      };
      
      config = createConfig(schema, options);
    });
    
    describe("get", () => {
      it("should get simple property value", () => {
        const result = config.get("server.port");
        
        expect(result._tag).toBe("Ok");
        if (result._tag === "Ok") {
          expect(result.value).toBe(3000);
        }
      });
      
      it("should get nested property value", () => {
        const result = config.get("server.ssl.enabled");
        
        expect(result._tag).toBe("Ok");
        if (result._tag === "Ok") {
          expect(result.value).toBe(true);
        }
      });
      
      it("should get array element", () => {
        const result = config.get("features.1");
        
        expect(result._tag).toBe("Ok");
        if (result._tag === "Ok") {
          expect(result.value).toBe("logging");
        }
      });
      
      it("should get nested array element property", () => {
        const result = config.get("database.connections.0.name");
        
        expect(result._tag).toBe("Ok");
        if (result._tag === "Ok") {
          expect(result.value).toBe("primary");
        }
      });
      
      it("should return error for non-existent path", () => {
        const result = config.get("server.nonexistent");
        
        expect(result._tag).toBe("Err");
        if (result._tag === "Err") {
          expect(result.error.type).toBe("PATH_NOT_FOUND");
        }
      });
    });
    
    describe("getOrDefault", () => {
      it("should return value when path exists", () => {
        const result = config.getOrDefault("server.port", 8080);
        
        expect(result).toBe(3000);
      });
      
      it("should return default when path does not exist", () => {
        const result = config.getOrDefault("server.timeout", 30000);
        
        expect(result).toBe(30000);
      });
      
      it("should return default when config has errors", () => {
        // Create config with validation error
        const invalidOptions: ConfigOptions = {
          sources: [{ type: "object", data: { server: { port: "invalid" } } }],
          clock,
          environment: "test"
        };
        
        const invalidConfig = createConfig(schema, invalidOptions);
        const result = invalidConfig.getOrDefault("server.port", 8080);
        
        expect(result).toBe(8080);
      });
    });
    
    describe("getAll", () => {
      it("should return entire config object", () => {
        const result = config.getAll();
        
        expect(result._tag).toBe("Ok");
        if (result._tag === "Ok") {
          expect(result.value).toMatchObject({
            server: {
              port: 3000,
              host: "localhost",
              ssl: {
                enabled: true,
                cert: "server.crt"
              }
            },
            features: ["auth", "logging", "monitoring"]
          });
        }
      });
    });
  });
  
  describe("reload functionality", () => {
    it("should reload config and detect changes", () => {
      const configPath = join(testDir, "reload.json");
      const initialConfig = { server: { port: 3000, host: "localhost" } };
      writeFileSync(configPath, JSON.stringify(initialConfig));
      
      const schema = z.object({
        server: z.object({
          port: z.number(),
          host: z.string()
        })
      });
      
      const options: ConfigOptions = {
        sources: [{ type: "file", path: configPath }],
        clock,
        environment: "test",
        journal
      };
      
      const config = createConfig(schema, options);
      
      // Initial load
      let result = config.get("server.port");
      expect(result._tag).toBe("Ok");
      if (result._tag === "Ok") {
        expect(result.value).toBe(3000);
      }
      
      // Update file
      const updatedConfig = { server: { port: 8080, host: "localhost" } };
      writeFileSync(configPath, JSON.stringify(updatedConfig));
      
      // Reload
      const reloadResult = config.reload();
      expect(reloadResult._tag).toBe("Ok");
      
      // Verify change
      result = config.get("server.port");
      expect(result._tag).toBe("Ok");
      if (result._tag === "Ok") {
        expect(result.value).toBe(8080);
      }
    });
    
    it("should emit events on reload", () => {
      const configPath = join(testDir, "events.json");
      writeFileSync(configPath, '{"server": {"port": 3000}}');
      
      const schema = z.object({
        server: z.object({
          port: z.number()
        })
      });
      
      const options: ConfigOptions = {
        sources: [{ type: "file", path: configPath }],
        clock,
        environment: "test",
        journal
      };
      
      const config = createConfig(schema, options);
      
      const events: ConfigEvent[] = [];
      const unsubscribe = config.subscribe((event) => {
        events.push(event);
      });
      
      // Update and reload
      writeFileSync(configPath, '{"server": {"port": 8080}}');
      config.reload();
      
      // Should have CONFIG_RELOADED event
      const reloadEvent = events.find(e => e.type === "CONFIG_RELOADED");
      expect(reloadEvent).toBeDefined();
      
      if (reloadEvent && reloadEvent.type === "CONFIG_RELOADED") {
        expect(reloadEvent.changes).toEqual([
          {
            path: "server.port",
            oldValue: 3000,
            newValue: 8080
          }
        ]);
      }
      
      unsubscribe();
    });
    
    it("should handle reload errors", () => {
      const configPath = join(testDir, "reload-error.json");
      writeFileSync(configPath, '{"server": {"port": 3000}}');
      
      const schema = z.object({
        server: z.object({
          port: z.number()
        })
      });
      
      const options: ConfigOptions = {
        sources: [{ type: "file", path: configPath }],
        clock,
        environment: "test"
      };
      
      const config = createConfig(schema, options);
      
      // Corrupt the file
      writeFileSync(configPath, 'invalid json');
      
      const result = config.reload();
      expect(result._tag).toBe("Err");
      if (result._tag === "Err") {
        expect(result.error.type).toBe("PARSE_ERROR");
      }
    });
  });
  
  describe("watch functionality", () => {
    it("should set up file watching when enabled", () => {
      const configPath = join(testDir, "watch.json");
      writeFileSync(configPath, '{"server": {"port": 3000}}');
      
      const schema = z.object({
        server: z.object({
          port: z.number()
        })
      });
      
      const options: ConfigOptions = {
        sources: [{ type: "file", path: configPath }],
        clock,
        environment: "test",
        watch: true,
        journal
      };
      
      const config = createConfig(schema, options);
      
      const events: ConfigEvent[] = [];
      config.subscribe((event) => {
        events.push(event);
      });
      
      // Should have WATCH_STARTED event
      const watchEvent = events.find(e => e.type === "WATCH_STARTED");
      expect(watchEvent).toBeDefined();
    });
    
    it("should auto-reload on file changes", async () => {
      const configPath = join(testDir, "auto-reload.json");
      writeFileSync(configPath, '{"server": {"port": 3000}}');
      
      const schema = z.object({
        server: z.object({
          port: z.number()
        })
      });
      
      const options: ConfigOptions = {
        sources: [{ type: "file", path: configPath }],
        clock,
        environment: "test",
        watch: true
      };
      
      const config = createConfig(schema, options);
      
      const events: ConfigEvent[] = [];
      config.subscribe((event) => {
        events.push(event);
      });
      
      // Update file
      writeFileSync(configPath, '{"server": {"port": 8080}}');
      
      // Wait for file watcher and debounce
      await new Promise(resolve => setTimeout(resolve, 150));
      
      // Should auto-reload and detect changes
      const result = config.get("server.port");
      expect(result._tag).toBe("Ok");
      if (result._tag === "Ok") {
        expect(result.value).toBe(8080);
      }
      
      // Should have CONFIG_RELOADED event
      const reloadEvent = events.find(e => e.type === "CONFIG_RELOADED");
      expect(reloadEvent).toBeDefined();
    });
  });
  
  describe("event subscription", () => {
    it("should allow subscribing to config events", () => {
      const schema = z.object({
        test: z.boolean().optional()
      });
      
      const options: ConfigOptions = {
        sources: [{ type: "object", data: { test: true } }],
        clock,
        environment: "test",
        journal
      };
      
      const config = createConfig(schema, options);
      
      const events: ConfigEvent[] = [];
      const unsubscribe = config.subscribe((event) => {
        events.push(event);
      });
      
      // Should have initial CONFIG_LOADED event
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("CONFIG_LOADED");
      
      unsubscribe();
      
      // After unsubscribe, no more events should be received
      config.reload();
      expect(events).toHaveLength(1);
    });
    
    it("should handle subscriber errors gracefully", () => {
      const schema = z.object({
        test: z.boolean()
      });
      
      const options: ConfigOptions = {
        sources: [{ type: "object", data: { test: true } }],
        clock,
        environment: "test"
      };
      
      const config = createConfig(schema, options);
      
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      
      // Subscribe with throwing callback
      config.subscribe(() => {
        throw new Error("Subscriber error");
      });
      
      // Subscribe with working callback
      const events: ConfigEvent[] = [];
      config.subscribe((event) => {
        events.push(event);
      });
      
      // Reload should not fail despite error in first subscriber
      const result = config.reload();
      expect(result._tag).toBe("Ok");
      
      // Working subscriber should still receive events
      expect(events.length).toBeGreaterThan(0);
      
      // Error should be logged
      expect(consoleSpy).toHaveBeenCalledWith(
        "Config subscriber error:",
        expect.any(Error)
      );
      
      consoleSpy.mockRestore();
    });
  });
  
  describe("metadata", () => {
    it("should provide config metadata", () => {
      const configPath = join(testDir, "metadata.json");
      writeFileSync(configPath, '{"test": true}');
      
      const schema = z.object({
        test: z.boolean()
      });
      
      const options: ConfigOptions = {
        sources: [
          { type: "file", path: configPath },
          { type: "env", prefix: "APP_" }
        ],
        clock,
        environment: "production",
        watch: true
      };
      
      const config = createConfig(schema, options);
      const metadata = config.getMetadata();
      
      expect(metadata.sources).toHaveLength(2);
      expect(metadata.sources[0]).toEqual({ type: "file", path: configPath });
      expect(metadata.sources[1]).toEqual({ type: "env", prefix: "APP_" });
      expect(metadata.environment).toBe("production");
      expect(metadata.watchEnabled).toBe(true);
      expect(metadata.reloadCount).toBe(0);
      expect(typeof metadata.loadedAt).toBe("number");
    });
    
    it("should update reload count on reload", () => {
      const schema = z.object({
        test: z.boolean()
      });
      
      const options: ConfigOptions = {
        sources: [{ type: "object", data: { test: true } }],
        clock,
        environment: "test"
      };
      
      const config = createConfig(schema, options);
      
      expect(config.getMetadata().reloadCount).toBe(0);
      
      config.reload();
      expect(config.getMetadata().reloadCount).toBe(1);
      
      config.reload();
      expect(config.getMetadata().reloadCount).toBe(2);
    });
  });
  
  describe("generateExample", () => {
    it("should generate environment variable example", () => {
      const schema = z.object({
        server: z.object({
          port: z.number()
        })
      });
      
      const options: ConfigOptions = {
        sources: [{ type: "env", convention: "dbt" }],
        clock,
        environment: "test"
      };
      
      const config = createConfig(schema, options);
      const example = config.generateExample();
      
      // Should be a string (basic smoke test)
      expect(typeof example).toBe("string");
      expect(example).toContain("# Generated environment variable example");
    });
  });
  
  describe("integration scenarios", () => {
    it("should handle complex multi-source configuration", () => {
      // Set up file config
      const configPath = join(testDir, "base.json");
      writeFileSync(configPath, JSON.stringify({
        server: {
          port: 3000,
          host: "localhost",
          ssl: { enabled: false }
        },
        database: {
          url: "postgres://localhost/dev"
        }
      }));
      
      // Set up env overrides
      vi.stubEnv("APP_SERVER__PORT", "8080");
      vi.stubEnv("APP_SERVER__SSL__ENABLED", "true");
      
      const schema = z.object({
        server: z.object({
          port: z.number(),
          host: z.string(),
          ssl: z.object({
            enabled: z.boolean()
          })
        }),
        database: z.object({
          url: z.string()
        })
      });
      
      const options: ConfigOptions = {
        sources: [
          { type: "file", path: configPath },
          { type: "env", prefix: "APP_", convention: "dbt" },
          { type: "object", data: { server: { host: "api.example.com" } } }
        ],
        clock,
        environment: "test",
        journal
      };
      
      const config = createConfig(schema, options);
      const result = config.getAll();
      
      expect(result._tag).toBe("Ok");
      if (result._tag === "Ok") {
        expect(result.value).toEqual({
          server: {
            port: 8080,  // From env
            host: "api.example.com",  // From object (highest precedence)
            ssl: { enabled: true }  // From env
          },
          database: {
            url: "postgres://localhost/dev"  // From file
          }
        });
      }
    });
    
    it("should handle configuration evolution over time", async () => {
      const configPath = join(testDir, "evolution.json");
      writeFileSync(configPath, JSON.stringify({
        version: 1,
        server: { port: 3000 }
      }));
      
      const schema = z.object({
        version: z.number(),
        server: z.object({
          port: z.number(),
          host: z.string().optional()
        })
      });
      
      const options: ConfigOptions = {
        sources: [{ type: "file", path: configPath }],
        clock,
        environment: "test",
        watch: true
      };
      
      const config = createConfig(schema, options);
      const events: ConfigEvent[] = [];
      config.subscribe(event => events.push(event));
      
      // Evolution 1: Add host
      writeFileSync(configPath, JSON.stringify({
        version: 2,
        server: { port: 3000, host: "localhost" }
      }));
      
      await new Promise(resolve => setTimeout(resolve, 150));
      
      // Evolution 2: Change port
      writeFileSync(configPath, JSON.stringify({
        version: 3,
        server: { port: 8080, host: "localhost" }
      }));
      
      await new Promise(resolve => setTimeout(resolve, 150));
      
      // Should track all changes
      const reloadEvents = events.filter(e => e.type === "CONFIG_RELOADED");
      expect(reloadEvents).toHaveLength(2);
      
      const finalResult = config.get("server.port");
      expect(finalResult._tag).toBe("Ok");
      if (finalResult._tag === "Ok") {
        expect(finalResult.value).toBe(8080);
      }
    });
  });
});