import type { Meta, StoryObj } from '@storybook/react-vite';
import { NavigationBar } from './NavigationBar';

const meta = {
  title: 'Components/NavigationBar',
  component: NavigationBar,
  parameters: {
    layout: 'fullscreen',
  },
  decorators: [
    (Story) => (
      <div className="bg-Cr-Bg-soft-v2 min-h-[100px]">
        <Story />
      </div>
    ),
  ],
  args: {
    onMenuClick: () => {},
    onEnergyClick: () => {},
  },
} satisfies Meta<typeof NavigationBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WithEnergy: Story = {
  args: {
    energy: 50,
  },
};

export const NoEnergy: Story = {
  args: {
    energy: null,
  },
};

export const GetEnergyButton: Story = {
  args: {
    showGetEnergyButton: true,
  },
};

export const SidebarOpen: Story = {
  args: {
    energy: 50,
    sidebarOpen: true,
  },
};
