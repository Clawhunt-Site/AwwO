import type { Meta, StoryObj } from '@storybook/react-vite';
import { EnergyProvider } from '../contexts/EnergyContext';
import { ToastProvider } from '../contexts/ToastContext';
import { InviteProvider } from '../contexts/InviteContext';
import InviteBanner from './InviteBanner';

const meta: Meta<typeof InviteBanner> = {
  title: 'Components/InviteBanner',
  component: InviteBanner,
  decorators: [
    (Story) => (
      <EnergyProvider>
        <ToastProvider>
          <InviteProvider>
            <div className="relative h-[300px]">
              <Story />
            </div>
          </InviteProvider>
        </ToastProvider>
      </EnergyProvider>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof InviteBanner>;

/**
 * Default state — renders the banner when MSW provides init data
 * with no applied invite code.
 * The banner is hidden until init loads (from EnergyContext).
 * It also hides when hasApplied or bannerDismissed is true.
 */
export const Default: Story = {};
