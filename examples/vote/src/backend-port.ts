/** The port from `?backend=`, or the fallback. Only plain digits are accepted. */
export function backendPort(search: string, fallback: number | string): string {
  const backend = new URLSearchParams(search).get('backend');
  return backend && /^\d{1,5}$/.test(backend) ? backend : String(fallback);
}
