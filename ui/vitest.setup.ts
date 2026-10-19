import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import "../vitest.setup";

// Vitest runs without `globals`, so @testing-library/react cannot register its
// own afterEach cleanup. Unmount every render after each test while jsdom is
// still alive; otherwise pending timers can schedule React work after the
// environment is torn down and crash the worker with
// "ReferenceError: window is not defined".
afterEach(() => {
  cleanup();
});
