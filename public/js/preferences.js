export const GUEST_NAME_KEY = 'cadence_guest_name';
export const PREFS_KEY = 'cadence_prefs';

export const DEFAULT_PREFS = {
  soundEnabled: true,
  sendSoundEnabled: true,
  activitySounds: true,
  showTimestamps: true,
  titleNotifications: true,
  desktopNotifications: false,
};

export function loadLocalPreferences() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    return raw ? { ...DEFAULT_PREFS, ...JSON.parse(raw) } : { ...DEFAULT_PREFS };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function saveLocalPreferences(prefs) {
  localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
}

export function readGuestName() {
  try {
    return localStorage.getItem(GUEST_NAME_KEY) || '';
  } catch {
    return '';
  }
}

export function persistGuestName(name) {
  localStorage.setItem(GUEST_NAME_KEY, String(name || '').trim());
}

export function clearGuestName() {
  localStorage.removeItem(GUEST_NAME_KEY);
}
