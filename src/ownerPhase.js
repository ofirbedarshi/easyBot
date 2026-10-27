import { leadInProgress, leadResumePending } from './leadIntake.js';

/**
 * Persisted owner conversation phase. One function so session routing,
 * the Builder gate, and required-topic helpers share the same meaning.
 *
 * `ready` is `approvedAt`. `/test` still uses `hasEnoughForFirstBot` — that
 * is a capability check, not a phase. Tell-me-more stays an agenda item
 * inside `setup`. The model does not return flow flags.
 */
export const OWNER_PHASES = Object.freeze([
  'wake',
  'setup',
  'ready',
  'test',
  'lead',
  'lead_resume',
]);

/**
 * @param {{ mode?: string, buildHistory?: object[], leadIntake?: object }|null|undefined} session
 * @param {object|null|undefined} profile
 * @returns {'wake'|'setup'|'ready'|'test'|'lead'|'lead_resume'}
 */
export function ownerPhase(session, profile) {
  if (session?.mode === 'TEST') return 'test';
  if (leadInProgress(session?.leadIntake)) return 'lead';
  if (leadResumePending(session?.leadIntake)) return 'lead_resume';
  if (session && Array.isArray(session.buildHistory) && session.buildHistory.length === 0) {
    return 'wake';
  }
  if (profile?.approvedAt) return 'ready';
  return 'setup';
}
