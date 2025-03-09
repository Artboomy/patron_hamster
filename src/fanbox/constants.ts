export const URLS = {
  patreon: {
    login: 'https://www.patreon.com/login',
    host: 'https://www.patreon.com'
  },
  pixivFanbox: {
    login: 'https://accounts.pixiv.net/login',
    // host is dynamic in format *.fanbox.cc
    host: 'https://www.*fanbox.cc'
  }
} as const
