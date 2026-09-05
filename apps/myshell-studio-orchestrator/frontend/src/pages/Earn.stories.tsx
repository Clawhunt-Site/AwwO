import type { Meta, StoryObj } from '@storybook/react-vite';
import Earn from './Earn';

const meta: Meta<typeof Earn> = {
  title: 'Pages/Earn',
  component: Earn,
  parameters: {
    layout: 'fullscreen',
    router: { path: '/earn' },
  },
};

export default meta;
type Story = StoryObj<typeof Earn>;

export const Default: Story = {};
