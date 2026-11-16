const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  parseGithubLink,
  splitWordsPreview,
  parseTriageYaml,
  generateGhScript,
  serializeTriageYaml,
} = require('../src/triage-core');

// 1. Test GitHub URL parsing
const parsedPr = parseGithubLink('https://github.com/agent-substrate/substrate/pull/3867', 'pr');
assert.strictEqual(parsedPr.repo, 'agent-substrate/substrate');
assert.strictEqual(parsedPr.kind, 'pr');
assert.strictEqual(parsedPr.number, '3867');

const parsedIssue = parseGithubLink('https://github.com/agent-substrate/substrate/issues/3876', 'issue');
assert.strictEqual(parsedIssue.repo, 'agent-substrate/substrate');
assert.strictEqual(parsedIssue.kind, 'issue');
assert.strictEqual(parsedIssue.number, '3876');

// 2. Test 200-word preview splitting & collapse behavior
const twoHundredFiftyWords = Array.from({ length: 250 }, (_, idx) => `word${idx + 1}`).join(' ');
const splitResult = splitWordsPreview(twoHundredFiftyWords, 200);
assert.strictEqual(splitResult.isTruncated, true);
assert.strictEqual(splitResult.totalWords, 250);
assert.strictEqual(splitResult.hiddenWords, 50);
assert.strictEqual(splitResult.previewText.split(/\s+/).length, 200);
assert(splitResult.previewText.endsWith('word200'));
assert(splitResult.remainingText.trim().startsWith('word201'));

const shortText = 'Short description with only seven words.';
const shortSplit = splitWordsPreview(shortText, 200);
assert.strictEqual(shortSplit.isTruncated, false);
assert.strictEqual(shortSplit.totalWords, 6);
assert.strictEqual(shortSplit.hiddenWords, 0);

// 3. Test sample-triage.yaml parsing (including full description)
const samplePath = path.join(__dirname, '..', 'sample-triage.yaml');
const sampleYaml = fs.readFileSync(samplePath, 'utf8');
const items = parseTriageYaml(sampleYaml);

assert.strictEqual(items.length, 4, 'Expected 4 items (2 PRs, 2 Issues)');
assert.strictEqual(items[0].type, 'pr');
assert.strictEqual(items[0].number, '3867');
assert.deepStrictEqual(items[0].currentLabels, ['area/runtime', 'needs-triage']);
assert.strictEqual(items[0].labels.length, 3);
assert(items[0].description.length > 0, 'Expected full description on PR #3867');
const pr3867Split = splitWordsPreview(items[0].description, 200);
assert.strictEqual(pr3867Split.isTruncated, true, 'Expected PR #3867 description to exceed 200 words');

// 4. Test gh CLI script generation
const script = generateGhScript(items);
assert(
  script.includes(
    'gh pr edit 3867 -R agent-substrate/substrate --add-label "kind/bug,priority/p1" --remove-label "needs-triage"'
  ),
  'Expected combined gh pr edit command for PR #3867'
);
assert(
  script.includes(
    'gh issue edit 3876 -R agent-substrate/substrate --add-label "area/parser,kind/bug" --remove-label "kind/Cleanup,needs-triage"'
  ),
  'Expected combined gh issue edit command for Issue #3876'
);

// 5. Test disabling a label change updates the generated script
items[0].labels[0].enabled = false; // disable 'kind/bug'
const updatedScript = generateGhScript(items);
assert(
  updatedScript.includes(
    'gh pr edit 3867 -R agent-substrate/substrate --add-label "priority/p1" --remove-label "needs-triage"'
  ),
  'Expected disabled label to be omitted from gh command'
);

// 6. Test round-trip YAML serialization preserves description
const serialized = serializeTriageYaml(items);
const reparsed = parseTriageYaml(serialized);
assert.strictEqual(reparsed.length, 4);
assert.strictEqual(reparsed[0].description, items[0].description);
assert.strictEqual(reparsed[0].labels.length, 2, 'Disabled label should not be exported in active YAML');

console.log('All triage-core tests passed successfully!');
