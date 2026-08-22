import nextConfig from 'eslint-config-next'
import nextTs from 'eslint-config-next/typescript'

const config = [
  {
    ignores: ['node_modules/**', '.next/**', 'out/**', 'scripts/**'],
  },
  ...nextConfig,
  ...nextTs,
  {
    rules: {
      // 기존 코드가 any를 광범위하게 사용 — 점진적으로 줄여나갈 것
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
]

export default config
