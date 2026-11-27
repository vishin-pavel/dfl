import { defineConfig } from 'vitepress'

const rawBase = process.env.VITEPRESS_BASE || '/'
const base = rawBase.endsWith('/') ? rawBase : `${rawBase}/`

const siteTitle = 'dfl (devFlow)'
const siteDescription =
  'Deterministic Dev Workflows for Coding Agents (XState + MCP) — fresh-session diff verification, ISO/IEC 25010:2023 quality attributes, terminal DAG viewer, 100% local and zero telemetry.'
const siteOrigin = (process.env.VITEPRESS_SITE_URL || '').replace(/\/+$/, '')
const ogImage = `${siteOrigin}${base}assets/og-card.png`

export default defineConfig({
  srcDir: 'docs',
  base,
  lang: 'en-US',
  title: siteTitle,
  description: siteDescription,
  appearance: 'dark',
  lastUpdated: false,

  markdown: {
    config: (md) => {
      const defaultCodeInline = md.renderer.rules.code_inline
      md.renderer.rules.code_inline = (tokens, idx, options, env, self) => {
        const token = tokens[idx]
        if (token.content.includes('{{') || token.content.includes('}}')) {
          token.attrSet('v-pre', '')
        }
        return defaultCodeInline
          ? defaultCodeInline(tokens, idx, options, env, self)
          : self.renderToken(tokens, idx, options)
      }
    },
  },

  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: `${base}assets/og-card.svg` }],
    ['meta', { name: 'theme-color', content: '#0b1120' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:site_name', content: siteTitle }],
    [
      'meta',
      {
        property: 'og:title',
        content: 'dfl (devFlow) — Deterministic Dev Workflows for Coding Agents (XState + MCP)',
      },
    ],
    ['meta', { property: 'og:description', content: siteDescription }],
    ['meta', { property: 'og:image', content: ogImage }],
    ['meta', { property: 'og:image:width', content: '1280' }],
    ['meta', { property: 'og:image:height', content: '640' }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    [
      'meta',
      {
        name: 'twitter:title',
        content: 'dfl (devFlow) — Deterministic Dev Workflows for Coding Agents (XState + MCP)',
      },
    ],
    ['meta', { name: 'twitter:description', content: siteDescription }],
    ['meta', { name: 'twitter:image', content: ogImage }],
  ],

  themeConfig: {
    siteTitle: 'dfl (devFlow)',
    search: {
      provider: 'local',
    },

    nav: [
      { text: 'Guide', link: '/guide/dev-flow' },
      { text: 'MCP Server', link: '/guide/mcp-server' },
      { text: 'CLI', link: '/guide/cli-reference' },
      { text: 'Blog', link: '/blog/' },
      { text: 'npm', link: 'https://www.npmjs.com/package/@vishin-pavel/dfl' },
    ],

    sidebar: {
      '/guide/': [
        {
          text: 'Documentation',
          items: [
            { text: 'Built-In dev Flow', link: '/guide/dev-flow' },
            { text: 'Variables & Templates', link: '/guide/variables-and-templates' },
            { text: 'MCP Server & Authoring', link: '/guide/mcp-server' },
            { text: 'Jira Cloud Sync', link: '/guide/jira' },
            { text: 'CLI Reference', link: '/guide/cli-reference' },
          ],
        },
        {
          text: 'Engineering Blog',
          items: [
            { text: 'All Articles', link: '/blog/' },
            {
              text: 'Fresh-Session Diff Verification',
              link: '/blog/fresh-session-diff-verification',
            },
            {
              text: 'ISO 25010 AI Architecture',
              link: '/blog/iso-25010-ai-architecture',
            },
            {
              text: 'Terminal DAG (Ink + ELKjs)',
              link: '/blog/orthogonal-terminal-dag-ink-elkjs',
            },
          ],
        },
      ],
      '/blog/': [
        {
          text: 'Engineering Blog',
          items: [
            { text: 'Overview', link: '/blog/' },
            {
              text: 'Why I Stopped Letting Coding Agents Grade Their Own Homework',
              link: '/blog/fresh-session-diff-verification',
            },
            {
              text: 'Steering AI Architecture with ISO 25010 Quality Attributes',
              link: '/blog/iso-25010-ai-architecture',
            },
            {
              text: 'Building an Orthogonal Terminal DAG Viewer with Ink & ELKjs',
              link: '/blog/orthogonal-terminal-dag-ink-elkjs',
            },
          ],
        },
        {
          text: 'Reference Guides',
          items: [
            { text: 'Built-In dev Flow', link: '/guide/dev-flow' },
            { text: 'Variables & Templates', link: '/guide/variables-and-templates' },
            { text: 'MCP Server & Authoring', link: '/guide/mcp-server' },
            { text: 'Jira Cloud Sync', link: '/guide/jira' },
            { text: 'CLI Reference', link: '/guide/cli-reference' },
          ],
        },
      ],
    },

    socialLinks: [{ icon: 'github', link: 'https://github.com/vishin-pavel/dfl' }],

    footer: {
      message: 'Released under the MIT License · 100% Local · Zero Telemetry',
      copyright: 'Copyright © 2026 Pavel Vishin',
    },
  },
})
