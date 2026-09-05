import type { Meta, StoryObj } from '@storybook/react-vite';
import Library from './Library';

const meta: Meta<typeof Library> = {
  title: 'Pages/Library',
  component: Library,
  parameters: {
    layout: 'fullscreen',
    router: { path: '/library' },
  },
};

export default meta;
type Story = StoryObj<typeof Library>;

export const Default: Story = {};
