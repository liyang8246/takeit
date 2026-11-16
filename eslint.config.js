import antfu from '@antfu/eslint-config'

export default antfu(
  {
    pnpm: true,
    antislop: true,
    formatters: { html: true },
    test: false, // 使用 node:test，不迁移测试框架。
    ignores: ['.agents/**'],
  },
  {
    files: ['build.mjs', 'dev/**/*.ts'],
    rules: {
      // 独立构建脚本和自检直接使用顶层 await 与标准输出。
      'antfu/no-top-level-await': 'off',
      'no-console': 'off',
    },
  },
)
