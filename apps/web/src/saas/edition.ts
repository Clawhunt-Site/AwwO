import { createContext, useContext } from 'react';

/**
 * The local edition (AwwO 本地版), as the API says (`edition` in /auth/options before sign-in, in /auth/me after): the
 * hosted product run on one person's computer with their own model keys. It has no plans to buy and no upgrade to
 * offer, no ClawHunt sign-in or invites, no operator pages and no new accounts; it shows the computer's own settings
 * (设置 → 本机) instead. An API that does not say is the hosted site.
 */
export type Edition = 'hosted' | 'local';
export const isLocalEdition = (value?: { edition?: string } | null): boolean => value?.edition === 'local';

/**
 * The local edition started by a window of its own (`shell` in /auth/options and /local): 'windows', AwwO Local, the
 * Windows installer's; 'macos', the Mac app's local workspace. Its person has the window's AwwO menu (restart, quit,
 * reset the password, the data folder) and no checkout, so the app names the menu where a checkout's person would run
 * an npm command.
 */
export const inLocalWindow = (value?: { edition?: string; shell?: string } | null): boolean => value?.shell === 'windows' || value?.shell === 'macos';

/** True under a signed-in local edition's page (SaaSApp provides it from the identity). */
export const LocalEdition = createContext(false);
export const useLocalEdition = () => useContext(LocalEdition);
