import type { Meta, StoryObj } from '@storybook/react-vite';
import GetEnergy from './GetEnergy';

const meta: Meta<typeof GetEnergy> = {
  title: 'Pages/GetEnergy',
  component: GetEnergy,
  parameters: {
    layout: 'fullscreen',
    router: { path: '/energy' },
  },
};

export default meta;
type Story = StoryObj<typeof GetEnergy>;

export const Default: Story = {};
