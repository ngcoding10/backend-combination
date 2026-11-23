// Function logic with a fake model and an in-memory meter: `npm test` (no emulator needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UserFacingError } from '../src/errors.js';
import { handleCheckLabel, handleGenerateRecipe, parseRecipeRequest, ZERO_LIST } from '../src/pantry.js';
import { handleMatchFilms, parseLines } from '../src/movi-match.js';
import { aggregate, scoreFor, scoresOf } from '../src/movi-stats.js';
import { fakeAnswer } from './fake-model.js';
import { publicError } from '../src/ai.js';

function fakeDeps(app, { perUser = 2, total = 100, fail = false } = {}) {
  const counts = new Map(), calls = [];
  const k = (a, uid) => `${a}:${uid}`;
  return {
    calls, counts,
    limits: { perUser, total },
    async ask(args) { calls.push(args); if (fail) throw Object.assign(new Error('overloaded'), { status: 529 }); return structuredClone(fakeAnswer(args.schema, app)); },
    meter: {
      async consume(a, uid, { perUser }) {
        const n = counts.get(k(a, uid)) ?? 0;
        if (n >= perUser) throw new UserFacingError('resource-exhausted', 'limit');
        counts.set(k(a, uid), n + 1);
        return { used: n + 1, limit: perUser };
      },
      async refund(a, uid) { counts.set(k(a, uid), (counts.get(k(a, uid)) ?? 1) - 1); },
    },
  };
}
const goodReq = { ingredients: ['Eggs', 'spinach', 'eggs', ''], meal: 'breakfast', servings: 2, maxMinutes: 20, diets: ['vegetarian'], strict: true, avoidZero: true, note: 'quick' };
const code = (c) => (e) => e instanceof UserFacingError && e.code === c;

test('pantry: requests are cleaned and bounded', () => {
  const r = parseRecipeRequest({ ...goodReq, servings: 99, maxMinutes: -5, note: 'x'.repeat(1000) });
  assert.deepEqual(r.ingredients, ['eggs', 'spinach']);
  assert.equal(r.servings, 12);
  assert.equal(r.maxMinutes, 0);
  assert.equal(r.note.length, 300);
  assert.throws(() => parseRecipeRequest({ meal: 'brunch' }), code('invalid-argument'));
});
test('pantry: recipe needs sign-in, counts usage and stops at the limit', async () => {
  const d = fakeDeps('pantry');
  await assert.rejects(handleGenerateRecipe(undefined, goodReq, d), code('unauthenticated'));
  assert.equal(d.calls.length, 0);
  const a = await handleGenerateRecipe('u1', goodReq, d);
  assert.equal(a.recipe.title, 'Garlic Spinach Eggs');
  assert.deepEqual(a.usage, { used: 1, limit: 2 });
  await handleGenerateRecipe('u1', goodReq, d);
  await assert.rejects(handleGenerateRecipe('u1', goodReq, d), code('resource-exhausted'));
  assert.equal(d.calls.length, 2);
  assert.equal((await handleGenerateRecipe('u2', goodReq, d)).usage.used, 1);
});
test('pantry: the avoid list reaches the prompt only when asked', async () => {
  const d = fakeDeps('pantry');
  assert.ok(ZERO_LIST.length > 10);
  await handleGenerateRecipe('u1', goodReq, d);
  assert.match(d.calls[0].system, new RegExp(ZERO_LIST[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  await handleGenerateRecipe('u1', { ...goodReq, avoidZero: false }, d);
  assert.doesNotMatch(d.calls[1].system, /scores these ingredients 0/);
});
test('pantry: a failed model call is refunded', async () => {
  const d = fakeDeps('pantry', { fail: true });
  await assert.rejects(handleGenerateRecipe('u1', goodReq, d));
  assert.equal(d.counts.get('pantry:u1'), 0);
});
test('pantry: label check validates input and clamps the score', async () => {
  const d = fakeDeps('pantry');
  await assert.rejects(handleCheckLabel('u1', {}, d), code('invalid-argument'));
  await assert.rejects(handleCheckLabel('u1', { image: 'not base64!' }, d), code('invalid-argument'));
  await assert.rejects(handleCheckLabel('u1', { image: 'A'.repeat(2_500_001) }, d), code('invalid-argument'));
  assert.equal(d.calls.length, 0);
  const r = await handleCheckLabel('u1', { kind: 'weird', text: 'sugar, salt', image: 'QUJD', flagged: ['x'] }, d);
  assert.equal(r.result.score, 100);
  assert.equal(d.calls[0].content[0].type, 'image');
  assert.match(d.calls[0].content[1].text, /food product/);
});
test('movi: lines are bounded and cleaned', async () => {
  assert.throws(() => parseLines({}), code('invalid-argument'));
  assert.throws(() => parseLines({ lines: Array(81).fill({ text: 'x' }) }), code('invalid-argument'));
  const [l] = parseLines({ lines: [{ text: 'a'.repeat(500), hints: Array(30).fill({ title: 't', year: '1999' }) }] });
  assert.equal(l.text.length, 200);
  assert.equal(l.hints.length, 12);
  assert.equal(l.hints[0].year, 1999);
});
test('movi: matching is metered per person and separately from the pantry', async () => {
  const d = fakeDeps('movi', { perUser: 1 });
  await assert.rejects(handleMatchFilms(undefined, { lines: [{ text: 'star wars' }] }, d), code('unauthenticated'));
  const r = await handleMatchFilms('u1', { lines: [{ text: 'star wars' }] }, d);
  assert.deepEqual(r.results, [{ line: 0, films: [{ title: 'Star Wars', year: 1977 }], series: [] }]);
  await assert.rejects(handleMatchFilms('u1', { lines: [{ text: 'x' }] }, d), code('resource-exhausted'));
  assert.equal(d.counts.get('pantry:u1'), undefined);
});
test('movi: scores match the website formula', () => {
  assert.equal(scoreFor('loved', 0, 1), 9.2);
  assert.equal(scoreFor('loved', 0, 3), 10);
  assert.equal(scoreFor('loved', 2, 3), 6.8);
  assert.equal(scoreFor('fine', 1, 3), 5.1);
  assert.equal(scoreFor('disliked', 0, 2), 3.3);
  assert.deepEqual([...scoresOf({ loved: [5, 'junk', -1, 6], fine: [5], disliked: null })], [[5, 10], [6, 6.8]]);
});
test('movi: site-wide averages and top list', () => {
  const { chunks, top } = aggregate([{ loved: [1, 2], fine: [], disliked: [4001] }, { loved: [2], fine: [1], disliked: [] }]);
  assert.deepEqual(chunks.get('0')[1], [8, 2]);   // (10 + 5.9) / 2
  assert.deepEqual(chunks.get('2')[4001], [2.5, 1]);
  assert.deepEqual(top.map((t) => t.filmId), [2, 1]);
});
test('errors shown to people never include internals', () => {
  assert.deepEqual(publicError(new Error('secret stack')), { code: 'internal', message: 'The AI request failed. Try again.' });
  assert.equal(publicError(new UserFacingError('resource-exhausted', 'limit')).message, 'limit');
});
