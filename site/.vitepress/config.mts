import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'Minions-ai',
  description: 'A fully configurable software factory of custom AI agent teams. One executable for cockpit, API and CLI.',
  base: '/minions-ai/',
  cleanUrls: true,
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/minions-ai/media/minions-ai-logo.svg' }],
    ['meta', { name: 'theme-color', content: '#0b1020' }],
  ],
  themeConfig: {
    logo: '/media/minions-ai-logo.svg',
    siteTitle: 'Minions-ai',
    nav: [
      { text: 'Download', link: 'https://github.com/siddharth-mishra-28/minions-ai/releases/latest' },
      { text: 'README', link: '/README' },
      { text: 'Teams guide', link: '/TEAMS-GUIDE' },
      { text: 'CLI', link: '/CLI' },
      { text: 'API', link: '/API' },
    ],
    sidebar: [
      {
        text: 'Get started',
        items: [
          { text: 'Overview', link: '/' },
          { text: 'Full README', link: '/README' },
          { text: 'Build from source', link: '/EXECUTABLE' },
        ],
      },
      {
        text: 'Use Minions-ai',
        items: [
          { text: 'Agent teams guide', link: '/TEAMS-GUIDE' },
          { text: 'CLI reference', link: '/CLI' },
          { text: 'REST API reference', link: '/API' },
          { text: 'A2A and team chat', link: '/A2A' },
        ],
      },
      {
        text: 'Operations',
        items: [
          { text: 'Security', link: '/SECURITY' },
          { text: 'Acceptance record', link: '/UAT' },
        ],
      },
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/siddharth-mishra-28/minions-ai' },
    ],
    footer: {
      message: 'MIT licensed. Built with the GitHub Copilot agent runtime.',
      copyright: 'Copyright © 2026 Minions-ai contributors',
    },
    outline: { level: [2, 3] },
    search: { provider: 'local' },
  },
});
