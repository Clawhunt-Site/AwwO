import type { Meta, StoryObj } from '@storybook/react-vite';
import BotDetail from './BotDetail';

const meta: Meta<typeof BotDetail> = {
  title: 'Pages/BotDetail',
  component: BotDetail,
  parameters: {
    layout: 'fullscreen',
    router: { path: '/bot?slug_id=demo-bot' },
  },
};

export default meta;
type Story = StoryObj<typeof BotDetail>;

export const Default: Story = {};
