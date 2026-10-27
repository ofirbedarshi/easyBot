import { leadInProgress, leadResumePending } from './leadIntake.js';
import { setupStep } from './setupAgenda.js';

/**
 * Persisted owner conversation phase. One function so session routing,
 * the Builder gate, and required-topic helpers share the same meaning.
 *
 * `ready` is `approvedAt`. `/test` still uses `hasEnoughForFirstBot` — that
 * is a capability check, not a phase. Tell-me-more and the goal question
 * stay agenda items inside `setup`. Wrap-up is the agenda at faq / intake /
 * complete — not this-turn model flags.
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

const WRAP_UP_STEPS = new Set(['faq', 'intake', 'complete']);

/**
 * @param {{ mode?: string, buildHistory?: object[], leadIntake?: object }|null|undefined} session
 * @param {object|null|undefined} profile
 * @param {{ draft?: object, priorAsked?: string[] }} [view]
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
  const step = setupStep({ ...draft, askedTopics: asked }, asked);
  if (WRAP_UP_STEPS.has(step)) return 'wrapup';
  return 'setup';
}
