## 1. Component

- [ ] 1.1 Create `src/methodology/runtime/components/bridge-reencode.ts` implementing `MethodologyComponent` (name, description, category, domains, `identify` via keywordScore on reasoning triggers, `execute` returning the re-encode + bridge prompt).

## 2. Registry

- [ ] 2.1 Register `bridgeReencode` in `DEFAULT_METHODOLOGY_COMPONENTS` in `src/methodology/runtime/MethodologyRegistry.ts`.

## 3. Test

- [ ] 3.1 Create `tests/methodology/bridge-reencode.spec.ts` covering trigger match, prompt contents, and default-registry presence.

## 4. Full verification

- [ ] 4.1 Run `pnpm typecheck && pnpm lint && pnpm format:check` and the new test.
