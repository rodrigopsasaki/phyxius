import { describe, it, expect, vi } from "vitest";
import { readFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DrainEntry, Sink } from "../src/types.js";
import { stdoutSink } from "../src/sinks/stdout.js";
import { fileSink } from "../src/sinks/file.js";
import { compositeSink } from "../src/sinks/composite.js";

interface TestData {
  level: string;
  message: string;
}

function makeEntry(data: TestData, sequence = 0): DrainEntry<TestData> {
  return {
    id: `entry-${sequence}`,
    sequence,
    timestamp: { wallMs: 1000 + sequence * 100, monoMs: 1000 + sequence * 100 },
    data,
  };
}

describe("stdoutSink", () => {
  it("should write JSON lines to stdout", async () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const sink = stdoutSink<TestData>();
    await sink.write([
      makeEntry({ level: "info", message: "hello" }, 0),
      makeEntry({ level: "warn", message: "careful" }, 1),
    ]);

    expect(writeSpy).toHaveBeenCalledTimes(2);

    const firstLine = writeSpy.mock.calls[0]?.[0] as string;
    expect(firstLine).toBeDefined();
    if (firstLine === undefined) return;

    const parsed = JSON.parse(firstLine.trim()) as Record<string, unknown>;
    expect(parsed["level"]).toBe("info");
    expect(parsed["message"]).toBe("hello");
    expect(parsed["sequence"]).toBe(0);
    expect(parsed["timestamp"]).toBeDefined();

    writeSpy.mockRestore();
  });
});

describe("fileSink", () => {
  it("should append JSON lines to a file", async () => {
    const filePath = join(tmpdir(), `drain-test-${Date.now()}.jsonl`);

    try {
      const sink = fileSink<TestData>({ path: filePath });

      await sink.write([makeEntry({ level: "info", message: "first" }, 0)]);

      await sink.write([makeEntry({ level: "error", message: "second" }, 1)]);

      const content = readFileSync(filePath, "utf-8");
      const lines = content.trim().split("\n");

      expect(lines.length).toBe(2);

      const first = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
      const second = JSON.parse(lines[1] ?? "{}") as Record<string, unknown>;

      expect(first["message"]).toBe("first");
      expect(second["message"]).toBe("second");
    } finally {
      if (existsSync(filePath)) {
        unlinkSync(filePath);
      }
    }
  });
});

describe("compositeSink", () => {
  it("should fan out to all sinks", async () => {
    const calls: string[] = [];

    const sinkA: Sink<TestData> = {
      async write(entries) {
        calls.push(`A:${entries.length}`);
      },
    };

    const sinkB: Sink<TestData> = {
      async write(entries) {
        calls.push(`B:${entries.length}`);
      },
    };

    const sink = compositeSink([sinkA, sinkB]);
    await sink.write([
      makeEntry({ level: "info", message: "test" }, 0),
      makeEntry({ level: "info", message: "test2" }, 1),
    ]);

    expect(calls).toContain("A:2");
    expect(calls).toContain("B:2");
  });

  it("should propagate errors from any sink", async () => {
    const goodSink: Sink<TestData> = {
      async write() {
        /* no-op */
      },
    };

    const badSink: Sink<TestData> = {
      async write() {
        throw new Error("bad sink");
      },
    };

    const sink = compositeSink([goodSink, badSink]);

    await expect(sink.write([makeEntry({ level: "info", message: "test" })])).rejects.toThrow("bad sink");
  });

  it("should handle empty sink list", async () => {
    const sink = compositeSink<TestData>([]);

    // Should not throw
    await sink.write([makeEntry({ level: "info", message: "test" })]);
  });
});
