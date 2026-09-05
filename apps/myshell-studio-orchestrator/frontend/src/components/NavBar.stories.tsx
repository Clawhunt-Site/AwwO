import type { Meta, StoryObj } from '@storybook/react-vite';
import { HomeNavBar, BackNavBar } from './NavBar';

const homeNavBarMeta = {
  title: 'Components/NavBar',
  decorators: [
    (Story) => (
      <div className="bg-Cr-Bg-soft-v2 min-h-[100px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta;

export default homeNavBarMeta;

export const HomeWithEnergy: StoryObj = {
  render: () => <HomeNavBar onEnergyClick={() => {}} energy={50} />,
};

export const HomeNoEnergy: StoryObj = {
  render: () => <HomeNavBar onEnergyClick={() => {}} energy={null} />,
};

export const BackWithTitle: StoryObj = {
  render: () => <BackNavBar title="Bot Detail" />,
};

export const BackNoTitle: StoryObj = {
  render: () => <BackNavBar />,
};
