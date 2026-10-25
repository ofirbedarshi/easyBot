#!/usr/bin/env node
/**
 * Investigation: Business fact fidelity from owner input → customer bot answer
 * 
 * Tests a new fictional business with conditional policies, hedged prices,
 * allergen statements with caveats, and deliberately unstated topics.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';
import { runBuilderTurn, openingMessage, applyReviewGate } from './src/builder.js';
import { emptyProfile, mergeDraft, saveProfile, loadProfile } from './src/profile.js';
import { buildCustomerSystemPrompt } from './src/customerPrompt.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, 'investigation-output');

// Test business: Luna's Pottery Studio
const OWNER_MESSAGES = [
  // Wake
  "Hi",
  
  // Business intro with conditional policy and hedged price
  "I'm Luna, I run Luna's Pottery Studio. We offer pottery classes for beginners and intermediates. Classes are around $45 I think. We deliver finished pieces only within 5 miles for orders over $100, delivery fee is $12.",
  
  // Name
  "Luna's Pottery Studio",
  
  // Bot goal
  "I'd like the bot to answer questions and collect contact info from interested people",
  
  // Add allergen-type statement with negation and no-guarantee caveat
  "Oh, and our clay is lead-free. We use some materials with natural minerals. We can't guarantee completely dust-free air since it's an active studio.",
  
  // FAQ (required topic)
  "Common questions: 'Do I need experience?' - No, our beginner classes are designed for complete newcomers. 'What should I bring?' - Just yourself and comfortable clothes that can get dirty. 'Can I make gifts?' - Yes, many students make bowls, mugs, or decorative pieces.",
  
  // Intake (required topic)
  "The bot should collect their name, phone number, and preferred class time",
  
  // Review
  "looks good"
];

// Rosa's Bakery test (from problem examples)
const ROSA_MESSAGES = [
  "Hi",
  "I'm Rosa, I run a bakery. Rosa's Bakery. We deliver only within 3 miles for orders over $40, delivery fee $8.",
  "Rosa's Bakery",
  "Answer questions",
  "skip", // FAQ
  "none", // Intake
  "approve"
];

// Customer questions to test (each run 3 times)
const CUSTOMER_QUESTIONS = {
  luna: [
    // Conditional policy - condition NOT met
    { q: "Do you deliver? I'm 2 miles away and want to order a $30 bowl", label: "delivery_condition_not_met" },
    
    // Conditional policy - condition MET
    { q: "Do you deliver? I'm 2 miles away and want to order 5 pieces totaling $120", label: "delivery_condition_met" },
    
    // Unstated item
    { q: "Do you have wheel throwing classes?", label: "unstated_item" },
    
    // Unstated policy
    { q: "What's your cancellation policy?", label: "unstated_policy" },
    
    // Allergen question (should cite lead-free, caveat about dust, not mix facts)
    { q: "Is it safe for someone with allergies? I'm sensitive to chemicals", label: "allergen_question" },
    
    // Hedged price ("around $45 I think" - should preserve uncertainty)
    { q: "How much is a class?", label: "hedged_price" },
  ],
  rosa: [
    // Original problem case: 2 miles, $18 order (condition not met)
    { q: "Do you deliver? I'm 2 miles away and want to order an $18 cake", label: "rosa_original_problem" },
  ]
};

function setupOutputDir() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
}

async function runBuilderInterview(messages, businessName) {
  console.log(`\n=== Running Builder interview: ${businessName} ===`);
  
  const profile = emptyProfile();
  const buildHistory = [];
  
  // First message triggers opening
  const opening = openingMessage();
  buildHistory.push({ role: 'assistant', content: opening.message, nav: null });
  
  const stages = [];
  
  for (let i = 1; i < messages.length; i++) {
    const userMessage = messages[i];
    console.log(`\nOwner: ${userMessage}`);
    
    const rawTurn = await runBuilderTurn({
      buildHistory,
      profile,
      userMessage
    });
    
    // Apply the review gate (just like the real app does)
    const turn = applyReviewGate(profile, rawTurn, userMessage);
    
    console.log(`Builder: ${turn.message.substring(0, 100)}...`);
    console.log(`Draft ready: ${turn.readyForReview}, Approved: ${turn.approved}`);
    
    // Update profile
    profile.draft = turn.draft;
    
    // Handle review presentation
    if (turn.presentReview) {
      profile.reviewedDraftKey = turn.reviewedDraftKey;
    }
    
    if (turn.approved) {
      Object.assign(profile, mergeDraft(profile, turn.draft));
      profile.approvedAt = new Date().toISOString();
      profile.draft = null;
      console.log(`✓ APPROVED`);
    }
    
    buildHistory.push({ role: 'user', content: userMessage });
    buildHistory.push({ role: 'assistant', content: turn.message });
    
    // Capture stage artifacts
    stages.push({
      turn: i,
      userMessage,
      builderResponse: turn.message,
      draft: JSON.parse(JSON.stringify(turn.draft)),
      approved: turn.approved,
      merged: JSON.parse(JSON.stringify(mergeDraft(profile, turn.draft)))
    });
  }
  
  return { profile, stages, buildHistory };
}

async function testCustomerBot(profile, questions, runs = 3) {
  console.log(`\n=== Testing customer bot (${runs} runs per question) ===`);
  
  const systemPrompt = buildCustomerSystemPrompt(profile);
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  
  const results = [];
  
  for (const { q, label } of questions) {
    console.log(`\nQuestion (${label}): ${q}`);
    
    const answers = [];
    for (let run = 0; run < runs; run++) {
      const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: q }
      ];
      
      const completion = await client.chat.completions.create({
        model,
        temperature: 0,
        messages
      });
      
      const answer = completion.choices[0].message.content;
      answers.push({
        run: run + 1,
        answer,
        tokens: {
          prompt: completion.usage.prompt_tokens,
          completion: completion.usage.completion_tokens,
          total: completion.usage.total_tokens
        }
      });
      
      console.log(`  Run ${run + 1}: ${answer.substring(0, 80)}...`);
    }
    
    results.push({ question: q, label, answers });
  }
  
  return { systemPrompt, results };
}

function analyzeStage1_Extraction(stages, ownerMessages) {
  console.log(`\n=== STAGE 1 ANALYSIS: Extraction & Storage ===`);
  
  const findings = [];
  const finalDraft = stages[stages.length - 1].merged;
  
  // Check conditional delivery policy
  const deliveryMention = ownerMessages.find(m => m.includes('deliver'));
  if (deliveryMention) {
    findings.push({
      topic: 'Conditional delivery policy',
      ownerSaid: deliveryMention,
      stored: {
        services: finalDraft.services,
        locationOrArea: finalDraft.locationOrArea,
        unknowns: finalDraft.unknowns,
        whatWeDo: finalDraft.whatWeDo
      },
      analysis: `Check if "only within 5 miles for orders over $100, delivery fee $12" is preserved verbatim with conditions`
    });
  }
  
  // Check hedged price
  const priceMention = ownerMessages.find(m => m.includes('around') && m.includes('think'));
  if (priceMention) {
    findings.push({
      topic: 'Hedged price (around X I think)',
      ownerSaid: priceMention,
      stored: finalDraft.services,
      analysis: `Check if uncertainty qualifier "around" or "I think" is preserved`
    });
  }
  
  // Check allergen statement with caveat
  const allergenMention = ownerMessages.find(m => m.includes('lead-free') || m.includes('dust-free'));
  if (allergenMention) {
    findings.push({
      topic: 'Allergen statement with negation and caveat',
      ownerSaid: allergenMention,
      stored: {
        whatWeDo: finalDraft.whatWeDo,
        services: finalDraft.services,
        commonQuestions: finalDraft.commonQuestions,
        unknowns: finalDraft.unknowns
      },
      analysis: `Check if "lead-free" is separate from "can't guarantee dust-free" and not mixed with other facts`
    });
  }
  
  // Check unstated topics (should be absent, not negated)
  findings.push({
    topic: 'Unstated items representation',
    ownerSaid: '(no mention of wheel throwing, cancellation policy, or payment methods)',
    stored: {
      services: finalDraft.services,
      commonQuestions: finalDraft.commonQuestions,
      unknowns: finalDraft.unknowns
    },
    analysis: `Check if truly unstated items are absent (not invented as negations)`
  });
  
  return findings;
}

function analyzeStage2_CustomerPrompt(systemPrompt, profile) {
  console.log(`\n=== STAGE 2 ANALYSIS: Customer Bot Prompt ===`);
  
  const findings = [];
  
  // Check if facts appear in multiple conflicting forms
  const sections = {
    facts: systemPrompt.match(/=== APPROVED BUSINESS FACTS ===[\s\S]*?===/)?.[0] || '',
    unknowns: systemPrompt.match(/EXPLICIT UNKNOWNS[\s\S]*?INFORMATION TO COLLECT/)?.[0] || '',
    objective: systemPrompt.match(/=== BOT OBJECTIVE ===[\s\S]*?===/)?.[0] || '',
    settings: systemPrompt.match(/=== CONVERSATION SETTINGS ===[\s\S]*?===/)?.[0] || ''
  };
  
  findings.push({
    topic: 'Fact deduplication',
    sections: Object.keys(sections).filter(k => sections[k]),
    analysis: `Check if same fact appears in multiple sections in conflicting forms`
  });
  
  // Check if conditions are preserved
  if (profile.services?.length) {
    findings.push({
      topic: 'Service pricing with conditions',
      promptRepresentation: sections.facts.match(/Services and prices[\s\S]*?Hours/)?.[0] || '(not found)',
      analysis: `Check if conditional delivery policy conditions are intact`
    });
  }
  
  return { findings, sections };
}

function analyzeStage3_Answers(results, profile) {
  console.log(`\n=== STAGE 3 ANALYSIS: Customer Bot Answers ===`);
  
  const findings = [];
  
  for (const { question, label, answers } of results) {
    const allAnswers = answers.map(a => a.answer);
    
    // Check for invented negations
    const hasInventedNegation = allAnswers.some(a => 
      /do(?:es)? not (offer|have|provide)/i.test(a) ||
      /don't (offer|have|provide)/i.test(a) ||
      /no .* available/i.test(a)
    );
    
    // Check for mixed facts (e.g., citing wheat for nut-allergy)
    const mentionsMultipleFacts = allAnswers.some(a => {
      const factCount = [
        /lead-free/i.test(a) ? 1 : 0,
        /dust/i.test(a) ? 1 : 0,
        /mineral/i.test(a) ? 1 : 0,
      ].reduce((sum, n) => sum + n, 0);
      return factCount > 2; // Mixed unrelated facts
    });
    
    // Check if conditions are preserved
    const dropsCondition = allAnswers.some(a =>
      /deliver/i.test(a) && 
      !/\$100|\$40|3 miles|5 miles|orders over/i.test(a)
    );
    
    // Check if hedges are preserved
    const dropsHedge = allAnswers.some(a =>
      /\$45/.test(a) && 
      !/around|approximately|about|think|roughly/i.test(a)
    );
    
    findings.push({
      question,
      label,
      consistency: allAnswers.every((a, i) => i === 0 || a === allAnswers[0]) ? 'identical' : 'varies',
      hasInventedNegation,
      mentionsMultipleFacts,
      dropsCondition,
      dropsHedge,
      sampleAnswer: allAnswers[0]
    });
  }
  
  return findings;
}

function mapProblemToStage(problemExample, findings) {
  // Map the 6 problem examples to most likely stage
  const mapping = {
    'Rosa delivery denied': 'Stage TBD based on findings',
    'Vegan cakes never mentioned': 'Stage TBD',
    'Nut-free mixed with wheat': 'Stage TBD',
    'around 20 I think → firm $20': 'Stage TBD',
    'Payment policy invented': 'Stage TBD',
    'Service description invented': 'Stage TBD'
  };
  
  return mapping;
}

async function main() {
  setupOutputDir();
  
  console.log('========================================');
  console.log('FIDELITY INVESTIGATION');
  console.log('========================================');
  
  // Test 1: Luna's Pottery Studio (new fictional business)
  const lunaResult = await runBuilderInterview(OWNER_MESSAGES, "Luna's Pottery Studio");
  
  const lunaExtraction = analyzeStage1_Extraction(lunaResult.stages, OWNER_MESSAGES);
  
  const lunaCustomerTests = await testCustomerBot(
    lunaResult.profile, 
    CUSTOMER_QUESTIONS.luna,
    3
  );
  
  const lunaPromptAnalysis = analyzeStage2_CustomerPrompt(
    lunaCustomerTests.systemPrompt,
    lunaResult.profile
  );
  
  const lunaAnswerAnalysis = analyzeStage3_Answers(
    lunaCustomerTests.results,
    lunaResult.profile
  );
  
  // Test 2: Rosa's Bakery (original problem case)
  console.log('\n\n========================================');
  console.log('ROSA\'S BAKERY (Original Problem)');
  console.log('========================================');
  
  const rosaResult = await runBuilderInterview(ROSA_MESSAGES, "Rosa's Bakery");
  
  const rosaCustomerTests = await testCustomerBot(
    rosaResult.profile,
    CUSTOMER_QUESTIONS.rosa,
    3
  );
  
  const rosaAnswerAnalysis = analyzeStage3_Answers(
    rosaCustomerTests.results,
    rosaResult.profile
  );
  
  // Write comprehensive report
  const report = {
    timestamp: new Date().toISOString(),
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    
    luna: {
      profile: lunaResult.profile,
      stages: lunaResult.stages,
      extractionFindings: lunaExtraction,
      customerPrompt: lunaCustomerTests.systemPrompt,
      promptAnalysis: lunaPromptAnalysis,
      customerResults: lunaCustomerTests.results,
      answerAnalysis: lunaAnswerAnalysis
    },
    
    rosa: {
      profile: rosaResult.profile,
      customerPrompt: buildCustomerSystemPrompt(rosaResult.profile),
      customerResults: rosaCustomerTests.results,
      answerAnalysis: rosaAnswerAnalysis
    }
  };
  
  // Save artifacts
  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'full-report.json'),
    JSON.stringify(report, null, 2)
  );
  
  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'luna-profile.json'),
    JSON.stringify(lunaResult.profile, null, 2)
  );
  
  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'luna-customer-prompt.txt'),
    lunaCustomerTests.systemPrompt
  );
  
  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'rosa-profile.json'),
    JSON.stringify(rosaResult.profile, null, 2)
  );
  
  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'rosa-customer-prompt.txt'),
    buildCustomerSystemPrompt(rosaResult.profile)
  );
  
  console.log(`\n✓ Investigation complete. Artifacts saved to ${OUTPUT_DIR}/`);
  console.log(`\nKey files:`);
  console.log(`  - full-report.json (complete findings)`);
  console.log(`  - luna-profile.json (stored facts)`);
  console.log(`  - luna-customer-prompt.txt (system message)`);
  console.log(`  - rosa-profile.json & rosa-customer-prompt.txt`);
}

main().catch(console.error);
