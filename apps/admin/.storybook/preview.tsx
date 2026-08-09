import type { Preview } from '@storybook/react-vite';
import { MemoryRouter } from 'react-router-dom';
import { AdminThemeProvider } from '../src/ui/theme.js';
import '../src/carbon.scss';
import '../src/styles.css';

const preview: Preview = {
  parameters: {
    layout: 'padded',
    controls: { matchers: { color: /(background|color)$/i, date: /Date$/i } },
    docs: {
      toc: true,
      description: {
        component:
          'Canonical admin UI: Carbon g10, productive density (body-compact ~14px, heading-03 page titles, sm controls).',
      },
    },
  },
  decorators: [
    (Story) => (
      <AdminThemeProvider>
        <MemoryRouter>
          <div className="ops-storybook-surface">
            <Story />
          </div>
        </MemoryRouter>
      </AdminThemeProvider>
    ),
  ],
};

export default preview;
