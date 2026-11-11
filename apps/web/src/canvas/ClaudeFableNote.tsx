// The line under a model picker while the model chosen in it is a Claude Fable model AwwO runs through Amazon Bedrock
// (userChosenModels.ts isBedrockClaudeFableModel): what ClawHunt's privacy policy says of those models (clause 08,
// "Claude Fable models"), in one sentence, and a pointer to the clause. It is drawn only for such a model, so a picker
// on any other model shows nothing, a person's own Claude Fable connection in the local edition included.
// The clause's page is the ClawHunt site's /legal, linked only where the API named an https site (as 设置 → 关于 does);
// without one, the clause is named and not linked. The link opens on the clause itself (#s-privacy-c8, the id clause
// 07 also links to): /legal alone opens on the Terms of Service, about 4,600 px above it.
import { createContext, useContext, type ReactNode } from 'react';
import { CLAUDE_FABLE_SENTENCE, PRIVACY_CLAUSE_NAME, isBedrockClaudeFableModel } from './userChosenModels';
import './claude-fable-note.css';

/** The ClawHunt site the signed-in identity names (`clawhuntSiteURL`); SaaSApp provides it. Empty: none. */
export const PolicySite = createContext('');

/** Clause 08 of the privacy policy on that site; '' unless the site is an https URL. */
export function privacyPolicyURL(site: string | null | undefined): string {
  const base = typeof site === 'string' ? site.trim().replace(/\/+$/, '') : '';
  return /^https:\/\//.test(base) ? `${base}/legal#s-privacy-c8` : '';
}

/** Clause 08 by name: a link to the policy in a new tab where there is one to open, else its name alone. */
export function PrivacyClause({ locale }: { locale: 'zh' | 'en' }): ReactNode {
  const url = privacyPolicyURL(useContext(PolicySite));
  const name = PRIVACY_CLAUSE_NAME[locale === 'zh' ? 0 : 1];
  return url ? <a className="awwo-fable-clause" href={url} target="_blank" rel="noopener noreferrer">{name}</a> : <span className="awwo-fable-clause">{name}</span>;
}

export interface ClaudeFableNoteProps {
  /** The model chosen in the picker now; the note is drawn only for a Claude Fable model. */
  model: string | null | undefined;
  locale: 'zh' | 'en';
  /** The hint class of the place it is in (its picker's own small print). */
  className?: string;
  as?: 'p' | 'div' | 'small';
}

export function ClaudeFableNote({ model, locale, className, as: Tag = 'p' }: ClaudeFableNoteProps): ReactNode {
  if (!isBedrockClaudeFableModel(model)) return null;
  return <Tag className={className ? `awwo-fable-note ${className}` : 'awwo-fable-note'} role="note">
    {CLAUDE_FABLE_SENTENCE[locale === 'zh' ? 0 : 1]}{locale === 'zh' ? '' : ' '}<PrivacyClause locale={locale} />
  </Tag>;
}
