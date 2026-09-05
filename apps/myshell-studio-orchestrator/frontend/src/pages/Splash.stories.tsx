import type { Meta, StoryObj } from '@storybook/react-vite';
import Splash from './Splash';

const meta: Meta<typeof Splash> = {
  title: 'Pages/Splash',
  component: Splash,
  args: { onDone: () => console.log('Splash done') },
};
export default meta;
type Story = StoryObj<typeof Splash>;

export const Default: Story = {};
