import { createCustomerHandoffCookieCodec } from './customer-handoff-cookie.js';

const codec=createCustomerHandoffCookieCodec('owner_real');
export const OWNER_HANDOFF_COOKIE_PATH=codec.path;
export const OWNER_HANDOFF_BROWSER_COOKIE=codec.browserName;
export const OWNER_HANDOFF_COMPLETION_COOKIE=codec.completionName;
export const readOwnerHandoffBrowserCookie=codec.readBrowser;
export const readOwnerHandoffCompletionCookie=codec.readCompletion;
export const serializeOwnerHandoffBrowserCookie=codec.serializeBrowser;
export const serializeOwnerHandoffCompletionCookie=codec.serializeCompletion;
export const clearOwnerHandoffCookies=codec.clear;
