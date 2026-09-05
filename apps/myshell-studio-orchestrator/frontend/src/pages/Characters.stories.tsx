import type { Meta, StoryObj } from '@storybook/react-vite';
import Explore from './Characters';
import { EnergyProvider } from '../contexts/EnergyContext';
import { ToastProvider } from '../contexts/ToastContext';
import { InviteProvider } from '../contexts/InviteContext';

const withProviders = (Story: React.ComponentType) => (
  <EnergyProvider>
    <ToastProvider>
      <InviteProvider>
        <Story />
      </InviteProvider>
    </ToastProvider>
  </EnergyProvider>
);

const meta: Meta<typeof Explore> = {
  title: 'Pages/Characters',
  component: Explore,
  decorators: [withProviders],
};
export default meta;
type Story = StoryObj<typeof Explore>;

export const Default: Story = {};
