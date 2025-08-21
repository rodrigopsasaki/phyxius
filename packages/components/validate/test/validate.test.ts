import { describe, it, expect } from "vitest";
import {
  createValidator,
  createSafeValidator,
  fromFunction,
  withContext,
  type Validator,
  type SafeValidator,
  type ValidationResult,
} from "../src/index.js";

describe("Validate - Type-safe Validation Interfaces", () => {
  // Mock user data type for testing
  interface User {
    name: string;
    age: number;
    email: string;
  }

  describe("Validator interface", () => {
    it("should work with custom validators", () => {
      const userValidator: Validator<User> = {
        parse(input: unknown): User {
          if (!input || typeof input !== "object") {
            throw new Error("Input must be an object");
          }

          const obj = input as Record<string, unknown>;

          if (typeof obj["name"] !== "string") {
            throw new Error("Name must be a string");
          }

          if (typeof obj["age"] !== "number") {
            throw new Error("Age must be a number");
          }

          if (typeof obj["email"] !== "string") {
            throw new Error("Email must be a string");
          }

          return {
            name: obj["name"] as string,
            age: obj["age"] as number,
            email: obj["email"] as string,
          };
        },
      };

      const validInput = { name: "Alice", age: 30, email: "alice@example.com" };
      const result = userValidator.parse(validInput);

      expect(result).toEqual(validInput);
      expect(result.name).toBe("Alice");
      expect(result.age).toBe(30);
    });

    it("should throw on invalid input", () => {
      const stringValidator: Validator<string> = {
        parse(input: unknown): string {
          if (typeof input !== "string") {
            throw new Error("Expected string");
          }
          return input;
        },
      };

      expect(() => stringValidator.parse(123)).toThrow("Expected string");
      expect(() => stringValidator.parse(null)).toThrow("Expected string");
      expect(stringValidator.parse("hello")).toBe("hello");
    });
  });

  describe("SafeValidator interface", () => {
    it("should return ValidationResult instead of throwing", () => {
      const numberValidator: SafeValidator<number> = {
        parse(input: unknown): number {
          if (typeof input !== "number") {
            throw new Error("Expected number");
          }
          return input;
        },
        safeParse(input: unknown): ValidationResult<number> {
          try {
            const data = this.parse(input);
            return { success: true, data };
          } catch (error) {
            return {
              success: false,
              errors: [
                {
                  path: [],
                  message: error instanceof Error ? error.message : "Validation failed",
                },
              ],
            };
          }
        },
      };

      const successResult = numberValidator.safeParse(42);
      expect(successResult.success).toBe(true);
      expect(successResult.data).toBe(42);

      const failureResult = numberValidator.safeParse("invalid");
      expect(failureResult.success).toBe(false);
      expect(failureResult.errors).toHaveLength(1);
      expect(failureResult.errors?.[0]?.message).toBe("Expected number");
    });
  });

  describe("createValidator", () => {
    it("should create a validation function from a validator", () => {
      interface Config {
        port: number;
        host: string;
      }

      const configValidator: Validator<Config> = {
        parse(input: unknown): Config {
          if (!input || typeof input !== "object") {
            throw new Error("Config must be an object");
          }

          const obj = input as Record<string, unknown>;

          if (typeof obj["port"] !== "number") {
            throw new Error("Port must be a number");
          }

          if (typeof obj["host"] !== "string") {
            throw new Error("Host must be a string");
          }

          return { port: obj["port"] as number, host: obj["host"] as string };
        },
      };

      const validate = createValidator(configValidator);

      const validConfig = { port: 3000, host: "localhost" };
      const result = validate(validConfig);

      expect(result).toEqual(validConfig);
      expect(result.port).toBe(3000);
      expect(result.host).toBe("localhost");

      expect(() => validate({ port: "invalid" })).toThrow("Port must be a number");
    });

    it("should provide type inference", () => {
      interface Person {
        name: string;
        age: number;
      }

      const personValidator: Validator<Person> = {
        parse: (input: unknown) => input as Person, // Simplified for test
      };

      const validate = createValidator(personValidator);
      const person = validate({ name: "Bob", age: 25 });

      // TypeScript should infer that person is of type Person
      expect(typeof person.name).toBe("string");
      expect(typeof person.age).toBe("number");
    });
  });

  describe("createSafeValidator", () => {
    it("should create a safe validation function", () => {
      const emailValidator: SafeValidator<string> = {
        parse(input: unknown): string {
          if (typeof input !== "string") {
            throw new Error("Must be string");
          }
          if (!input.includes("@")) {
            throw new Error("Must be valid email");
          }
          return input;
        },
        safeParse(input: unknown): ValidationResult<string> {
          try {
            const data = this.parse(input);
            return { success: true, data };
          } catch (error) {
            return {
              success: false,
              errors: [
                {
                  path: ["email"],
                  message: error instanceof Error ? error.message : "Invalid email",
                },
              ],
            };
          }
        },
      };

      const validateSafe = createSafeValidator(emailValidator);

      const validResult = validateSafe("user@example.com");
      expect(validResult.success).toBe(true);
      expect(validResult.data).toBe("user@example.com");

      const invalidResult = validateSafe("invalid-email");
      expect(invalidResult.success).toBe(false);
      expect(invalidResult.errors?.[0]?.message).toBe("Must be valid email");
    });
  });

  describe("fromFunction", () => {
    it("should create validator from function", () => {
      interface Product {
        id: string;
        price: number;
        name: string;
      }

      const productValidator = fromFunction<Product>((input) => {
        if (!input || typeof input !== "object") {
          throw new Error("Product must be an object");
        }

        const obj = input as Record<string, unknown>;

        if (typeof obj["id"] !== "string" || (obj["id"] as string).length === 0) {
          throw new Error("ID must be a non-empty string");
        }

        if (typeof obj["price"] !== "number" || (obj["price"] as number) < 0) {
          throw new Error("Price must be a non-negative number");
        }

        if (typeof obj["name"] !== "string" || (obj["name"] as string).length === 0) {
          throw new Error("Name must be a non-empty string");
        }

        return {
          id: obj["id"] as string,
          price: obj["price"] as number,
          name: obj["name"] as string,
        };
      });

      const validProduct = {
        id: "prod-123",
        price: 29.99,
        name: "Widget",
      };

      const result = productValidator.parse(validProduct);
      expect(result).toEqual(validProduct);

      expect(() => productValidator.parse({ id: "", price: 10, name: "Test" })).toThrow(
        "ID must be a non-empty string",
      );

      expect(() => productValidator.parse({ id: "123", price: -5, name: "Test" })).toThrow(
        "Price must be a non-negative number",
      );
    });
  });

  describe("withContext", () => {
    it("should add context to validation errors", () => {
      const baseValidator: Validator<string> = {
        parse(input: unknown): string {
          if (typeof input !== "string") {
            throw new Error("Expected string");
          }
          return input;
        },
      };

      const contextValidator = withContext(baseValidator, {
        operation: "user.create",
        field: "username",
        source: "request.body",
      });

      expect(() => contextValidator.parse(123)).toThrow(
        "Expected string (operation: user.create, field: username, source: request.body)",
      );

      const result = contextValidator.parse("valid-string");
      expect(result).toBe("valid-string");
    });
  });

  describe("type inference", () => {
    it("should infer validator types correctly", () => {
      interface ApiResponse {
        status: number;
        data: string;
      }

      const responseValidator: Validator<ApiResponse> = {
        parse: (input: unknown) => input as ApiResponse,
      };

      const validate = createValidator(responseValidator);
      const response = validate({ status: 200, data: "success" });

      // TypeScript should know these properties exist
      expect(response.status).toBe(200);
      expect(response.data).toBe("success");
    });
  });

  describe("integration scenarios", () => {
    it("should work like Zod", () => {
      // Simulate how this would work with a Zod-like API
      interface UserSchema {
        name: string;
        email: string;
        age: number;
      }

      // Mock Zod-like schema
      const mockZodSchema = {
        parse(input: unknown): UserSchema {
          const obj = input as Record<string, unknown>;

          if (typeof obj["name"] !== "string") throw new Error("Invalid name");
          if (typeof obj["email"] !== "string") throw new Error("Invalid email");
          if (typeof obj["age"] !== "number") throw new Error("Invalid age");

          return {
            name: obj["name"] as string,
            email: obj["email"] as string,
            age: obj["age"] as number,
          };
        },
        safeParse(input: unknown): ValidationResult<UserSchema> {
          try {
            const data = this.parse(input);
            return { success: true, data };
          } catch (error) {
            return {
              success: false,
              errors: [
                {
                  path: [],
                  message: error instanceof Error ? error.message : "Validation failed",
                },
              ],
            };
          }
        },
      };

      // Use with our validation functions
      const validate = createValidator(mockZodSchema);
      const validateSafe = createSafeValidator(mockZodSchema);

      const validUser = { name: "Alice", email: "alice@example.com", age: 30 };

      // Regular validation
      const user = validate(validUser);
      expect(user.name).toBe("Alice");

      // Safe validation
      const safeResult = validateSafe(validUser);
      expect(safeResult.success).toBe(true);
      expect(safeResult.data?.name).toBe("Alice");

      // Error case
      const errorResult = validateSafe({ name: 123 });
      expect(errorResult.success).toBe(false);
      expect(errorResult.errors?.[0]?.message).toBe("Invalid name");
    });

    it("should handle complex nested types", () => {
      interface Address {
        street: string;
        city: string;
        zipCode: string;
      }

      interface UserWithAddress {
        name: string;
        address: Address;
        tags: string[];
      }

      const userValidator = fromFunction<UserWithAddress>((input) => {
        if (!input || typeof input !== "object") {
          throw new Error("Must be object");
        }

        const obj = input as Record<string, unknown>;

        if (typeof obj["name"] !== "string") {
          throw new Error("Name must be string");
        }

        if (!obj["address"] || typeof obj["address"] !== "object") {
          throw new Error("Address must be object");
        }

        const address = obj["address"] as Record<string, unknown>;
        if (
          typeof address["street"] !== "string" ||
          typeof address["city"] !== "string" ||
          typeof address["zipCode"] !== "string"
        ) {
          throw new Error("Invalid address format");
        }

        if (!Array.isArray(obj["tags"]) || !(obj["tags"] as unknown[]).every((tag) => typeof tag === "string")) {
          throw new Error("Tags must be array of strings");
        }

        return {
          name: obj["name"] as string,
          address: {
            street: address["street"] as string,
            city: address["city"] as string,
            zipCode: address["zipCode"] as string,
          },
          tags: obj["tags"] as string[],
        };
      });

      const validUser = {
        name: "Bob",
        address: {
          street: "123 Main St",
          city: "Anytown",
          zipCode: "12345",
        },
        tags: ["developer", "typescript"],
      };

      const result = userValidator.parse(validUser);
      expect(result.name).toBe("Bob");
      expect(result.address.street).toBe("123 Main St");
      expect(result.tags).toEqual(["developer", "typescript"]);
    });
  });
});
