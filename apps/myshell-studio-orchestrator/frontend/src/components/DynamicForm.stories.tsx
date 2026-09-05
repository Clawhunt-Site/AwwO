import type { Meta, StoryObj } from '@storybook/react-vite';
import DynamicForm from './DynamicForm';
import type { FormField } from '../types/form';

const meta: Meta<typeof DynamicForm> = {
  title: 'Components/DynamicForm',
  component: DynamicForm,
  args: {
    onChange: () => {},
    onUpload: () => {},
  },
  parameters: {
    layout: 'padded',
  },
};

export default meta;
type Story = StoryObj<typeof DynamicForm>;

const uploaderField: FormField = {
  title: 'Upload Photo',
  component: 'Uploader',
  index: 0,
  options: [],
  default: '',
  required: true,
};

const radioGroupField: FormField = {
  title: 'Style',
  component: 'RadioGroup',
  index: 1,
  options: [
    { label: 'Realistic', value: 'realistic' },
    { label: 'Anime', value: 'anime' },
    { label: 'Cartoon', value: 'cartoon' },
  ],
  default: '',
  required: true,
};

const imageChoicesField: FormField = {
  title: 'Pose',
  component: 'ImageChoices',
  index: 2,
  options: [
    { label: 'Standing', value: 'standing', image: 'https://placehold.co/100x100/1d1c1f/f5f5f6?text=Stand' },
    { label: 'Sitting', value: 'sitting', image: 'https://placehold.co/100x100/1d1c1f/f5f5f6?text=Sit' },
    { label: 'Lying', value: 'lying', image: 'https://placehold.co/100x100/1d1c1f/f5f5f6?text=Lie' },
  ],
  default: '',
  required: true,
};

const promptField: FormField = {
  title: 'Description',
  component: 'Prompt',
  index: 3,
  options: [],
  default: '',
  required: false,
};

const selectorField: FormField = {
  title: 'Resolution',
  component: 'Selector',
  index: 4,
  options: [
    { label: '512x512', value: '512' },
    { label: '768x768', value: '768' },
    { label: '1024x1024', value: '1024' },
  ],
  default: '',
  required: true,
};

/**
 * All five field types rendered together.
 */
export const AllFieldTypes: Story = {
  args: {
    fields: [uploaderField, radioGroupField, imageChoicesField, promptField, selectorField],
    values: {},
    uploadStates: {},
  },
};

/**
 * Just a single uploader field.
 */
export const UploaderOnly: Story = {
  args: {
    fields: [uploaderField],
    values: {},
    uploadStates: {},
  },
};

/**
 * Pre-filled values for each field type.
 */
export const WithValues: Story = {
  args: {
    fields: [uploaderField, radioGroupField, imageChoicesField, promptField, selectorField],
    values: {
      0: 'https://placehold.co/400x300/1d1c1f/f5f5f6?text=Uploaded',
      1: 'anime',
      2: 'sitting',
      3: 'A beautiful sunset scene with warm lighting',
      4: '768',
    },
    uploadStates: {},
  },
};

/**
 * Uploader in the uploading state with a spinner overlay.
 */
export const Uploading: Story = {
  args: {
    fields: [uploaderField],
    values: {},
    uploadStates: {
      0: { uploading: true },
    },
  },
};

/**
 * Uploader showing an error message.
 */
export const UploadError: Story = {
  args: {
    fields: [uploaderField],
    values: {},
    uploadStates: {
      0: { uploading: false, error: 'File too large. Max size is 10 MB.' },
    },
  },
};
