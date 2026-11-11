// __MIGA_TARGET__ is a build-time constant (vite.config.ts), so the bundler keeps one branch
// and drops the other two implementations from the output.
import { platform as web } from './web';
import { platform as desktop } from './desktop';
import { platform as mobile } from './mobile';
import type { Platform } from './types';

export const platform: Platform =
	__MIGA_TARGET__ === 'desktop' ? desktop : __MIGA_TARGET__ === 'mobile' ? mobile : web;
export type { Platform, Target } from './types';
