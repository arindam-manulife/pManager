// Runtime configuration for pManager. Edit these values without touching app code.
// When you later move the API to a real host, change `apiBase` here.

window.PM_CONFIG = {
  // Base URL of the sites API. Include scheme + host, no trailing slash.
  apiBase: "http://127.0.0.1:3001",

  // If true, when the API is unreachable the app falls back to a localStorage
  // cache (last successful response). Writes go to the API only.
  useLocalCache: true,
};
