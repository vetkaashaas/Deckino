// Calls to Deckino.Api. Failures arrive as ProblemDetails; ApiError carries the message to show and,
// for validation problems, the messages per form field.

export class ApiError extends Error {
  readonly status: number
  readonly fieldErrors: Record<string, string>

  constructor(status: number, message: string, fieldErrors: Record<string, string> = {}) {
    super(message)
    this.status = status
    this.fieldErrors = fieldErrors
  }
}

interface Problem {
  title?: string
  detail?: string
  errors?: Record<string, string[]>
}

async function toError(response: Response) {
  const problem: Problem = await response.json().catch(() => ({}))
  const fieldErrors = Object.fromEntries(
    Object.entries(problem.errors ?? {}).map(([field, messages]) => [field, messages.join(' ')]),
  )
  const message =
    response.status === 429 || !problem.errors
      ? (problem.detail ?? problem.title ?? 'Something went wrong. Try again.')
      : 'Check the highlighted fields.'
  return new ApiError(response.status, message, fieldErrors)
}

export async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url)
  if (!response.ok) throw await toError(response)
  return (await response.json()) as T
}

// POST/PUT/DELETE with a JSON body. Resolves to the JSON response, or undefined for 204 No Content.
export async function sendJson<T = void>(method: string, url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!response.ok) throw await toError(response)
  return (response.status === 204 ? undefined : await response.json()) as T
}
