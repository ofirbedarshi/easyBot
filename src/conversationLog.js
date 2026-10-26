/**
 * Map handleMessage result.event (structured flag) → archive mode.
 * Does not inspect user text.
 */

export const MESSAGE_MODES = [
  'opening',
  'builder',
  'test',
  'menu',
  'lead',
  'command',
  'limit',
  'error',
];

const EVENT_MODE = {
  opening: 'opening',
  enter_test: 'command',
  enter_build: 'command',
  reset: 'command',
  approved_enter_test: 'command',
  menu: 'menu',
  menu_section: 'menu',
  lead_question: 'lead',
  lead_saved: 'lead',
  lead_already_sent: 'lead',
  lead_cancelled: 'lead',
  test_turn: 'test',
  build_turn: 'builder',
};

/**
 * Preview mode at enqueue, from stored session only.
 * @param {{ mode?: string, buildHistory?: object[] }|null} session
 */
export function modeFromSessionPreview(session) {
  if (!session) return 'opening';
  if (session.mode === 'TEST') return 'test';
  if (!session.buildHistory || session.buildHistory.length === 0) return 'opening';
  return 'builder';
}

/**
 * @param {{ event?: string, source?: string }|null} result
 * @param {{ mode?: string }|null} session
 */
export function modeFromHandleResult(result, session) {
  if (!result || result.source === 'error') return 'error';
  if (result.event && EVENT_MODE[result.event]) return EVENT_MODE[result.event];
  return session?.mode === 'TEST' ? 'test' : 'builder';
}
