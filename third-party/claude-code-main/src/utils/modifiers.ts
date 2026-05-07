export type ModifierKey = 'shift' | 'command' | 'control' | 'option'

let prewarmed = false

/**
 * Pre-warm the native module by loading it in advance.
 * Call this early to avoid delay on first use.
 */
export function prewarmModifiers(): void {
  if (prewarmed || process.platform !== 'darwin') {
    return
  }
  prewarmed = true
  // Load module in background
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { prewarm } = require('modifiers-napi') as { prewarm: () => void }
    prewarm()
  } catch {
    // Ignore errors during prewarm
  }
}

/**
 * Check if a specific modifier key is currently pressed (synchronous).
 *
 * Returns false on any error — including:
 *   - Not on macOS (modifiers-napi only ships darwin binaries).
 *   - The optional `modifiers-napi` package is not installed (we don't
 *     declare it as a hard dependency, so vendored / repackaged installs
 *     may omit it).
 *   - The native binary fails to load (wrong arch, missing accessibility
 *     permissions for global key state, Bun NAPI quirks, etc.).
 *
 * IMPORTANT: this function is called from inside `handleEnter` for the
 * Apple_Terminal Shift+Enter workaround. If we let exceptions escape, the
 * Enter key silently stops submitting in Terminal.app — the throw aborts
 * handleEnter before onSubmit fires. That's the literal symptom that
 * brought us here.
 */
export function isModifierPressed(modifier: ModifierKey): boolean {
  if (process.platform !== 'darwin') {
    return false
  }
  try {
    // Dynamic import to avoid loading native module at top level
    const { isModifierPressed: nativeIsModifierPressed } =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('modifiers-napi') as { isModifierPressed: (m: string) => boolean }
    return nativeIsModifierPressed(modifier)
  } catch {
    return false
  }
}
