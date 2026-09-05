import type { Meta, StoryObj } from '@storybook/react-vite';
import BottomSheet from './BottomSheet';

const meta = {
  title: 'Components/BottomSheet',
  component: BottomSheet,
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
    onClose: () => {},
  },
} satisfies Meta<typeof BottomSheet>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    children: (
      <ul className="flex flex-col gap-3">
        {['Option A', 'Option B', 'Option C'].map((label) => (
          <li
            key={label}
            className="py-3 px-4 bg-Cr-Bg-surface-subtle-v2 rounded-lg-v2 text-Cr-text-default-v2 text-sm"
          >
            {label}
          </li>
        ))}
      </ul>
    ),
  },
};

export const WithActions: Story = {
  args: {
    children: (
      <div className="flex flex-col gap-3">
        <h3 className="text-Cr-text-default-v2 text-base font-semibold">Choose an action</h3>
        <button className="w-full py-3 rounded-lg-v2 bg-dreamy-brand-hot-v2 text-Cr-text-static-white-v2 text-sm font-semibold">
          Save to Library
        </button>
        <button className="w-full py-3 rounded-lg-v2 bg-Cr-Bg-surface-subtle-v2 text-Cr-text-default-v2 text-sm font-semibold">
          Share
        </button>
        <button className="w-full py-3 rounded-lg-v2 bg-transparent text-Cr-text-subtle-v2 text-sm">
          Cancel
        </button>
      </div>
    ),
  },
};
