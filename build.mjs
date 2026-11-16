import { build } from 'esbuild'
import { readFileSync, writeFileSync } from 'node:fs'
import { Resvg } from '@resvg/resvg-js'

const base = { bundle: true, minify: true, logLevel: 'info' }

// npm 只分发这个零运行时依赖的 CLI。
await build({
  ...base,
  entryPoints: ['src/cli/main.ts'],
  outfile: 'dist/cli.mjs',
  platform: 'node',
  format: 'esm',
  target: 'node22.18',
  banner: { js: '#!/usr/bin/env node' },
})

// 图标: lucide accessibility (ISC), 深色圆角底 + 白色描边
const GLYPH =
  '<circle cx="16" cy="4" r="1"/><path d="m18 19 1-7-6 1"/><path d="m5 8 3-3 5.5 3-2.36 3.5"/><path d="M4.24 14.5a5 5 0 0 0 6.88 6"/><path d="M13.76 17.5a5 5 0 0 0-6.88-6"/>'
const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">
  <rect width="48" height="48" rx="11" fill="#1e2430"/>
  <g transform="translate(8 8) scale(1.3333)" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${GLYPH}</g>
</svg>`
for (const px of [16, 32, 48, 128]) {
  writeFileSync(`extension/icon-${px}.png`, new Resvg(iconSvg, { fitTo: { mode: 'width', value: px } }).render().asPng())
}
// jQuery 源码内联进 bg.js, /script 注入页面时用, 不依赖外网
const jquery = readFileSync('node_modules/jquery/dist/jquery.min.js', 'utf8')

// 扩展: IIFE, 直接 <script src> 加载
for (const name of ['bg', 'offscreen', 'popup']) {
  await build({
    ...base,
    entryPoints: [`src/ext/${name}.ts`],
    outfile: `extension/${name}.js`,
    platform: 'browser',
    format: 'iife',
    target: 'chrome116',
    ...(name === 'bg' ? { define: { __JQUERY__: JSON.stringify(jquery) } } : {}),
  })
}
