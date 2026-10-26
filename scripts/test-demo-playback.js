/**
 * Deterministic checks for the scripted web-chat demo (?demo=luna).
 * No network. No OpenAI. Never prints env values.
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  EXPECTED_CHIPS,
  EXPECTED_LINES,
  SUMMARY_HEADING,
  applyCue,
  charDelayMs,
  createController,
  demoScriptUrl,
  incomingTypingMs,
  loadDemoScript,
  parseDemoParams,
  playScript,
  scriptLines,
} from '../public/demo/player.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const lunaPath = path.join(root, 'public/demo/luna.json');
const playerPath = path.join(root, 'public/demo/player.js');
const indexPath = path.join(root, 'public/index.html');

const luna = JSON.parse(fs.readFileSync(lunaPath, 'utf8'));
const playerSrc = fs.readFileSync(playerPath, 'utf8');
const indexSrc = fs.readFileSync(indexPath, 'utf8');

function mockUi() {
  const calls = [];
  return {
    calls,
    reset() {
      calls.push(['reset']);
    },
    addChip(text) {
      calls.push(['chip', text]);
    },
    addMsg(role, text) {
      calls.push(['msg', role, text]);
    },
    setInput(text) {
      calls.push(['input', text]);
    },
    setSubtitle(text) {
      calls.push(['subtitle', text]);
    },
    beginTyping() {
      calls.push(['beginTyping']);
    },
    pressSend() {
      calls.push(['pressSend']);
    },
    releaseSend() {
      calls.push(['releaseSend']);
    },
    scrollToBottom() {
      calls.push(['scroll']);
    },
    finish() {
      calls.push(['finish']);
    },
  };
}

function testScriptHasExactLines() {
  assert.equal(luna.id, 'luna');
  const chips = (luna.events || [])
    .filter((ev) => ev.type === 'chip')
    .map((ev) => ev.text);
  assert.deepEqual(chips, EXPECTED_CHIPS, 'chips must match the approved demo copy');
  assert.deepEqual(scriptLines(luna), EXPECTED_LINES, 'spoken lines must be verbatim');
  const summary = luna.events.find((ev) => String(ev.text || '').includes(SUMMARY_HEADING));
  assert.ok(summary, 'summary event uses *Luna Hair Studio*');
  assert.match(summary.text, /\n• Women's haircut: \$45/);
  assert.match(summary.text, /\n1\. Try my bot\n2\. Make changes$/);
}

function testDemoParamsAndUrl() {
  assert.deepEqual(parseDemoParams(''), {
    name: '',
    speed: 1,
    autostart: false,
    cue: '',
  });
  assert.deepEqual(parseDemoParams('?demo=luna&speed=1.5&autostart=1&cue=summary'), {
    name: 'luna',
    speed: 1.5,
    autostart: true,
    cue: 'summary',
  });
  assert.equal(parseDemoParams('?speed=0').speed, 1);
  assert.equal(parseDemoParams('?speed=-2').speed, 1);
  assert.equal(demoScriptUrl('luna'), '/demo/luna.json');
  assert.equal(demoScriptUrl('../secret'), null);
  assert.equal(demoScriptUrl(''), null);
}

function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

function testNoApiCallsInDemoCode() {
  const playerCode = stripComments(playerSrc);
  assert.doesNotMatch(playerCode, /fetch\s*\(\s*['"`]\/api\//);
  assert.doesNotMatch(playerCode, /['"`]\/api\/(?:chat|start|health)/);
  assert.match(indexSrc, /if \(demo\.name\)/);
  assert.match(indexSrc, /startDemoPlayback/);
  assert.match(indexSrc, /if \(demo\.name\) return;/);
  // Normal chat path is still present and still posts to /api/chat.
  assert.match(indexSrc, /fetch\('\/api\/chat'/);
  assert.match(indexSrc, /fetch\('\/api\/start'/);
  assert.match(indexSrc, /fetch\('\/api\/health'/);
  assert.match(indexSrc, /\} else \{\s*start\(\);/s);
}

function testNormalComposerFixesPresent() {
  assert.match(indexSrc, /textarea#input/);
  assert.match(indexSrc, /function growComposer\(/);
  assert.match(indexSrc, /flex:\s*0 0 46px/);
  assert.match(indexSrc, /padding:\s*0\.35rem 10px/);
  assert.match(indexSrc, /min-width:\s*0/);
}

async function testLoadScriptDoesNotHitApi() {
  const urls = [];
  const fetchFn = async (url) => {
    urls.push(url);
    return {
      ok: true,
      json: async () => luna,
    };
  };
  const loaded = await loadDemoScript('luna', fetchFn);
  assert.deepEqual(urls, ['/demo/luna.json']);
  assert.equal(loaded.id, 'luna');
  assert.ok(urls.every((u) => !u.includes('/api/')));
}

function testCues() {
  const idle = mockUi();
  assert.deepEqual(applyCue(luna, 'idle', idle), { cue: 'idle' });
  assert.deepEqual(idle.calls, [['reset']]);

  const typing = mockUi();
  const typingResult = applyCue(luna, 'typing-long-owner', typing);
  assert.equal(typingResult.cue, 'typing-long-owner');
  assert.ok(typingResult.input.startsWith('I run Luna Hair Studio'));
  assert.ok(typing.calls.some((c) => c[0] === 'chip' && c[1] === 'Build your bot'));
  assert.ok(
    typing.calls.some(
      (c) => c[0] === 'msg' && c[1] === 'assistant' && c[2] === 'Hi! Tell me about your business.'
    )
  );
  assert.ok(!typing.calls.some((c) => c[0] === 'msg' && c[1] === 'user'));
  const last = typing.calls[typing.calls.length - 1];
  assert.equal(last[0], 'input');

  const summary = mockUi();
  applyCue(luna, 'summary', summary);
  const lastMsg = [...summary.calls].reverse().find((c) => c[0] === 'msg');
  assert.equal(lastMsg[1], 'assistant');
  assert.ok(lastMsg[2].includes(SUMMARY_HEADING));
  assert.ok(!summary.calls.some((c) => c[0] === 'msg' && c[2] === 'Try my bot'));

  const finalUi = mockUi();
  applyCue(luna, 'final', finalUi);
  const lastFinal = [...finalUi.calls].reverse().find((c) => c[0] === 'msg');
  assert.equal(
    lastFinal[2],
    'Thanks, Sarah! Your request is for Thursday at 10am. The salon still needs to confirm availability.'
  );
}

function testTypingPacing() {
  const rng = () => 0.5;
  const word = charDelayMs('a', 1, 'cat', rng);
  const comma = charDelayMs(',', 3, 'Hi, x', rng);
  const period = charDelayMs('.', 2, 'Hi.', rng);
  assert.ok(word < comma, 'comma pause is longer than intra-word');
  assert.ok(comma < period, 'sentence pause is longer than comma');
  const short = incomingTypingMs('Hi!');
  const long = incomingTypingMs(EXPECTED_LINES.find((l) => l.text.includes(SUMMARY_HEADING)).text);
  assert.ok(long > short, 'typing indicator lasts longer for the summary');
  assert.ok(long <= 3800);
  assert.ok(short >= 850);
}

async function testPlayScriptNoNetworkAndOrder() {
  const urls = [];
  const fetchFn = async (url) => {
    urls.push(url);
    throw new Error('player must not fetch during playScript');
  };
  const ui = mockUi();
  const controller = createController();
  await playScript(luna, {
    ui,
    speed: 1000,
    controller,
    rng: () => 0.5,
    wait: async () => {},
    fetchFn,
  });
  assert.deepEqual(urls, []);
  const spoken = ui.calls
    .filter((c) => c[0] === 'msg')
    .map((c) => ({
      role: c[1] === 'user' ? 'outgoing' : 'incoming',
      text: c[2],
    }));
  assert.deepEqual(spoken, EXPECTED_LINES);
  assert.ok(ui.calls.some((c) => c[0] === 'subtitle' && c[1] === 'typing…'));
  assert.ok(ui.calls.some((c) => c[0] === 'pressSend'));
  assert.equal(ui.calls.filter((c) => c[0] === 'finish').length, 1);
}

const tests = [
  ['scriptHasExactLines', testScriptHasExactLines],
  ['demoParamsAndUrl', testDemoParamsAndUrl],
  ['noApiCallsInDemoCode', testNoApiCallsInDemoCode],
  ['normalComposerFixesPresent', testNormalComposerFixesPresent],
  ['loadScriptDoesNotHitApi', testLoadScriptDoesNotHitApi],
  ['cues', testCues],
  ['typingPacing', testTypingPacing],
  ['playScriptNoNetworkAndOrder', testPlayScriptNoNetworkAndOrder],
];

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok  ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`not ok  ${name}`);
    console.error(err);
  }
}
if (failed) {
  console.error(`${failed}/${tests.length} failed`);
  process.exit(1);
}
console.log(`${tests.length}/${tests.length} passed`);
