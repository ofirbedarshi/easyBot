import { createMemoryStore } from './memoryStore.js';
import { createSupabaseStore, isSupabaseConfigured } from './supabaseStore.js';

/**
 * @param {{ forceMemory?: boolean }} [opts]
 */
export function createStore(opts = {}) {
  if (opts.forceMemory) return createMemoryStore();
  if (isSupabaseConfigured()) return createSupabaseStore();
  return createMemoryStore();
}

export { createMemoryStore, createSupabaseStore, isSupabaseConfigured };
