import type { Meta, StoryObj } from '@storybook/react-vite';
import Modal from './Modal';

const meta = {
  title: 'Components/Modal',
  component: Modal,
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
} satisfies Meta<typeof Modal>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Open: Story = {
  args: {
    open: true,
    onClose: () => {},
    children: (
      <div className="flex flex-col gap-3">
        <h2 className="text-Cr-text-default-v2 text-lg font-semibold">Confirm Action</h2>
        <p className="text-Cr-text-subtle-v2 text-sm">Are you sure you want to proceed? This action cannot be undone.</p>
        <button className="w-full py-3 rounded-lg-v2 bg-dreamy-brand-hot-v2 text-Cr-text-static-white-v2 text-sm font-semibold">
          Confirm
        </button>
      </div>
    ),
  },
};

export const Closed: Story = {
  args: {
    open: false,
    onClose: () => {},
    children: <p>This content is not visible.</p>,
  },
};

export const WithLongContent: Story = {
  args: {
    open: true,
    onClose: () => {},
    children: (
      <div className="flex flex-col gap-3 max-h-[60vh] overflow-y-auto">
        <h2 className="text-Cr-text-default-v2 text-lg font-semibold">Terms of Service</h2>
        {Array.from({ length: 20 }, (_, i) => (
          <p key={i} className="text-Cr-text-subtle-v2 text-sm">
            Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam.
          </p>
        ))}
        <button className="w-full py-3 rounded-lg-v2 bg-dreamy-brand-hot-v2 text-Cr-text-static-white-v2 text-sm font-semibold shrink-0">
          Accept
        </button>
      </div>
    ),
  },
};
