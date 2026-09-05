import type { Meta, StoryObj } from '@storybook/react-vite';
import { EnergyProvider } from '../contexts/EnergyContext';
import { Sidebar } from './Sidebar';

const meta: Meta<typeof Sidebar> = {
  title: 'Components/Sidebar',
  component: Sidebar,
  decorators: [
    (Story) => (
      <EnergyProvider>
        <Story />
      </EnergyProvider>
    ),
  ],
  args: {
    onClose: () => {},
  },
};

export default meta;
type Story = StoryObj<typeof Sidebar>;

/**
 * Sidebar open — slides in from the left with overlay.
 */
export const Open: Story = {
  args: {
    isOpen: true,
  },
};

/**
 * Sidebar closed — off-screen (translated left).
 */
export const Closed: Story = {
  args: {
    isOpen: false,
  },
};
