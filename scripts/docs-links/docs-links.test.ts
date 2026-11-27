import { expect, it } from 'vite-plus/test';

// The script is plain JS; a non-literal dynamic import keeps tsc from asking for declarations.
const moduleUrl = new URL('./docs-links.mjs', import.meta.url).href;
const { localLinkTargets } = await import(moduleUrl);

it('keeps relative .md and .mdx links and skips links with a scheme', () => {
  const page = [
    '[guide](./guide.md)',
    '[deep](../a/b.mdx)',
    '[readme](https://github.com/acme/web-app/blob/main/README.md)',
    '[upper](HTTPS://example.org/x.md)',
    '[mail](mailto:team@example.org.md)',
  ].join('\n');
  expect(localLinkTargets(page)).toEqual(['./guide.md', '../a/b.mdx']);
});
