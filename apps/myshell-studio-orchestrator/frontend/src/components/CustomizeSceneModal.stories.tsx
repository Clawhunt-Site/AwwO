import type { Meta, StoryObj } from '@storybook/react-vite';
import CustomizeSceneModal from './CustomizeSceneModal';

const meta = {
  title: 'Components/CustomizeSceneModal',
  component: CustomizeSceneModal,
  parameters: {
    layout: 'fullscreen',
  },
  decorators: [
    (Story) => (
      <div className="bg-Cr-Bg-soft-v2 min-h-screen">
        <Story />
      </div>
    ),
  ],
  args: {
    botId: '1745258157',
    slugId: 'ai-blowjob',
    onClose: () => {},
    onSubmit: (scene) => {
      // eslint-disable-next-line no-console
      console.log('submit', scene);
    },
  },
} satisfies Meta<typeof CustomizeSceneModal>;

export default meta;
type Story = StoryObj<typeof meta>;

// Default free state. Low/5s/Audio off → white "Create Now".
export const FreeDefault: Story = {
  args: {
    vipOverride: false,
  },
};

// Free user who has tapped a VIP option; the modal should now show the red
// "Unlock VIP to Create" CTA. Toggle a VIP option (Medium, 8s, or Audio) to
// see it.
export const FreeVipClicked: Story = {
  args: {
    vipOverride: false,
  },
  name: 'Free · VIP option clicked (interact)',
};

// VIP-unlocked user. All options selectable; badges render in gold; CTA is the
// white "Create Now" button regardless of selection.
export const VipUnlocked: Story = {
  args: {
    vipOverride: true,
  },
};
