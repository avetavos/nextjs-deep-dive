// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

import preact from '@astrojs/preact';

// https://astro.build/config
export default defineConfig({
  site: 'https://deep-dive.avetavos.com',
  base: '/nextjs',
  output: 'static',
  integrations: [starlight({
      title: 'Next.js — From Zero to Hero',
      head: [
        { tag: 'script', attrs: { type: 'module', src: '/nextjs/enhance.js' } },
        { tag: 'link', attrs: { rel: 'manifest', href: '/nextjs/manifest.webmanifest' } },
        { tag: 'link', attrs: { rel: 'apple-touch-icon', href: '/nextjs/apple-touch-icon.png' } },
        { tag: 'link', attrs: { rel: 'icon', type: 'image/png', sizes: '192x192', href: '/nextjs/icon-192.png' } },
        { tag: 'meta', attrs: { name: 'theme-color', content: '#0070F3' } },
        { tag: 'meta', attrs: { name: 'mobile-web-app-capable', content: 'yes' } },
        { tag: 'meta', attrs: { name: 'apple-mobile-web-app-capable', content: 'yes' } },
        { tag: 'meta', attrs: { name: 'apple-mobile-web-app-status-bar-style', content: 'black-translucent' } },
        { tag: 'meta', attrs: { name: 'apple-mobile-web-app-title', content: "Next.js — From Zero to Hero" } },
        { tag: 'script', content: "if('serviceWorker' in navigator){window.addEventListener('load',function(){navigator.serviceWorker.register('/nextjs/sw.js',{scope:'/nextjs/'}).catch(function(){})})}" },
      ],
      defaultLocale: 'en',
      locales: {
        en: { label: 'English', lang: 'en' },
        th: { label: 'ไทย', lang: 'th' },
      },
      customCss: ['./src/styles/custom.css'],
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/avetavos/nextjs-deep-dive' }],
      sidebar: [
        { label: 'Foundations', items: [{ autogenerate: { directory: 'foundations' } }] },
        { label: 'Routing & Navigation', items: [{ autogenerate: { directory: 'routing-and-navigation' } }] },
        { label: 'Data Fetching & Caching', items: [{ autogenerate: { directory: 'data-fetching-and-caching' } }] },
        { label: 'Rendering', items: [{ autogenerate: { directory: 'rendering' } }] },
        { label: 'Server Actions & Mutations', items: [{ autogenerate: { directory: 'server-actions-and-mutations' } }] },
        { label: 'Optimization', items: [{ autogenerate: { directory: 'optimization' } }] },
        { label: 'Production & Ecosystem', items: [{ autogenerate: { directory: 'production-and-ecosystem' } }] },
      ],
      }), preact()],
});
