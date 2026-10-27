import { leadInProgress, leadResumePending } from './leadIntake.js';
import { normalizeOwnerGoal } from './profile.js';

/**
 * Persisted owner conversation phase. One function so session routing,
 * the Builder gate, and required-topic helpers share the same meaning.
 *
 * `ready` is `approvedAt`. `/test` still uses `hasEnoughForFirstBot` — that
 * is a capability check, not a phase. Tell-me-more and the goal question
 * stay agenda items inside `setup`.
 *
 * `view.turn` is gate-only: this-turn `readyForReview` / `wantsReview` can
 * start wrap-up without writing those flags onto the profile.
 */
export const OWNER_PHASES = Object.freeze([
  'wake',
  'setup',
  'wrapup',
  'ready',
  'test',
  'lead',
  'lead_resume',
]);

/** Same keys as WRAP_UP_TOPIC_KEYS in builderTopics.js (FAQ, intake). */
const WRAP_UP_ASKED_KEYS = new Set(['commonQuestions', 'informationToCollect']);

/**
 * @param {{ mode?: string, buildHistory?: object[], leadIntake?: object }|null|undefined} session
 * @param {object|null|undefined} profile
 * @param {{ draft?: object, priorAsked?: string[], turn?: { readyForReview?: boolean, wantsReview?: boolean } }} [view]
 * @returns {'wake'|'setup'|'wrapup'|'ready'|'test'|'lead'|'lead_resume'}
 */
export function ownerPhase(session, profile, view = {}) {
  if (session?.mode === 'TEST') return 'test';
  if (leadInProgress(session?.leadIntake)) return 'lead';
  if (leadResumePending(session?.leadIntake)) return 'lead_resume';
  if (session && Array.isArray(session.buildHistory) && session.buildHistory.length === 0) {
    return 'wake';
  }
  if (profile?.approvedAt) return 'ready';

  const draft = view.draft ?? profile?.draft;
  const asked = view.priorAsked ?? (Array.isArray(draft?.askedTopics) ? draft.askedTopics : []);
  const wrapStarted = asked.some((k) => WRAP_UP_ASKED_KEYS.has(k));
  const goalSet = !!normalizeOwnerGoal(draft?.ownerGoal);
  const turnWrap = !!(view.turn?.readyForReview || view.turn?.wantsReview);
  if (wrapStarted || goalSet || turnWrap) return 'wrapup';
  return 'setup';
}
