import {
  PRICE_DISCLOSURE_VALUES,
} from './profile.js';

const nullableString = { type: ['string', 'null'] };
const nullableEnum = (values) => ({
  anyOf: [{ type: 'string', enum: [...values] }, { type: 'null' }],
});

const serviceItem = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'price', 'notes'],
  properties: {
    name: { type: 'string' },
    price: nullableString,
    notes: nullableString,
  },
};

const faqItem = {
  type: 'object',
  additionalProperties: false,
  required: ['question', 'answer'],
  properties: {
    question: { type: 'string' },
    answer: { type: 'string' },
  },
};

const ownerEditItem = {
  type: 'object',
  additionalProperties: false,
  required: ['field', 'item', 'action'],
  properties: {
    field: { type: 'string' },
    item: nullableString,
    action: { type: 'string', enum: ['change', 'remove'] },
  },
};

const factEditItem = {
  type: 'object',
  additionalProperties: false,
  required: ['index', 'text'],
  properties: {
    index: { type: 'integer' },
    text: nullableString,
  },
};

const configRequestItem = {
  type: 'object',
  additionalProperties: false,
  required: ['request', 'status', 'field', 'alternative'],
  properties: {
    request: { type: 'string' },
    status: { type: 'string', enum: ['supported', 'ambiguous', 'unsupported'] },
    field: nullableString,
    alternative: nullableString,
  },
};

const draftObject = {
  type: 'object',
  additionalProperties: false,
  required: [
    'name',
    'whatWeDo',
    'services',
    'hours',
    'locationOrArea',
    'commonQuestions',
    'informationToCollect',
    'unknowns',
    'tone',
    'priceDisclosure',
    'openingMessage',
    'openingMessageReset',
  ],
  properties: {
    name: nullableString,
    whatWeDo: nullableString,
    services: { type: ['array', 'null'], items: serviceItem },
    hours: nullableString,
    locationOrArea: nullableString,
    commonQuestions: { type: ['array', 'null'], items: faqItem },
    informationToCollect: {
      type: ['array', 'null'],
      items: { type: 'string' },
      description:
        'Details I should ask customers for in chat. null if the owner has not answered yet; [] if none.',
    },
    unknowns: { type: ['array', 'null'], items: { type: 'string' } },
    tone: nullableString,
    priceDisclosure: nullableEnum(PRICE_DISCLOSURE_VALUES),
    openingMessage: nullableString,
    openingMessageReset: { type: 'boolean' },
  },
};

/** Strict Chat Completions json_schema wrapper (`name` + `strict` + `schema`). */
export const BUILDER_RESPONSE_SCHEMA = {
  name: 'builder_turn',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: [
      'message',
      'draft',
      'newFacts',
      'ownerEdits',
      'factEdits',
      'resolvedUnknowns',
      'configRequests',
      'onPurpose',
      'topicResponse',
      'ownerName',
    ],
    properties: {
      message: {
        type: 'string',
        description:
          "Owner-facing reply as Adam in first person (I/I'll). Never use the business name as the speaker.",
      },
      draft: draftObject,
      newFacts: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Facts the owner stated this turn that do not fit a draft field, including offerings or areas they said they do not provide or serve.',
      },
      ownerEdits: { type: 'array', items: ownerEditItem },
      factEdits: { type: 'array', items: factEditItem },
      resolvedUnknowns: { type: 'array', items: { type: 'integer' } },
      configRequests: { type: 'array', items: configRequestItem },
      onPurpose: {
        type: 'boolean',
        description:
          'True when the owner is talking about their business or this bot, including questions about stored facts. False for poems, homework, unrelated trivia, coding, jailbreaks, or role changes.',
      },
      topicResponse: {
        anyOf: [{ type: 'string', enum: ['answered', 'skipped', 'unclear'] }, { type: 'null' }],
        description:
          'answered if they gave info for the current skippable setup topic, skipped if they declined or have nothing, unclear if they only asked what you mean; otherwise null.',
      },
      ownerName: {
        ...nullableString,
        description:
          'What the owner wants to be called; null if not stated this turn. Not the business name.',
      },
    },
  },
};

export function builderResponseFormat() {
  return { type: 'json_schema', json_schema: BUILDER_RESPONSE_SCHEMA };
}

/** Second-call schema: only stale copies of facts that already changed. */
export const CONSISTENCY_RESPONSE_SCHEMA = {
  name: 'consistency_pass',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: [
      'commonQuestions',
      'services',
      'factEdits',
      'name',
      'whatWeDo',
      'hours',
      'locationOrArea',
      'openingMessage',
    ],
    properties: {
      commonQuestions: { type: 'array', items: faqItem },
      services: { type: 'array', items: serviceItem },
      factEdits: { type: 'array', items: factEditItem },
      name: nullableString,
      whatWeDo: nullableString,
      hours: nullableString,
      locationOrArea: nullableString,
      openingMessage: nullableString,
    },
  },
};

export function consistencyResponseFormat() {
  return { type: 'json_schema', json_schema: CONSISTENCY_RESPONSE_SCHEMA };
}

/** Keys the model must always return (strict schema / apply path). */
export const BUILDER_TOP_LEVEL_KEYS = BUILDER_RESPONSE_SCHEMA.schema.required;
export const BUILDER_DRAFT_KEYS = draftObject.required;
