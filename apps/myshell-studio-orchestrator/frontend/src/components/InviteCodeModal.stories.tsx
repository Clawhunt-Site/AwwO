import React, { useEffect } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { EnergyProvider } from '../contexts/EnergyContext';
import { ToastProvider } from '../contexts/ToastContext';
import { InviteProvider, useInvite } from '../contexts/InviteContext';
import InviteCodeModal from './InviteCodeModal';

/**
 * Helper wrapper that automatically opens the invite modal on mount.
 * Without this the modal would stay hidden because inviteModalOpen starts false.
 */
function OpenModalWrapper() {
  const { openInviteModal } = useInvite();
  useEffect(() => {
    openInviteModal();
  }, []);
  return <InviteCodeModal />;
}

const meta: Meta<typeof InviteCodeModal> = {
  title: 'Components/InviteCodeModal',
  component: InviteCodeModal,
  decorators: [
    (Story) => (
      <EnergyProvider>
        <ToastProvider>
          <InviteProvider>
            <Story />
          </InviteProvider>
        </ToastProvider>
      </EnergyProvider>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof InviteCodeModal>;

/**
 * Modal opened automatically via the OpenModalWrapper helper.
 * Uses real providers — the modal renders inside the Modal portal.
 */
export const Default: Story = {
  render: () => <OpenModalWrapper />,
};
