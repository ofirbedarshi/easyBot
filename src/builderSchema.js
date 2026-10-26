import {
  OWNER_GOAL_VALUES,
  PRICE_DISCLOSURE_VALUES,
  RESPONSE_LENGTH_VALUES,
} from './profile.js';
import { REQUIRED_TOPICS } from './builderTopics.js';

const nullableString = { type: ['string', 'null'] };
const nullableBoolean = { type: ['boolean', 'null'] };
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
    'ownerGoal',
    'ownerGoalRequested',
    'services',
    'hours',
    'locationOrArea',
    'commonQuestions',
    'informationToCollect',
    'unknowns',
    'tone',
    'responseLength',
    'priceDisclosure',
    'assistantName',
    'openingMessage',
    'assistantNameReset',
    'openingMessageReset',
  ],
  properties: {
    name: nullableString,
    whatWeDo: nullableString,
    ownerGoal: nullableEnum(OWNER_GOAL_VALUES),
    ownerGoalRequested: nullableString,
    services: { type: ['array', 'null'], items: serviceItem },
    hours: nullableString,
    locationOrArea: nullableString,
    commonQuestions: { type: ['array', 'null'], items: faqItem },
    informationToCollect: { type: ['array', 'null'], items: { type: 'string' } },
    unknowns: { type: ['array', 'null'], items: { type: 'string' } },
    tone: nullableString,
    responseLength: nullableEnum(RESPONSE_LENGTH_VALUES),
    priceDisclosure: nullableEnum(PRICE_DISCLOSURE_VALUES),
    assistantName: nullableString,
    openingMessage: nullableString,
    assistantNameReset: { type: 'boolean' },
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
      'askingTopic',
      'goalSupported',
      'goalUnsupportedPart',
      'readyForReview',
      'asksQuestion',
    ],
    properties: {
      message: { type: 'string' },
      draft: draftObject,
      newFacts: { type: 'array', items: { type: 'string' } },
      ownerEdits: { type: 'array', items: ownerEditItem },
      factEdits: { type: 'array', items: factEditItem },
      resolvedUnknowns: { type: 'array', items: { type: 'integer' } },
      configRequests: { type: 'array', items: configRequestItem },
      askingTopic: nullableEnum(REQUIRED_TOPICS.map((t) => t.key)),
      goalSupported: nullableBoolean,
      goalUnsupportedPart: nullableString,
      readyForReview: { type: 'boolean' },
      asksQuestion: { type: 'boolean' },
    },
  },
};

export function builderResponseFormat() {
  return { type: 'json_schema', json_schema: BUILDER_RESPONSE_SCHEMA };
}

/** Keys the model must always return (strict schema / apply path). */
export const BUILDER_TOP_LEVEL_KEYS = BUILDER_RESPONSE_SCHEMA.schema.required;
export const BUILDER_DRAFT_KEYS = draftObject.required;
