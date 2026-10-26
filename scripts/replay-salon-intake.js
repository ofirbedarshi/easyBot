#!/usr/bin/env node
/**
 * Live replay: salon TEST intake + a Builder mixed-goal turn (real OpenAI).
 *
 *   OPENAI_MODEL=gpt-6-luna node scripts/replay-salon-intake.js
 *
 * Not part of the default test suite. A few cents at gpt-6-luna prices.
 */
import 'dotenv/config';
import { applyReviewGate, runBuilderTurn } from '../src/builder.js';
import { businessBotReply } from '../src/businessBot.js';
import { emptyProfile } from '../src/profile.js';

const MODEL = process.env.OPENAI_MODEL || process.env.OPENAI_BUILDER_MODEL || 'gpt-6-luna';

const SALON = {
  name: 'Scissors and Sage Salon',
  whatWeDo: 'Hair salon in Columbus, Ohio',
  ownerGoal: 'answer_and_collect',
  services: [
    { name: "Women's cut", price: '$45', notes: null },
    { name: "Men's cut", price: '$30', notes: null },
    { name: 'Kids cut (under 10)', price: '$25', notes: null },
    { name: 'Blowout', price: '$35', notes: null },
    {
      name: 'Long or thick hair',
      price: '$15 extra',
      notes: 'Added to a cut',
    },
  ],
  hours:
    'Open Tuesday–Saturday 9 to 6. Closed Sunday and Monday. Weekdays by appointment; Saturday walk-ins are welcome.',
  locationOrArea: 'Columbus, Ohio',
  commonQuestions: [],
  informationToCollect: ['name', 'phone', 'preferred time'],
  unknowns: [],
  otherFacts: [
    'The salon does not offer nail services.',
    'The salon does not offer braids or extensions.',
    'The salon does not offer chemical straightening.',
    'Color only after a free 15-minute consultation; never quote color prices in chat.',
    'Cancel with 24 hours notice.',
  ],
  tone: 'friendly, clear, and professional',
  approvedAt: '2026-10-26T00:00:00Z',
};

const TEST_TURNS = [
  'i have really long thick hair, how much would a womens cut cost me?',
  'and for my 8 year old son?',
  'how much would it be to color my whole head?',
  'do you also do gel manicures?',
  'do you do bridal party packages?',
  'can i come in this sunday?',
  'can i book a cut for tomorrow at 3pm?',
  'ok, can i just walk in on saturday instead?',
  'sure - Dana Cohen, 614-555-0132, saturday around 11',
  "great, so i'm booked for saturday at 11?",
];

function refuseKeepingDetails(text) {
  return /can'?t (book or )?send|cannot send|can'?t (pass|forward|deliver)|don'?t (have a way to|send these)|go nowhere|no way to (send|pass|forward)|cannot be (sent|kept|passed)/i.test(
    text
  );
}

function claimsBooking(text) {
  return /you('re| are) booked|i('ve| have) booked|appointment is (confirmed|booked)|i (went ahead and )?booked/i.test(
    text
  );
}

function confirmsDetails(text) {
  return /thank|got (it|your)|have your|i have/i.test(text);
}

function redirectsToOwner(text) {
  return /message the owner|contact the owner|ask the owner|reach (the )?owner|owner directly/i.test(
    text
  );
}

function answersColorProcess(text) {
  return /consult/i.test(text) && !/i don'?t know the price/i.test(text);
}

function deniesBooking(text) {
  return /can'?t (confirm a )?book|not booked|no booking|haven't booked|have not booked|can't make a booking/i.test(
    text
  );
}

async function replayBusinessBot() {
  const history = [];
  const transcript = [];
  for (const question of TEST_TURNS) {
    const reply = await businessBotReply({
      profile: SALON,
      history,
      question,
    });
    history.push({ role: 'user', content: question });
    history.push({ role: 'assistant', content: reply });
    transcript.push({ question, reply });
    console.log(`\n[CUSTOMER] ${question}`);
    console.log(`[APP] ${reply}`);
  }
  const color = transcript.find((t) => /color my whole head/i.test(t.question))?.reply || '';
  const intake = transcript.find((t) => /Dana Cohen/i.test(t.question))?.reply || '';
  const booked = transcript.find((t) => /i'?m booked/i.test(t.question))?.reply || '';
  const score = {
    colorProcess: answersColorProcess(color),
    colorNoOwnerRedirect: !redirectsToOwner(color),
    confirms: confirmsDetails(intake),
    refusesKeeping: refuseKeepingDetails(intake),
    claimsBooking: claimsBooking(intake) || claimsBooking(booked),
    intakeNoOwnerRedirect: !redirectsToOwner(intake),
    deniesBooking: deniesBooking(booked),
    bookedNoOwnerRedirect: !redirectsToOwner(booked),
  };
  score.pass =
    score.colorProcess &&
    score.colorNoOwnerRedirect &&
    score.confirms &&
    !score.refusesKeeping &&
    !score.claimsBooking &&
    score.intakeNoOwnerRedirect &&
    score.deniesBooking &&
    score.bookedNoOwnerRedirect;
  return { transcript, last: booked || intake, score };
}

async function replayBuilderGoal() {
  const profile = emptyProfile();
  profile.draft = {
    ...profile.draft,
    name: 'Harbor Cuts',
    whatWeDo: 'Hair salon',
  };
  const userMessage =
    'answer questions and take messages when people want to book';
  const raw = await runBuilderTurn({
    buildHistory: [
      {
        role: 'assistant',
        content: "What's the name of your hair salon?",
      },
      { role: 'user', content: 'Harbor Cuts' },
      {
        role: 'assistant',
        content:
          "What's the main thing you'd like your bot to do for your business?",
      },
    ],
    profile,
    userMessage,
    model: MODEL,
  });
  const gated = applyReviewGate(profile, raw, userMessage);
  return {
    ownerGoal: gated.draft?.ownerGoal,
    goalSupported: raw.goalSupported,
    message: gated.message,
    hasUnavailableLine: /isn't available yet/i.test(gated.message),
  };
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY missing');
    process.exit(1);
  }
  console.log(`Model: ${MODEL}`);
  console.log('\n======= Business Bot (salon TEST) =======');
  const bot = await replayBusinessBot();
  console.log('\n--- last-reply score ---');
  console.log(JSON.stringify(bot.score, null, 2));

  console.log('\n======= Builder (mixed goal) =======');
  const builder = await replayBuilderGoal();
  console.log(JSON.stringify(builder, null, 2));

  const ok = bot.score.pass && !builder.hasUnavailableLine;
  if (!ok) {
    console.error('\nREPLAY FAIL');
    process.exit(1);
  }
  console.log('\nREPLAY PASS');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
