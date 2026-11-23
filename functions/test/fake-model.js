// A canned model answer for emulator runs (FAKE_AI=1). Never used in production.
export function fakeAnswer(_schema, app) {
  if (app === 'movi') return { results: [{ line: 0, films: [{ title: 'Star Wars', year: 1977 }], series: [] }] };
  return {
    title: 'Garlic Spinach Eggs', description: 'Quick.', meal: 'breakfast', servings: 2, prepMin: 5, cookMin: 10, totalTimeMin: 15, difficulty: 'Easy',
    ingredients: [{ amount: 4, unit: '', us: '', item: 'eggs', note: '', fromPantry: true }], steps: ['Cook.'], tips: [],
    nutrition: { calories: 300, protein_g: 20, carbs_g: 5, fat_g: 20, fiber_g: 2 }, needsToBuy: [],
    // label-check shape (extra keys are ignored by whichever handler runs)
    productGuess: 'Cereal', score: 140, summary: 'ok', nutritionNotes: '', items: [], concerns: [], positives: [], swaps: [], confidence: 'low',
  };
}
