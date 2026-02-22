const ISRAEL_KEYWORDS = ['israel'];

const ISRAEL_CITIES = [
  'tel aviv',
  'tel-aviv',
  'herzliya',
  'haifa',
  'jerusalem',
  'rehovot',
  'ramat gan',
  'petah tikva',
  'netanya',
  "ra'anana",
  'hod hasharon',
  'kfar saba',
  'givatayim',
];

function passesLocationGate(location) {
  const raw = (location ?? '').toString().trim();
  if (!raw) return false;

  const loc = raw.toLowerCase();

  const hasIsrael = ISRAEL_KEYWORDS.some((keyword) => loc.includes(keyword));
  const hasCity = ISRAEL_CITIES.some((city) => loc.includes(city));
  const isExactRemote = loc === 'remote';
  const hasRemote = loc.includes('remote');

  // 1. Any mention of Israel or approved Israeli cities is accepted.
  if (hasIsrael || hasCity) {
    return true;
  }

  // 3. Exact "Remote" (case-insensitive, trimmed) is accepted.
  if (isExactRemote) {
    return true;
  }

  // 4 + Explicit rejection: any remote location that does not explicitly
  // mention Israel (and is not exactly "Remote") must be rejected.
  if (hasRemote && !hasIsrael) {
    return false;
  }

  // Everything else is rejected.
  return false;
}

module.exports = {
  passesLocationGate,
};
