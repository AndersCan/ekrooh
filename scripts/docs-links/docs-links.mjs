/**
 * The `.md` and `.mdx` link targets in a docs page that point at a local
 * file. A target with a scheme (`https:`, `mailto:`) is not a local file.
 */
export function localLinkTargets(source) {
  const targets = [];
  for (const match of source.matchAll(/\]\(([^)]+\.mdx|[^)]+\.md)\)/g)) {
    const target = match[1];
    if (!/^[a-z][a-z0-9+.-]*:/i.test(target)) targets.push(target);
  }
  return targets;
}
