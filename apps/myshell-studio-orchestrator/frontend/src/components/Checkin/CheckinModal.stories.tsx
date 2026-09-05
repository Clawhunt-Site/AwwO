import type { Meta, StoryObj } from '@storybook/react-vite';
import { EnergyProvider } from '../../contexts/EnergyContext';
import { ToastProvider } from '../../contexts/ToastContext';
import CheckinModal from './CheckinModal';
import { resetMockCheckin } from '../../services/checkin';

const meta = {
  title: 'Components/CheckinModal',
  component: CheckinModal,
  parameters: {
    layout: 'fullscreen',
  },
  decorators: [
    (Story) => (
      <EnergyProvider>
        <ToastProvider>
          <div className="bg-Cr-Bg-soft-v2 min-h-screen">
            <Story />
          </div>
        </ToastProvider>
      </EnergyProvider>
    ),
  ],
} satisfies Meta<typeof CheckinModal>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Day1Claimable: Story = {
  args: {
    open: true,
    onClose: () => {},
    source: 'sidebar',
  },
  play: () => {
    resetMockCheckin(0);
  },
};

export const Day3BonusClaimable: Story = {
  args: {
    open: true,
    onClose: () => {},
    source: 'sidebar',
  },
  play: () => {
    resetMockCheckin(2);
  },
};

export const AlreadyClaimed: Story = {
  args: {
    open: true,
    onClose: () => {},
    source: 'auto',
  },
  play: () => {
    resetMockCheckin(3);
  },
};

export const Day7BigReward: Story = {
  args: {
    open: true,
    onClose: () => {},
    source: 'auto',
  },
  play: () => {
    resetMockCheckin(6);
  },
};

export const Closed: Story = {
  args: {
    open: false,
    onClose: () => {},
  },
};
