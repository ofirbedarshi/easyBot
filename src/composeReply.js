/**
 * Single reply composer. Policy (phase, agenda, routing) stays elsewhere.
 * This module owns ordering, paragraph breaks, menus, cards, and footers.
 */
import {
  BOT_ERROR_REPLY,
  BUILDER_ERROR_PREFIX,
  CHANGE_LABELS,
  DEFAULT_CUSTOMER_HELP_LINE,
  FALLBACK_BUSINESS_NAME,
  GENERIC_ERROR_REPLY,
  IDENTITY_FALLBACK_QUESTION,
  INTAKE_MENU_LABEL,
  CHATS_FOOTER,
  CHATS_MENU_LABEL,
  businessDetailsAck,
  chatsEmptyLine,
  LEAD_ALREADY_SENT,
  LEAD_INTRO,
  LEAD_INVALID,
  LEAD_INVALID_MULTI,
  LEAD_MENU_LABEL,
  LEAD_STEPS,
  LEAD_THANKS_NO,
  LEAD_THANKS_YES,
  NAV,
  OFF_PURPOSE_OWNER_REPLY,
  OPENING_MESSAGE,
  OTHER_FACTS_LABEL,
  OWNER_NAME_QUESTION,
  PARSE_FALLBACK_MESSAGE,
  RESET_REPLY,
  REVIEW,
  TEST_REFUSE,
  menuIntro,
  readyOpener,
  returnedIntro,
  defaultCustomerOpeningText,
  enterTestBannerText,
  exitTestBannerText,
} from './copy.js';
import { topicQuestion } from './builderTopics.js';
import {
  assistantIdentityView,
  customerOpeningText,
  effectiveBehavior,
  mergeDraft,
  normalizeCommonQuestions,
  normalizeFaqItem,
  normalizePriceDisclosure,
  pricePolicyOwnerLabel,
} from './profile.js';

export const COMPOSE_KINDS = Object.freeze([
  'opening',
  'ask_owner_name',
  'ask_identity',
  'ask_topic',
  'ready_first',
  'saved_changes',
  'change_menu',
  'menu',
  'model_plus_menu',
  'model_only',
  'off_purpose',
  'reset',
  'test_refuse',
  'test_enter',
  'test_exit',
  'stop_build',
  'section',
  'lead_start',
  'lead_question',
  'lead_invalid',
  'lead_followup',
  'lead_thanks',
  'lead_already_sent',
  'lead_cancelled',
  'error_business',
  'error_builder',
  'error_generic',
  'customer_turn',
  'parse_fallback',
  'review',
  'setup_continue',
  'return_to_editing',
  'chats_empty',
  'chats_report',
  'chats_followup',
  'chats_saved',
]);

