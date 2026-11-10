import { atom } from 'nanostores';

export const $lastResult = atom<string>('No checks run yet');
export const $capabilitiesSummary = atom<string>('Discovery not run yet');
export const $mediaUrl = atom<string>('');
