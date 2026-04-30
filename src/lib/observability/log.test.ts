import { describe, expect, it, afterEach } from "vitest";
import { logEvent, setLogSink, type LogEvent } from "./log";

describe("logEvent", () => {
  afterEach(() => {
    setLogSink();
  });

  it("emits an event with ts, event name, and caller fields", () => {
    const captured: LogEvent[] = [];
    setLogSink((event) => captured.push(event));

    logEvent("foo.bar", { a: 1, b: "x" });

    expect(captured).toHaveLength(1);
    const [event] = captured;
    expect(event).toBeDefined();
    expect(event!.event).toBe("foo.bar");
    expect(typeof event!.ts).toBe("string");
    expect(new Date(event!.ts).toString()).not.toBe("Invalid Date");
    expect(event!["a"]).toBe(1);
    expect(event!["b"]).toBe("x");
  });

  it("accumulates multiple events in emission order", () => {
    const captured: LogEvent[] = [];
    setLogSink((event) => captured.push(event));

    logEvent("a", { i: 1 });
    logEvent("b", { i: 2 });
    logEvent("c", { i: 3 });

    expect(captured.map((e) => e.event)).toEqual(["a", "b", "c"]);
    expect(captured.map((e) => e["i"])).toEqual([1, 2, 3]);
  });

  it("resets to default sink when setLogSink is called with no arg", () => {
    const captured: LogEvent[] = [];
    setLogSink((event) => captured.push(event));
    setLogSink();
    logEvent("after.reset", {});
    expect(captured).toHaveLength(0);
  });
});
