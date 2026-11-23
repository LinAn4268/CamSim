// vitest.config.ts — 测试与覆盖率配置
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: 'coverage',
      // 仅统计可单测的纯逻辑模块；UI/WebGL/入口需浏览器端到端验证，不纳入单测覆盖率
      include: [
        'src/camera/**/*.ts',
        'src/utils/**/*.ts',
        'src/store/**/*.ts',
        'src/renderer/pipelinePlan.ts',
      ],
      exclude: [
        'src/**/*.test.ts',
        'src/camera/selfTest.ts', // 浏览器控制台自测，由 runCameraSelfTest 覆盖
      ],
      thresholds: {
        statements: 85,
        branches: 75,
        functions: 85,
        lines: 85,
      },
    },
  },
});
