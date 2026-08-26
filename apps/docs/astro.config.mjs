// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import remarkGfm from 'remark-gfm';

// https://astro.build/config
export default defineConfig({
  site: 'https://anderscan.github.io',
  base: '/ekrooh',
  devToolbar: {
    enabled: false,
  },
  markdown: {
    remarkPlugins: [remarkGfm],
  },
  vite: {},
  integrations: [
    starlight({
      title: 'Ekrooh',
      description:
        'One soul, many platforms — the boring bootstrap for cross-platform apps on the Bare runtime.',
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/anderscan/ekrooh',
        },
      ],
      sidebar: [
        {
          label: 'Getting Started',
          items: [
            { label: 'Introduction', slug: 'getting-started/introduction' },
            { label: 'Installation', slug: 'getting-started/installation' },
            { label: 'Web Quickstart', slug: 'getting-started/web-quickstart' },
            { label: 'Architecture', slug: 'getting-started/architecture' },
          ],
        },
        {
          label: 'Core Concepts',
          items: [
            { label: 'Wire Protocol', slug: 'core-concepts/wire-protocol' },
            { label: 'Plugin Kernel', slug: 'core-concepts/plugin-kernel' },
            { label: 'Transports', slug: 'core-concepts/transports' },
            {
              label: 'Loopback Server & Auth',
              slug: 'core-concepts/loopback-server-auth',
            },
            { label: 'State Machines', slug: 'core-concepts/state-machines' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { label: 'Media (Out-of-Band Bytes)', slug: 'guides/media' },
            { label: 'Permissions', slug: 'guides/permissions' },
            { label: 'Calling a Native Function', slug: 'guides/call-native-function' },
          ],
        },
        {
          label: 'Consumers',
          items: [
            {
              label: 'End-to-End Quickstart',
              slug: 'consumers/end-to-end',
            },
            { label: 'Web Rendering', slug: 'consumers/rendering' },
            { label: 'Worklet Entry', slug: 'consumers/worklet-entry' },
            {
              label: 'Authoring a Plugin',
              slug: 'consumers/authoring-plugins',
            },
            {
              label: 'Android AAR Setup',
              slug: 'consumers/android-aar',
            },
            {
              label: 'Android Host Build',
              slug: 'consumers/android-host-build',
            },
            {
              label: 'iOS Embedding',
              slug: 'consumers/ios-embedding',
            },
            {
              label: 'Host Handoff Flow',
              slug: 'consumers/host-handoff',
            },
            {
              label: 'P2P Folder Stack',
              slug: 'consumers/p2p-folder-stack',
            },
            {
              label: 'Backend → Web Push',
              slug: 'consumers/backend-push',
            },
            {
              label: 'Custom HTTP Routes',
              slug: 'consumers/custom-routes',
            },
            {
              label: 'Dev Mode & Storage',
              slug: 'consumers/dev-mode-storage',
            },
            { label: 'Desktop', slug: 'consumers/desktop' },
          ],
        },
        {
          label: 'Hosts',
          items: [
            { label: 'Android', slug: 'hosts/android' },
            { label: 'iOS', slug: 'hosts/ios' },
            { label: 'Testing', slug: 'hosts/testing' },
          ],
        },
        {
          label: 'API Reference',
          items: [
            { label: '@ekrooh/bare/core', slug: 'reference/core' },
            { label: '@ekrooh/bare/runtime', slug: 'reference/runtime' },
            { label: '@ekrooh/bare/plugins', slug: 'reference/plugins' },
            { label: '@ekrooh/bare/transports', slug: 'reference/transports' },
          ],
        },
      ],
    }),
  ],
});
