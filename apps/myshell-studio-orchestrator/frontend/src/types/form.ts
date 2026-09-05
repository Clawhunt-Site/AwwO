export interface FormFieldOption {
  label: string;
  value: string;
  image?: string;
}

export interface FormField {
  title: string;
  component: 'Uploader' | 'RadioGroup' | 'ImageChoices' | 'Selector' | 'Prompt';
  index: number | null;
  options: FormFieldOption[] | string[];
  default: string;
  required?: boolean;
  multi?: boolean;
  max?: number;
}

export interface FormData {
  title: string;
  description: string;
  button_text: string;
  form: FormField[];
}

export type FormValues = Record<number, string>;
