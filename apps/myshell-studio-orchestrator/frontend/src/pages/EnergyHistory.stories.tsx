import type { Meta, StoryObj } from '@storybook/react-vite';
import EnergyHistory from './EnergyHistory';

const meta: Meta<typeof EnergyHistory> = {
  title: 'Pages/EnergyHistory',
  component: EnergyHistory,
  parameters: {
    layout: 'fullscreen',
    router: { path: '/energy-history' },
  },
};

export default meta;
type Story = StoryObj<typeof EnergyHistory>;

export const Default: Story = {};
