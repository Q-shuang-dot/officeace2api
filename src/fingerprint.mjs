export function fingerprintOf(cred) {
  const auth = Object.entries(cred.headers || {}).find(([k]) => k.toLowerCase() === 'authorization')?.[1] || '';
  return `${cred.baseUrl}||${auth}`;
}
