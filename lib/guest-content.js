const DECOY_CONVERSATION = [
  { sender: 'Mira', text: 'Morning — did we land on a time for the sync today?' },
  { sender: 'Ash', text: 'I can do 2pm if that works for everyone else.' },
  { sender: 'Riven', text: '2pm works. I\'ll share the doc link before we start.' },
  { sender: 'Sora', text: 'Perfect. I added notes from yesterday\'s thread to the pinned doc.' },
  { sender: 'Cleo', text: 'Quick heads-up: uploads are capped at 100MB per file in this room.' },
  { sender: 'Dane', text: 'Thanks — I was about to send a screen recording.' },
  { sender: 'Iris', text: 'The General room moves fast when everyone\'s online.' },
  { sender: 'Noor', text: 'Agreed. Worth pinning anything we need to keep.' },
  { sender: 'Vale', text: 'Pinned the launch checklist. Take a look when you can.' },
  { sender: 'Jun', text: 'Looks good. One open question on the invite flow.' },
  { sender: 'Elias', text: 'Invite flow is members-only for private rooms — public is open.' },
  { sender: 'Nyx', text: 'Got it. I\'ll test with a second account later.' },
  { sender: 'Kai', text: 'Screenshots from staging are in the thread above.' },
  { sender: 'Lumen', text: 'Nice — the dark theme reads much better now.' },
  { sender: 'Arden', text: 'Sign in if you need full history, uploads, and private rooms.' },
];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function buildDecoyMessages(count, roomName) {
  const total = Math.max(1, Math.min(count, DECOY_CONVERSATION.length));
  const now = Date.now();
  return DECOY_CONVERSATION.slice(0, total).map((entry, index) => ({
    id: `decoy-${roomName}-${index}`,
    decoy: true,
    type: 'text',
    text: entry.text,
    senderName: entry.sender,
    senderId: `decoy-${index}`,
    ts: now - (total - index + 2) * 90_000,
    room: roomName,
  }));
}

const RANDOM_GUEST_ADJECTIVES = [
  'Quiet', 'Swift', 'Calm', 'Bold', 'Wandering', 'Curious', 'Lucky', 'Hidden', 'Gentle', 'Bright',
];

const RANDOM_GUEST_NOUNS = [
  'Otter', 'Heron', 'Fox', 'Lark', 'Pine', 'Comet', 'River', 'Ember', 'Moth', 'Reed',
];

function randomGuestName() {
  const adj = pick(RANDOM_GUEST_ADJECTIVES);
  const noun = pick(RANDOM_GUEST_NOUNS);
  return `${adj} ${noun}`;
}

function sanitizeGuestName(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9 _-]/g, '')
    .slice(0, 24) || randomGuestName();
}

module.exports = {
  buildDecoyMessages,
  randomGuestName,
  sanitizeGuestName,
};
