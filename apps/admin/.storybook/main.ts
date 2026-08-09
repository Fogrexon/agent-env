import type { StorybookConfig } from '@storybook/react-vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

const config: StorybookConfig = {
  stories: ['../src/**/*.stories.@(ts|tsx)'],
  addons: ['@storybook/addon-docs'],
  framework: {
    name: '@storybook/react-vite',
    options: {},
  },
  viteFinal: async (config) => {
    config.css ??= {};
    config.css.preprocessorOptions ??= {};
    config.css.preprocessorOptions.scss ??= {};
    const scss = config.css.preprocessorOptions.scss as {
      includePaths?: string[];
      silenceDeprecations?: string[];
    };
    scss.includePaths = [
      path.resolve(rootDir, '../node_modules'),
      path.resolve(rootDir, '../../node_modules'),
    ];
    scss.silenceDeprecations = ['legacy-js-api', 'import'];
    return config;
  },
};

export default config;
