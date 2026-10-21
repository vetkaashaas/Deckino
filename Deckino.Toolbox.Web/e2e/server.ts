// The Toolbox the E2E run drives: the real exe, headless (--serve), on a throwaway data root with no bucket.
const port = 5990 // outside Windows' Hyper-V reserved ranges (see AGENTS.md)
export const baseURL = `http://127.0.0.1:${port}`
export const token = 'deckino-e2e'
