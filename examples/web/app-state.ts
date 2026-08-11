import { atom } from 'nanostores';
import { $currentTime } from './current-time';

export type AppSnapshot = {
  currentTime: number;
  lastResult: string;
  capabilitiesSummary: string;
  mediaUrl: string;
};

export const $lastResult = atom<string>('No checks run yet');
export const $capabilitiesSummary = atom<string>('Discovery not run yet');
export const $mediaUrl = atom<string>('');

export function getAppSnapshot(): AppSnapshot {
  return {
    currentTime: $currentTime.get(),
    lastResult: $lastResult.get(),
    capabilitiesSummary: $capabilitiesSummary.get(),
    mediaUrl: $mediaUrl.get(),
  };
}

export function setAppSnapshot(snapshot: Partial<AppSnapshot>): void {
  if (snapshot.currentTime !== undefined)
    $currentTime.set(snapshot.currentTime);
  if (snapshot.lastResult !== undefined) $lastResult.set(snapshot.lastResult);
  if (snapshot.mediaUrl !== undefined) $mediaUrl.set(snapshot.mediaUrl);
  if (snapshot.capabilitiesSummary !== undefined) {
    $capabilitiesSummary.set(snapshot.capabilitiesSummary);
  }
}
