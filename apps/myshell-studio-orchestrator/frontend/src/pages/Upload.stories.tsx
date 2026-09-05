import type { Meta, StoryObj } from '@storybook/react-vite';
import Upload from './Upload';

const meta: Meta<typeof Upload> = {
  title: 'Pages/Upload',
  component: Upload,
  parameters: {
    layout: 'fullscreen',
    router: { path: '/upload?slug_id=demo-bot' },
  },
};

export default meta;
type Story = StoryObj<typeof Upload>;

export const Default: Story = {};
