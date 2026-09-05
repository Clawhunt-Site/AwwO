import type { Meta, StoryObj } from '@storybook/react-vite';
import ProgressiveImage from './ProgressiveImage';

const meta = {
  title: 'Components/ProgressiveImage',
  component: ProgressiveImage,
  decorators: [
    (Story) => (
      <div className="bg-Cr-Bg-soft-v2 p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ProgressiveImage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    src: 'https://placehold.co/600x800/1d1c1f/f5f5f6?text=Image',
    alt: 'Placeholder image',
    className: 'w-[300px] h-[400px] rounded-lg-v2',
  },
};

export const WithThumb: Story = {
  args: {
    src: 'https://placehold.co/600x800/1d1c1f/f5f5f6?text=Full+Image',
    thumbSrc: 'https://placehold.co/60x80/1d1c1f/f5f5f6?text=Thumb',
    alt: 'Image with thumbnail',
    className: 'w-[300px] h-[400px] rounded-lg-v2',
  },
};

export const Eager: Story = {
  args: {
    src: 'https://placehold.co/600x800/1d1c1f/f5f5f6?text=Eager+Load',
    alt: 'Eagerly loaded image',
    loading: 'eager',
    className: 'w-[300px] h-[400px] rounded-lg-v2',
  },
};
