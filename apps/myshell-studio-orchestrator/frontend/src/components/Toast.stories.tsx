import type { Meta, StoryObj } from '@storybook/react-vite';
import Toast from './Toast';

const meta = {
  title: 'Components/Toast',
  component: Toast,
  decorators: [
    (Story) => (
      <div className="bg-Cr-Bg-soft-v2 min-h-[100px] flex items-center justify-center p-4">
        <Story />
      </div>
    ),
  ],
  args: {
    onClose: () => {},
  },
} satisfies Meta<typeof Toast>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Success: Story = {
  args: {
    toast: {
      id: 1,
      message: 'Code applied!',
      variant: 'success',
      duration: 999999,
    },
  },
};

export const Info: Story = {
  args: {
    toast: {
      id: 2,
      message: 'Something happened',
      variant: 'info',
      duration: 999999,
    },
  },
};

export const LongMessage: Story = {
  args: {
    toast: {
      id: 3,
      message:
        'This is a very long toast message that should test how the component handles text truncation and overflow behavior in a constrained viewport width',
      variant: 'success',
      duration: 999999,
    },
  },
};