const REVIEW_FILLER =
  /\b(review|summary|summari[sz]e|approv\w*|set up|setup|ready|prepare|here'?s what|below)\b/i;

/**
 * Replace the model's questions with `question`, keeping only the text before
 * its first question (acknowledgment, summary) so the turn asks one thing.
 * Text after that question is dropped: it is usually a follow-up to it.
 */
export function withSingleQuestion(text, question) {
  const lines = [];
  for (const line of String(text || '').split(/\n/)) {
    const sentences = line.match(/[^.!?。]+[.!?。]*\s*/g) || [];
    const firstQ = sentences.findIndex((s) => /\?\s*$/.test(s));
    const before = (firstQ === -1 ? sentences : sentences.slice(0, firstQ)).join('').trim();
    lines.push(before);
    if (firstQ !== -1) break;
  }
  const kept = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return kept ? `${kept}\n\n${question}` : question;
}

/**
 * Reduce model text on a review turn to one short acknowledgment sentence: no
 * questions, no bullet/numbered lines, no "here's the summary / ready for
 * review" filler (the app renders the summary and options).
 */
export function reviewAck(text) {
  const sentences = String(text || '')
    .split(/\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^\s*([-*•]|#{1,6}|\d+[.)])\s+/.test(line))
    .flatMap((line) => (line.match(/[^.!?。]+[.!?。]*\s*/g) || []).map((s) => s.trim()))
    .filter((s) => s && !/\?\s*$/.test(s) && !/:\s*$/.test(s));
  const kept = sentences.find((s) => !REVIEW_FILLER.test(s));
  return kept || '';
}

/**
 * Replace the text before the first question sentence with `lead` (the model's
 * own acknowledgment may restate the unsupported goal). No question → `lead` only.
 */
export function replaceBeforeQuestion(text, lead) {
  const s = String(text || '').trim();
  const q = s.indexOf('?');
  if (q === -1) return lead;
  const start =
    Math.max(s.lastIndexOf('.', q), s.lastIndexOf('!', q), s.lastIndexOf('\n', q)) + 1;
  return [lead, s.slice(start).trim()].filter(Boolean).join('\n\n');
}

function textOrNull(v) {
  if (v == null || v === '') return null;
  return String(v);
}

/** Review line text: trim and drop a trailing period. Do not clip — owners
 *  must be able to see every stored service, fact, and area on WhatsApp. */
function brief(text) {
  return String(text || '').trim().replace(/\.$/, '');
}

function fieldLine(label, value) {
  return `*${label}:* ${value}`;
}

function quoteOpeningLines(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `> ${line}`)
    .join('\n');
}

function serviceLine(svc) {
  const price = svc.price != null && svc.price !== '' ? ` — ${svc.price}` : '';
  const notes = svc.notes ? ` (${svc.notes})` : '';
  return `${svc.name || '?'}${price}${notes}`;
}

/**
 * Review summary: one `Label: value` line per item (name, business fields, bot
 * goal and intake, Q&A, then how the bot talks). `full` holds the underlying
 * data so the changes view can detect edits that the trimmed `value` hides.
 */
export function summaryLines(p) {
  const R = REVIEW;
  const L = R.labels;
  const out = [];
  const add = (id, label, value, full) =>
    out.push({ id, label, value, full: JSON.stringify(full ?? null) });

  const name = textOrNull(p.name);
  add('name', L.name, name ? brief(name) : R.notSet, name);
  const what = textOrNull(p.whatWeDo);
  add('business', L.business, what ? brief(what) : R.notSet, what);
  const services = Array.isArray(p.services) ? p.services : [];
  add(
    'services',
    L.services,
    services.length
      ? brief(services.map((s) => `${s.name || '?'}${s.price ? ` — ${s.price}` : ''}`).join('; '))
      : R.none,
    services
  );
  const area = textOrNull(p.locationOrArea);
  add('area', L.area, area ? brief(area) : R.gap, area);
  const hours = textOrNull(p.hours);
  add('hours', L.hours, hours ? brief(hours) : R.gap, hours);
  const price = normalizePriceDisclosure(p.priceDisclosure) || 'relevant';
  add('pricePolicy', L.pricePolicy, pricePolicyOwnerLabel(p.priceDisclosure), price);
  const unknowns = Array.isArray(p.unknowns) ? p.unknowns : [];
  if (unknowns.length) add('unknowns', L.unknowns, brief(unknowns.join('; ')), unknowns);
  const otherFacts = Array.isArray(p.otherFacts) ? p.otherFacts : [];
  if (otherFacts.length) {
    add('otherFacts', OTHER_FACTS_LABEL, brief(otherFacts.join('; ')), otherFacts);
  }

  const intake = p.informationToCollect;
  add(
    'intake',
    L.intake,
    !Array.isArray(intake) ? R.notDecided : intake.length ? brief(intake.join(', ')) : R.nothing,
    intake ?? null
  );

  const faqAll = normalizeCommonQuestions(p.commonQuestions);
  const faq = faqAll.filter((f) => f.answer);
  add('faq', L.faq, faq.length ? R.faqCount(faq.length) : R.faqNone, faqAll);

  const tone = typeof p.tone === 'string' && p.tone.trim() ? p.tone.trim() : null;
  const id = assistantIdentityView(p);
  const talks = [tone, id.openingMessage ? R.customOpening : null].filter(Boolean);
  add(
    'talks',
    L.talks,
    talks.length ? brief(talks.join(', ')) : R.defaultValue,
    { tone, opening: id.openingMessage }
  );
  return out;
}

function emptyChangeValue(id) {
  if (id === 'intake') return REVIEW.nothing;
  return REVIEW.none;
}

/**
 * Lines that belong on the save card. Compares `summaryLines` including
 * fields that disappear when emptied (otherFacts, unknowns) so a real
 * removal still produces a line with an existing empty label.
 */
export function changeLines(profile, merged) {
  const prevLines = summaryLines(profile);
  const nextLines = summaryLines(merged);
  const prev = new Map(prevLines.map((l) => [l.id, l]));
  const next = new Map(nextLines.map((l) => [l.id, l]));
  const ids = [];
  for (const line of nextLines) ids.push(line.id);
  for (const line of prevLines) if (!next.has(line.id)) ids.push(line.id);
  const lines = [];
  for (const id of ids) {
    const before = prev.get(id);
    const after = next.get(id);
    if (before && after && before.full === after.full) continue;
    const label = CHANGE_LABELS[id] || after?.label || before?.label;
    const value = after ? after.value : emptyChangeValue(id);
    lines.push(fieldLine(label, value));
  }
  return lines;
}

export function sectionLines(section, p) {
  const s = NAV;
  const f = s.fields;
  const val = (v) => (v == null || v === '' ? s.notAdded : String(v));
  const lines = [];
  if (section === 1) {
    lines.push(fieldLine(f.name, val(p.name)));
    lines.push(fieldLine(f.whatYouDo, val(p.whatWeDo)));
    const services = Array.isArray(p.services) ? p.services : [];
    if (services.length) {
      lines.push(`*${f.services}:*`);
      for (const svc of services) lines.push(serviceLine(svc));
    } else {
      lines.push(fieldLine(f.services, s.notAdded));
    }
    lines.push(fieldLine(f.hours, val(p.hours)));
    lines.push(fieldLine(f.location, val(p.locationOrArea)));
    lines.push(fieldLine(f.pricePolicy, pricePolicyOwnerLabel(p.priceDisclosure)));
  } else if (section === 2) {
    const faq = (Array.isArray(p.commonQuestions) ? p.commonQuestions : [])
      .map(normalizeFaqItem)
      .filter(Boolean);
    if (!faq.length) {
      lines.push(s.noQuestions);
    } else {
      faq.forEach((item, i) => {
        if (i) lines.push('');
        lines.push(`*${item.question}*`);
        lines.push(item.answer || s.notAdded);
      });
    }
  } else if (section === 3) {
    const eff = effectiveBehavior(p);
    lines.push(fieldLine(f.tone, eff.tone));
    lines.push(`*${f.openingMessage}:*`);
    lines.push(quoteOpeningLines(customerOpeningText(p)));
  } else if (section === 'intake') {
    const intake = Array.isArray(p.informationToCollect) ? p.informationToCollect : [];
    if (!intake.length) {
      lines.push(s.noIntake);
    } else {
      for (const item of intake) lines.push(`• ${item}`);
    }
  }
  return lines;
}

/**
 * Ordered editing-menu items: optional 'lead', then 'try', optional
 * 'chats', then sections 1–3 (numbers) and 'intake'. Rendering and
 * number parsing both use this list, so a picked number always maps to
 * the item shown at that position.
 * Lead is included only when `leadOption` is true (approved + firstTestedAt
 * + no lead submitted) and stays first when shown.
 * Chats is included only when `chatsOption` is true (`firstTestedAt` set).
 */
export function menuItems({ leadOption = false, chatsOption = false } = {}) {
  return [
    ...(leadOption ? ['lead'] : []),
    'try',
    ...(chatsOption ? ['chats'] : []),
    1,
    2,
    'intake',
    3,
  ];
}

function menuLabel(item) {
  if (item === 'lead') return `🚀 ${LEAD_MENU_LABEL}`;
  if (item === 'try') return NAV.menu[3];
  if (item === 'chats') return `📋 ${CHATS_MENU_LABEL}`;
  if (item === 'intake') return INTAKE_MENU_LABEL;
  return NAV.menu[item - 1];
}

function renderMenuText(menuOpts) {
  return [
    ...menuItems(menuOpts).map((item, i) => `${i + 1}. ${menuLabel(item)}`),
    '',
    NAV.menuFooter,
  ].join('\n');
}

function leadQuestionText(id, businessName) {
  const q = LEAD_STEPS[id];
  if (!q) return '';
  return typeof q.text === 'function' ? q.text(businessName) : q.text;
}

function renderLeadQuestion(id, businessName) {
  const q = LEAD_STEPS[id];
  const text = leadQuestionText(id, businessName);
  if (!q?.options) return text;
  return [text, ...q.options.map((label, i) => `${i + 1}. ${label}`)].join('\n');
}

function optionStoreLabel(label) {
  return String(label).replace(/^\p{Extended_Pictographic}\uFE0F?\s+/u, '');
}

function closingThanks(answers) {
  const yesLabel = optionStoreLabel(LEAD_STEPS.contactConsent.options[0]);
  return answers?.contactConsent === yesLabel ? LEAD_THANKS_YES : LEAD_THANKS_NO;
}

function businessDisplayName(profile) {
  const name = typeof profile?.name === 'string' ? profile.name.trim() : '';
  return name || FALLBACK_BUSINESS_NAME;
}

function done(reply, extra = {}) {
  return {
    reply,
    nav: extra.nav ?? null,
    asksQuestion: extra.asksQuestion ?? false,
    ...(extra.replies ? { replies: extra.replies } : {}),
  };
}

/**
 * Assemble one outgoing reply.
 *
 * @param {{
 *   kind: string,
 *   modelText?: string,
 *   profile?: object,
 *   prior?: object,
 *   menuOpts?: { leadOption?: boolean, chatsOption?: boolean },
 *   parts?: object,
 * }} spec
 * @returns {{ reply: string, replies?: string[], nav: string|null, asksQuestion: boolean }}
 */
export function composeReply(spec = {}) {
  const kind = spec.kind;
  const modelText = spec.modelText ?? '';
  const profile = spec.profile;
  const prior = spec.prior;
  const menuOpts = spec.menuOpts || {};
  const parts = spec.parts || {};
  const ownerName = spec.ownerName;

  switch (kind) {
    case 'opening':
      return done(OPENING_MESSAGE);

    case 'ask_owner_name': {
      const question = OWNER_NAME_QUESTION;
      if (parts.keepLead) {
        const lead = String(modelText || '').trim();
        return done(lead ? `${lead}\n\n${question}` : question, { asksQuestion: true });
      }
      return done(question, { asksQuestion: true });
    }

    case 'ask_identity':
      if (parts.ack) {
        return done(`${parts.ack}\n\n${IDENTITY_FALLBACK_QUESTION}`, {
          asksQuestion: true,
        });
      }
      return done(withSingleQuestion(modelText, IDENTITY_FALLBACK_QUESTION), {
        asksQuestion: true,
      });

    case 'ask_topic': {
      const question = topicQuestion(parts.topic, parts.draft);
      if (parts.keepLead) {
        const lead = String(modelText || '').trim();
        return done(lead ? `${lead}\n\n${question}` : question, {
          asksQuestion: true,
        });
      }
      const lead = parts.ack || modelText;
      return done(withSingleQuestion(lead, question), {
        asksQuestion: true,
      });
    }

    case 'ready_first':
      return done(`${readyOpener(ownerName)}\n\n${renderMenuText(menuOpts)}`, { nav: 'menu' });

    case 'saved_changes': {
      const ack = (modelText || '').trim();
      const card = [REVIEW.changesIntro, ...changeLines(prior, profile)].join('\n');
      const menu = renderMenuText(menuOpts);
      return done([ack, card, menu].filter(Boolean).join('\n\n'), { nav: 'menu' });
    }

    case 'change_menu':
      return done(`${menuIntro(ownerName)}\n\n${renderMenuText(menuOpts)}`, { nav: 'menu' });

    case 'menu':
      return done(renderMenuText(menuOpts), { nav: 'menu' });

    case 'model_plus_menu':
      return done([modelText, renderMenuText(menuOpts)].filter(Boolean).join('\n\n'), {
        nav: 'menu',
      });

    case 'model_only':
      return done(modelText, { asksQuestion: !!parts.asksQuestion });

    case 'off_purpose':
      return done(OFF_PURPOSE_OWNER_REPLY);

    case 'reset':
      return done(RESET_REPLY);

    case 'test_refuse':
      return done(TEST_REFUSE);

    case 'test_enter': {
      const banner = enterTestBannerText(businessDisplayName(profile));
      const opening = customerOpeningText(profile);
      return done(banner, { replies: [banner, opening] });
    }

    case 'test_exit': {
      const banner = exitTestBannerText();
      if (parts.ready) {
        const menu = `${returnedIntro(ownerName)}\n\n${renderMenuText(menuOpts)}`;
        return done(banner, { replies: [banner, menu], nav: 'menu' });
      }
      return done(banner, { replies: [banner, NAV.setupContinue] });
    }

    case 'stop_build':
      if (parts.ready) {
        return done(`${returnedIntro(ownerName)}\n\n${renderMenuText(menuOpts)}`, { nav: 'menu' });
      }
      return done(NAV.setupContinue);

    case 'section': {
      const intro =
        parts.section === 'intake' ? NAV.intakeIntro : NAV.sectionIntros[parts.section - 1];
      return done(
        [
          intro,
          '',
          ...sectionLines(parts.section, profile),
          '',
          NAV.ask,
          NAV.menuHint,
        ].join('\n'),
        { nav: `section:${parts.section}` }
      );
    }

    case 'lead_start':
      return done(`${LEAD_INTRO}\n\n${renderLeadQuestion('contactConsent')}`);

    case 'lead_question': {
      const question = renderLeadQuestion(parts.step, parts.businessName);
      return done(parts.intro ? `${parts.intro}\n\n${question}` : question);
    }

    case 'lead_invalid': {
      const prefix = parts.multi ? LEAD_INVALID_MULTI : LEAD_INVALID;
      return done(`${prefix}\n\n${renderLeadQuestion(parts.step, parts.businessName)}`);
    }

    case 'lead_followup':
      return done(parts.text);

    case 'lead_thanks':
      return done(closingThanks(parts.answers));

    case 'lead_already_sent':
      return done(`${LEAD_ALREADY_SENT}\n\n${renderMenuText(menuOpts)}`);

    case 'lead_cancelled':
      return done(renderMenuText(menuOpts));

    case 'error_business':
      return done(BOT_ERROR_REPLY);

    case 'error_builder':
      return done(`${BUILDER_ERROR_PREFIX}${parts.errorMessage}`);

    case 'error_generic':
      return done(GENERIC_ERROR_REPLY);

    case 'customer_turn': {
      const text = (modelText || '').trim();
      if (!text) return done('');
      if (!parts.prependOpening) return done(text);
      return done(`${customerOpeningText(profile)}\n\n${text}`);
    }

    case 'parse_fallback':
      return done(PARSE_FALLBACK_MESSAGE);

    case 'review': {
      const draft = profile?.draft;
      const view = draft ? mergeDraft(profile, draft) : profile || {};
      const name = textOrNull(view.name);
      return done(
        [
          name ? REVIEW.intro(name) : REVIEW.introNoName,
          summaryLines(view)
            .map((l) => `${l.label}: ${l.value}`)
            .join('\n'),
        ].join('\n\n')
      );
    }

    case 'setup_continue':
      return done(NAV.setupContinue);

    case 'return_to_editing':
      return done(`${returnedIntro(ownerName)}\n\n${renderMenuText(menuOpts)}`, { nav: 'menu' });

    case 'chats_empty':
      return done(`${chatsEmptyLine(ownerName)}\n\n${menuIntro(ownerName)}\n\n${renderMenuText(menuOpts)}`, {
        nav: 'menu',
      });

    case 'chats_report':
    case 'chats_followup':
      return done([modelText, CHATS_FOOTER].filter(Boolean).join('\n\n'));

    case 'chats_saved': {
      const ack = businessDetailsAck(ownerName);
      const card = [REVIEW.changesIntro, ...changeLines(prior, profile)].join('\n');
      return done([ack, card, CHATS_FOOTER].filter(Boolean).join('\n\n'));
    }

    default:
      throw new Error(`unknown compose kind: ${kind}`);
  }
}

export {
  DEFAULT_CUSTOMER_HELP_LINE,
  IDENTITY_FALLBACK_QUESTION,
  OWNER_NAME_QUESTION,
  PARSE_FALLBACK_MESSAGE,
  defaultCustomerOpeningText,
};
