import type { Meta, StoryObj } from '@storybook/react-vite';
import Skeleton from './Skeleton';

const meta = {
  title: 'Components/Skeleton',
  component: Skeleton,
  decorators: [
    (Story) => (
      <div className="bg-Cr-Bg-soft-v2 p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Skeleton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    width: '100%',
    height: '200px',
  },
};

export const Card: Story = {
  args: {
    width: '160px',
    height: '200px',
    borderRadius: '12px',
  },
};

export const Avatar: Story = {
  args: {
    width: '48px',
    height: '48px',
    borderRadius: '50%',
  },
};

export const TextLine: Story = {
  args: {
    width: '200px',
    height: '16px',
  },
};
