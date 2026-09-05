import type { Meta, StoryObj } from '@storybook/react-vite';
import ShareInvite from './ShareInvite';
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

const meta: Meta<typeof ShareInvite> = {
  title: 'Pages/ShareInvite',
  component: ShareInvite,
  decorators: [withProviders],
};
export default meta;
type Story = StoryObj<typeof ShareInvite>;

export const Default: Story = {};
