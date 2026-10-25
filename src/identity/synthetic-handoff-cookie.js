import { createCustomerHandoffCookieCodec } from './customer-handoff-cookie.js';

const codec=createCustomerHandoffCookieCodec('synthetic');
export const SYNTHETIC_HANDOFF_COOKIE_PATH=codec.path;
export const SYNTHETIC_HANDOFF_BROWSER_COOKIE=codec.browserName;
export const SYNTHETIC_HANDOFF_COMPLETION_COOKIE=codec.completionName;
export const readSyntheticHandoffBrowserCookie=codec.readBrowser;
export const readSyntheticHandoffCompletionCookie=codec.readCompletion;
export const serializeSyntheticHandoffBrowserCookie=codec.serializeBrowser;
export const serializeSyntheticHandoffCompletionCookie=codec.serializeCompletion;
export const clearSyntheticHandoffCookies=codec.clear;
