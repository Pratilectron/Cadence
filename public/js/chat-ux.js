let audioCtx = null;
let titleTimer = null;
let titleFlash = false;

function getAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

function playTone({ frequency, duration = 0.12, volume = 0.08, type = 'sine', delay = 0 }) {
  try {
    const ctx = getAudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = frequency;
    gain.gain.value = volume;
    osc.connect(gain);
    gain.connect(ctx.destination);
    const start = ctx.currentTime + delay;
    osc.start(start);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    osc.stop(start + duration + 0.02);
  } catch {
    // audio may be blocked until user gesture
  }
}

export function playReceiveSound(enabled = true) {
  if (!enabled) return;
  playTone({ frequency: 520, duration: 0.1, volume: 0.07 });
  playTone({ frequency: 780, duration: 0.14, volume: 0.05, delay: 0.08 });
}

export function playSendSound(enabled = true) {
  if (!enabled) return;
  playTone({ frequency: 420, duration: 0.08, volume: 0.06, type: 'triangle' });
  playTone({ frequency: 640, duration: 0.1, volume: 0.04, type: 'triangle', delay: 0.05 });
}

export function playActivitySound(enabled = true) {
  if (!enabled) return;
  playTone({ frequency: 300, duration: 0.06, volume: 0.04, type: 'sine' });
}

export function stopTitlePulse() {
  if (titleTimer) {
    clearInterval(titleTimer);
    titleTimer = null;
  }
}

export function updateDocumentTitle({ appName = 'Cadence', unread = 0, lastSender = '', pulse = false }) {
  const base = appName;
  if (!unread || document.visibilityState === 'visible') {
    document.title = unread > 0 ? `(${unread}) ${base}` : base;
    return;
  }

  if (!pulse) {
    document.title = lastSender ? `(${unread}) ${lastSender} — ${base}` : `(${unread}) ${base}`;
    return;
  }

  titleFlash = !titleFlash;
  if (titleFlash) {
    document.title = lastSender ? `✦ ${lastSender} — ${base}` : `✦ (${unread}) ${base}`;
  } else {
    document.title = lastSender ? `(${unread}) ${lastSender}…` : `(${unread}) new — ${base}`;
  }
}

export function startTitlePulse(getState) {
  stopTitlePulse();
  titleTimer = window.setInterval(() => {
    const state = getState();
    if (!state.titleNotifications || !state.unreadTotal || document.visibilityState === 'visible') {
      updateDocumentTitle({
        appName: state.appName,
        unread: state.unreadTotal,
        lastSender: state.lastSender,
        pulse: false,
      });
      return;
    }
    updateDocumentTitle({
      appName: state.appName,
      unread: state.unreadTotal,
      lastSender: state.lastSender,
      pulse: true,
    });
  }, 1100);
}

export function notifyDesktop({ enabled, title, body, onClick }) {
  if (!enabled || !('Notification' in window)) return;
  if (Notification.permission === 'granted') {
    const note = new Notification(title, { body, tag: 'cadence-msg' });
    if (onClick) note.onclick = onClick;
    return;
  }
  if (Notification.permission !== 'denied') {
    Notification.requestPermission().then((perm) => {
      if (perm === 'granted') notifyDesktop({ enabled, title, body, onClick });
    });
  }
}

export function primeAudioOnGesture() {
  const unlock = () => {
    getAudioContext();
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
  };
  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('keydown', unlock, { once: true });
}
