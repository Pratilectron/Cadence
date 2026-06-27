const ADJECTIVES = ['Quiet', 'Swift', 'Calm', 'Bold', 'Wandering', 'Curious', 'Lucky', 'Hidden', 'Gentle', 'Bright'];
const NOUNS = ['Otter', 'Heron', 'Fox', 'Lark', 'Pine', 'Comet', 'River', 'Ember', 'Moth', 'Reed'];

export function randomGuestName() {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${adj} ${noun}`;
}

export function sanitizeGuestNameInput(value) {
  const clean = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9 _-]/g, '')
    .slice(0, 24);
  return clean || randomGuestName();
}
