import { createContext, useContext } from 'react';

/** True inside the 设置 centre: an account page then draws only its own content, the centre its header and navigation. */
export const SettingsFrame = createContext(false);
export const useInSettingsFrame = () => useContext(SettingsFrame);

/** Every page of the 设置 centre, in the order of its navigation; each is the value of the address's ?account=. */
export const SETTINGS_SECTIONS = ['security', 'plans', 'invites', 'local', 'general', 'appearance', 'shortcuts', 'personalization', 'skills', 'engines', 'relay', 'workspace', 'data', 'about'] as const;
export type SettingsSection = typeof SETTINGS_SECTIONS[number];
export const isSettingsSection = (value: string | null): value is SettingsSection => (SETTINGS_SECTIONS as readonly string[]).includes(value || '');
