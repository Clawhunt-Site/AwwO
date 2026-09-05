import type { Meta, StoryObj } from '@storybook/react-vite';
import TabBar from './TabBar';

const meta: Meta<typeof TabBar> = {
  title: 'Components/TabBar',
  component: TabBar,
  parameters: {
    layout: 'fullscreen',
  },
};

export default meta;
type Story = StoryObj<typeof TabBar>;

/**
 * Characters tab active — default route "/".
 * Uses the global Router decorator with default initialEntries=['/'].
 */
export const Characters: Story = {};

/**
 * Library tab active — override initial route via parameters.router.
 */
export const Library: Story = {
  parameters: {
    router: { path: '/library' },
  },
};

/**
 * Settings tab active — override initial route via parameters.router.
 */
export const Settings: Story = {
  parameters: {
    router: { path: '/settings' },
  },
};
