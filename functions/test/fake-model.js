// A canned model answer for emulator runs (FAKE_AI=1). Never used in production.
export function fakeAnswer(_schema, app) {
  if (app === 'palette') return fakeMenu;
  if (app === 'movi') return { results: [{ line: 0, films: [{ title: 'Star Wars', year: 1977 }], series: [] }] };
  return {
    title: 'Garlic Spinach Eggs', description: 'Quick.', meal: 'breakfast', servings: 2, prepMin: 5, cookMin: 10, totalTimeMin: 15, difficulty: 'Easy',
    ingredients: [{ amount: 4, unit: '', us: '', item: 'eggs', note: '', fromPantry: true }], steps: ['Cook.'], tips: [],
    nutrition: { calories: 300, protein_g: 20, carbs_g: 5, fat_g: 20, fiber_g: 2 }, needsToBuy: [],
    // label-check shape (extra keys are ignored by whichever handler runs)
    productGuess: 'Cereal', score: 140, summary: 'ok', nutritionNotes: '', items: [], concerns: [], positives: [], swaps: [], confidence: 'low',
  };
}

const tags = (o) => ({ cuisine: 'thai', course: 'main', protein: 'none', diet: 'meat', method: 'stir_fried', heat: 1, richness: 1, sweetness: 1, sourness: 1, umami: 2, texture: [], ingredients: [], carb: 'rice', familiarity: 'common', temperature: 'hot', allergens: [], ...o });
const dish = (name, whatItIs, price, t, extra = {}) => ({ name, englishName: '', section: 'Mains', price, whatItIs, mainIngredients: t.ingredients ?? [], heatNote: 'mild', allergenNote: t.allergens?.length ? `Usually contains ${t.allergens.join(', ')}; recipes vary.` : 'No common allergens expected; recipes vary.', tags: tags(t), ...extra });
/** A small Thai menu (MyPalette, FAKE_AI=1). */
export const fakeMenu = {
  isMenu: true, readable: 'clear', problem: '', cuisineGuess: 'Thai',
  dishes: [
    dish('Pad Thai', 'Stir-fried rice noodles with egg, tofu, bean sprouts and crushed peanuts.', '$14', { protein: 'shellfish', diet: 'pescatarian', heat: 1, sweetness: 2, sourness: 2, texture: ['chewy'], ingredients: ['rice noodle', 'peanut', 'lime', 'egg', 'shrimp', 'tamarind'], carb: 'noodle', allergens: ['peanut', 'egg', 'shellfish', 'fish'] }),
    dish('Gai Pad Krapow', 'Minced chicken stir-fried with holy basil, garlic and chili over rice.', '$15', { protein: 'chicken', heat: 3, ingredients: ['chicken', 'holy basil', 'chili', 'garlic', 'fish sauce'], allergens: ['fish', 'soy'] }, { englishName: 'Holy basil chicken' }),
    dish('Tom Kha Gai', 'Mild coconut soup with chicken, galangal, lemongrass and lime.', '$9', { course: 'soup', protein: 'chicken', method: 'simmered', heat: 1, richness: 2, sourness: 2, texture: ['brothy', 'creamy'], ingredients: ['coconut milk', 'chicken', 'galangal', 'lemongrass', 'mushroom'], carb: 'none', allergens: ['fish'] }),
    dish('Green Curry with Tofu', 'Coconut curry with green chili paste, Thai eggplant, basil and tofu.', '$15', { protein: 'tofu', diet: 'vegan', method: 'simmered', heat: 2, richness: 2, texture: ['saucy'], ingredients: ['coconut milk', 'green curry paste', 'tofu', 'eggplant', 'basil'], allergens: ['soy'] }),
    dish('Som Tam', 'Shredded green papaya salad pounded with lime, chili, fish sauce and peanuts.', '$10', { course: 'salad', protein: 'none', diet: 'pescatarian', method: 'fresh', heat: 3, sourness: 3, texture: ['crunchy'], ingredients: ['green papaya', 'lime', 'chili', 'peanut', 'fish sauce'], carb: 'none', temperature: 'cold', allergens: ['peanut', 'fish', 'shellfish'] }, { englishName: 'Green papaya salad' }),
    dish('Massaman Beef', 'A mild, rich curry of slow-cooked beef, potato and peanuts in coconut milk.', '$17', { protein: 'beef', method: 'braised', heat: 1, richness: 3, sweetness: 2, texture: ['tender', 'saucy'], ingredients: ['beef', 'coconut milk', 'potato', 'peanut', 'cinnamon'], allergens: ['peanut', 'fish'] }),
    dish('Mango Sticky Rice', 'Sweet sticky rice with coconut cream and ripe mango.', '$8', { course: 'dessert', protein: 'none', diet: 'vegan', method: 'steamed', heat: 0, sweetness: 3, umami: 0, texture: ['sticky'], ingredients: ['sticky rice', 'mango', 'coconut milk'], allergens: [] }),
  ],
  picks: [{ index: 3, reason: 'A creamy curry with gentle heat, like the dishes you pick.' }, { index: 0, reason: 'You like noodles with lime.' }, { index: 9, reason: 'out of range, dropped' }],
};
