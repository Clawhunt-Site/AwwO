import type { Meta, StoryObj } from '@storybook/react-vite';
import AiPicks from './AiPicks';

const meta: Meta<typeof AiPicks> = {
  title: 'Pages/AiPicks',
  component: AiPicks,
  parameters: {
    layout: 'fullscreen',
    router: { path: '/ai-picks' },
  },
};

export default meta;
type Story = StoryObj<typeof AiPicks>;

export const Default: Story = {};
