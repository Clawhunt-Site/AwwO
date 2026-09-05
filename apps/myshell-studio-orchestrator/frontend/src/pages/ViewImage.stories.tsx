import type { Meta, StoryObj } from '@storybook/react-vite';
import ViewImage from './ViewImage';

const meta: Meta<typeof ViewImage> = {
  title: 'Pages/ViewImage',
  component: ViewImage,
  parameters: {
    layout: 'fullscreen',
    // ViewImage uses useParams() to read :id — we need <Routes>/<Route>
    // matching the app route pattern so the param is populated.
    router: { path: '/library/img-123', pattern: '/library/:id' },
  },
};

export default meta;
type Story = StoryObj<typeof ViewImage>;

export const Default: Story = {};
