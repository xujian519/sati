/**
 * A FIFO insertion-order cap for `Map`-based caches (#529).
 *
 * Dependency-free leaf module so the helper can be unit-tested directly and so
 * the 2,300-line `sati-bridge.js` does not absorb it. `sati-bridge.js` passes its
 * existing `MAX_ACTIVE_SESSIONS` bound as `limit`, reusing the same constant
 * already applied to `sessionState` / `pendingAgentToolCalls` (#413 / PR #425).
 */

/**
 * Insert `key → value` into `map`, evicting the oldest-inserted keys once `map`
 * exceeds `limit`. Re-setting an existing key refreshes its recency (delete then
 * insert moves it to the newest slot).
 *
 * @template K, V
 * @param {Map<K, V>} map
 * @param {K} key
 * @param {V} value
 * @param {number} limit maximum number of entries to retain (must be >= 0)
 * @returns {Map<K, V>} the same map, for chaining
 */
export function setBounded(map, key, value, limit) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > limit) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
  return map;
}
