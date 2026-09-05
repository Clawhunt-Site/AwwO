import type { Meta, StoryObj } from '@storybook/react-vite';
import AgeVerification from './AgeVerification';

const meta: Meta<typeof AgeVerification> = {
  title: 'Pages/AgeVerification',
  component: AgeVerification,
  args: { onVerified: () => console.log('Age verified') },
};
export default meta;
type Story = StoryObj<typeof AgeVerification>;

export const Default: Story = {};
