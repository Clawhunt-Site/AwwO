import type { StorybookConfig } from '@storybook/react-vite';

const config: StorybookConfig = {
  stories: ['../src/**/*.stories.@(ts|tsx)'],
  addons: [
    '@storybook/addon-docs',
    '@storybook/addon-a11y',
  ],
  framework: {
    name: '@storybook/react-vite',
    options: {},
  },
  viteFinal(config) {
    // Tailwind v4 via @tailwindcss/vite is already in the project's vite.config.ts
    // and Storybook's react-vite framework auto-merges it.
    return config;
  },
};
export default config;
