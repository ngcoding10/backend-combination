// Typo-tolerant search (web/fuzzy.js), on Movi's real film list when it is checked out next door.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createFuzzyIndex, editDistance, foldText, wordScore } from '../web/fuzzy.js';

const first = (index, q, o) => index.search(q, o)[0]?.item;

test('basics', () => {
  assert.equal(foldText("Amélie & Schindler's List!"), 'amelie and schindlers list');
  assert.equal(editDistance('madird', 'madrid'), 1);       // swapped letters count once
  assert.equal(editDistance('avenjers', 'avengers'), 1);
  assert.ok(editDistance('cat', 'elephant', 2) > 2);
  assert.equal(wordScore('the', 'thy'), 0);                 // short words must be exact
  assert.ok(wordScore('aven', 'avengers') > wordScore('avenjers', 'avengers'));
});

const films = [
  ['The Avengers', 90], ['Avengers: Endgame', 95], ['Avatar', 92], ['The Avenging Conscience', 2], ['Scavengers', 5], ['Seven', 56], ['Se7en', 0],
  ['Spider-Man', 80], ['Star Wars', 99], ['The Lord of the Rings: The Two Towers', 88], ['Amélie', 56], ["Schindler's List", 90], ['Madagascar', 60],
].map(([title, pop]) => ({ title, pop }));
const filmIndex = createFuzzyIndex(films, (f) => f.title, { weight: (f) => f.pop });

test('misspelled film titles', () => {
  for (const q of ['avenjers', 'avgenrs', 'avengrs', 'avangers', 'avengesr', 'avengers']) {
    const top = filmIndex.search(q).slice(0, 2).map((r) => r.item.title).sort();
    assert.deepEqual(top, ['Avengers: Endgame', 'The Avengers'], q);
  }
  assert.equal(first(filmIndex, 'spiderman').title, 'Spider-Man');
  assert.equal(first(filmIndex, 'spidr man').title, 'Spider-Man');
  assert.equal(first(filmIndex, 'starwars').title, 'Star Wars');
  assert.equal(first(filmIndex, 'lord of teh rings').title, 'The Lord of the Rings: The Two Towers');
  assert.equal(first(filmIndex, 'amelie').title, 'Amélie');
  assert.equal(first(filmIndex, 'shindlers list').title, "Schindler's List");
  assert.equal(first(filmIndex, 'aveng endgme').title, 'Avengers: Endgame');
  assert.deepEqual(filmIndex.search('zzzzqqq'), []);
  assert.deepEqual(filmIndex.search(''), []);
});

test('misspelled places and ingredients', () => {
  const places = [['Madrid', 3200000], ['Madras', 100], ['Madison', 270000], ['Mardin', 90000], ['Paris', 2100000], ['São Paulo', 12000000], ['Reykjavík', 130000], ['Kuala Lumpur', 1800000]].map(([name, pop]) => ({ name, pop }));
  const p = createFuzzyIndex(places, (x) => x.name, { weight: (x) => x.pop });
  for (const q of ['madid', 'madird', 'madrd', 'madrid', 'mdrid']) assert.equal(first(p, q).name, 'Madrid', q);
  assert.equal(first(p, 'sao paolo').name, 'São Paulo');
  assert.equal(first(p, 'reykjavic').name, 'Reykjavík');
  assert.equal(first(p, 'kuala lumpar').name, 'Kuala Lumpur');

  const foods = ['Monosodium glutamate', 'Sodium benzoate', 'Xanthan gum', 'Turmeric', 'Butylated hydroxyanisole', 'Potassium sorbate', 'Carrageenan', 'Aspartame', 'High-fructose corn syrup', 'Quinoa'].map((name) => ({ name }));
  const f = createFuzzyIndex(foods, (x) => x.name);
  const cases = { 'monosodium glutamte': 'Monosodium glutamate', 'sodum benzoate': 'Sodium benzoate', 'xantham gum': 'Xanthan gum', tumeric: 'Turmeric', 'butylated hydroxyanisol': 'Butylated hydroxyanisole', caragenan: 'Carrageenan', aspartam: 'Aspartame', 'high fructose corn syrip': 'High-fructose corn syrup', qinoa: 'Quinoa', 'potasium sorbat': 'Potassium sorbate' };
  for (const [q, want] of Object.entries(cases)) assert.equal(first(f, q)?.name, want, q);
  assert.equal(first(f, 'gum', { filter: (x) => x.name !== 'Xanthan gum' }), undefined);
});

test('fast enough to run on every keystroke, even on a big list', () => {
  const syll = ['ka', 'lo', 'mi', 'ne', 'ru', 'sa', 'ti', 'vo', 'be', 'da', 'fu', 'gi', 'ho', 'je', 'pa', 'qu'];
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const names = Array.from({ length: 230000 }, (_, i) => ({ name: Array.from({ length: 2 + Math.floor(rnd() * 3) }, () => syll[Math.floor(rnd() * syll.length)]).join('') + (i % 3 ? '' : ' ' + syll[i % 16] + syll[(i >> 4) % 16] + syll[(i >> 8) % 16]) }));
  const big = createFuzzyIndex(names, (x) => x.name);
  big.search('warmup');
  const t = performance.now();
  for (const q of ['kalomine', 'rusatvo', 'bedafugi', 'hojepaqu lomi', 'tivobeda']) big.search(q);
  const each = (performance.now() - t) / 5;
  assert.ok(each < 150, `took ${each.toFixed(0)} ms per search`);
});

test('real film list', { skip: !existsSync('../claude/docs/data/index.json') && 'Movi is not checked out next to this repo' }, () => {
  const data = JSON.parse(readFileSync('../claude/docs/data/index.json', 'utf8'));
  const all = data.films.map(([title, year, , , pop, alt], id) => ({ id, title, year, pop, alt: alt || [] }));
  const index = createFuzzyIndex(all, (f) => [f.title, ...f.alt], { weight: (f) => f.pop });
  const t = performance.now();
  const top = (q) => index.search(q, { limit: 5 }).map((r) => r.item.title);
  assert.ok(top('avenjers').some((x) => /^(The )?Avengers/.test(x)), top('avenjers').join(' | '));
  assert.ok(top('avgenrs').some((x) => /^(The )?Avengers/.test(x)), top('avgenrs').join(' | '));
  assert.ok(top('inceptoin').includes('Inception'));
  assert.ok(top('godfahter').some((x) => x.startsWith('The Godfather')));
  assert.ok(top('intersteller').includes('Interstellar'));
  assert.ok(top('shawshenk redemtion').includes('The Shawshank Redemption'));
  assert.ok(top('parasit').includes('Parasite'));
  assert.ok((performance.now() - t) / 7 < 150);
});
