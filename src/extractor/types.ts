import { BrowserContext } from 'rebrowser-playwright'

export type StoredCookies = Parameters<BrowserContext['addCookies']>[0]
