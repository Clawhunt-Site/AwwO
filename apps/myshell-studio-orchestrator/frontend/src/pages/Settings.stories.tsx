import type { Meta, StoryObj } from '@storybook/react-vite';
import Settings from './Settings';
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

const meta: Meta<typeof Settings> = {
  title: 'Pages/Settings',
  component: Settings,
  decorators: [withProviders],
};
export default meta;
type Story = StoryObj<typeof Settings>;

export const Default: Story = {};
