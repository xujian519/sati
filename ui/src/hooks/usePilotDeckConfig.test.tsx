import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePilotDeckConfig } from "./usePilotDeckConfig";

const mocks = vi.hoisted(() => ({
  authenticatedFetch: vi.fn(),
  subscribe: vi.fn(),
  listener: null as ((message: unknown) => void) | null,
}));

vi.mock("../utils/api", () => ({
  authenticatedFetch: mocks.authenticatedFetch,
}));

vi.mock("../contexts/WebSocketContext", () => ({
  useWebSocket: () => ({ subscribe: mocks.subscribe }),
}));

type TestResponse = {
  ok: boolean;
  json: () => Promise<unknown>;
};

function response(body: unknown, ok = true): TestResponse {
  return {
    ok,
    json: async () => body,
  };
}

function configResponse(raw: string) {
  return {
    exists: true,
    path: "/tmp/pilotdeck.yaml",
    raw,
    validation: {
      valid: true,
      errors: [],
      warnings: [],
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("usePilotDeckConfig saves", () => {
  beforeEach(() => {
    mocks.authenticatedFetch.mockReset();
    mocks.listener = null;
    mocks.subscribe.mockReset();
    mocks.subscribe.mockImplementation((listener) => {
      mocks.listener = listener;
      return vi.fn();
    });
  });

  it("serializes immediate saves and prevents an older response replacing the latest draft", async () => {
    const firstWrite = deferred<TestResponse>();
    const secondWrite = deferred<TestResponse>();
    const writeBodies: string[] = [];

    mocks.authenticatedFetch.mockImplementation(
      (url: string, options?: RequestInit) => {
        if (url === "/api/config" && !options?.method) {
          return Promise.resolve(response(configResponse("initial")));
        }
        if (url === "/api/config/validate") {
          return Promise.resolve(
            response({ valid: true, errors: [], warnings: [] }),
          );
        }
        if (url === "/api/config" && options?.method === "PUT") {
          writeBodies.push(String(options.body));
          return writeBodies.length === 1
            ? firstWrite.promise
            : secondWrite.promise;
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    );

    const { result } = renderHook(() => usePilotDeckConfig());
    await waitFor(() => expect(result.current.loading).toBe(false));

    let firstSave!: ReturnType<typeof result.current.save>;
    let secondSave!: ReturnType<typeof result.current.save>;
    act(() => {
      result.current.setRaw("first");
      firstSave = result.current.save();
      result.current.setRaw("second");
      secondSave = result.current.save();
    });

    await waitFor(() => expect(writeBodies).toHaveLength(1));
    expect(JSON.parse(writeBodies[0])).toEqual({ raw: "first" });

    act(() => {
      firstWrite.resolve(response(configResponse("first")));
    });
    await waitFor(() => expect(writeBodies).toHaveLength(2));

    act(() => {
      mocks.listener?.({
        type: "config:reloaded",
        source: "ui-save",
        ...configResponse("first"),
      });
    });
    expect(result.current.raw).toBe("second");
    expect(JSON.parse(writeBodies[1])).toEqual({ raw: "second" });

    act(() => {
      secondWrite.resolve(response(configResponse("second")));
    });

    let results;
    await act(async () => {
      results = await Promise.all([firstSave, secondSave]);
    });

    expect(results).toEqual([{ ok: true }, { ok: true }]);
    expect(result.current.raw).toBe("second");
    expect(result.current.saving).toBe(false);
  });

  it("returns an explicit failure and exposes the server error", async () => {
    mocks.authenticatedFetch.mockImplementation(
      (url: string, options?: RequestInit) => {
        if (url === "/api/config" && !options?.method) {
          return Promise.resolve(response(configResponse("initial")));
        }
        if (url === "/api/config/validate") {
          return Promise.resolve(
            response({ valid: true, errors: [], warnings: [] }),
          );
        }
        if (url === "/api/config" && options?.method === "PUT") {
          return Promise.resolve(
            response({ error: "Config write rejected" }, false),
          );
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    );

    const { result } = renderHook(() => usePilotDeckConfig());
    await waitFor(() => expect(result.current.loading).toBe(false));

    let saveResult;
    await act(async () => {
      result.current.setRaw("invalid");
      saveResult = await result.current.save();
    });

    expect(saveResult).toEqual({
      ok: false,
      error: "Config write rejected",
    });
    expect(result.current.error).toBe("Config write rejected");
    expect(result.current.saving).toBe(false);
  });
});
