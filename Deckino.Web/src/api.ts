// Calls to Deckino.Api. Failures arrive as ProblemDetails; ApiError carries the message to show and,
// for validation problems, the messages per form field.
import type { HttpValidationProblemDetails, paths } from './generated'

export class ApiError extends Error {
  readonly status: number
  readonly fieldErrors: Record<string, string>

  constructor(status: number, message: string, fieldErrors: Record<string, string> = {}) {
    super(message)
    this.status = status
    this.fieldErrors = fieldErrors
  }
}

type Problem = HttpValidationProblemDetails & { traceId?: string } // W3C traceparent, "00-<trace id>-<span id>-00"

async function toError(response: Response) {
  const problem: Problem = await response.json().catch(() => ({}))
  const fieldErrors = Object.fromEntries(
    Object.entries(problem.errors ?? {}).map(([field, messages]) => [field, messages.join(' ')]),
  )
  if (response.status >= 500) {
    // The trace id finds the request's log lines on Railway (@TraceId:…).
    const reference = problem.traceId?.split('-')[1]
    return new ApiError(
      response.status,
      'Something went wrong on our side. Try again in a moment.' +
        (reference ? ` If it keeps happening, contact support@deckino.com with reference ${reference}.` : ''),
    )
  }
  const message =
    response.status === 429 || !problem.errors
      ? (problem.detail ?? problem.title ?? 'Something went wrong. Try again.')
      : 'Check the highlighted fields.'
  return new ApiError(response.status, message, fieldErrors)
}

// Calls are typed by path from generated.ts: a body or answer that no longer matches the API is a type error.
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE'
// A route parameter ('/api/decks/{id}') takes any value, and a call may add a query string.
type Filled<S extends string> = S extends `${infer Head}{${string}}${infer Tail}` ? `${Head}${string}${Filled<Tail>}` : S
type Route<M extends Method> = { [K in keyof paths]: paths[K][Lowercase<M>] extends object ? K : never }[keyof paths]
export type ApiPath<M extends Method> = Filled<Route<M>> | `${Filled<Route<M>>}?${string}`
// '/api/binders/import' also fits '/api/binders/{id}', and '/api/decks/{id}/collection' fits '/api/decks/{id}': the
// most specific route wins.
type Matching<P extends string, M extends Method> = {
  [K in Route<M>]: P extends Filled<K> | `${Filled<K>}?${string}` ? K : never
}[Route<M>]
type MostSpecific<K extends string, All extends string = K> = K extends unknown
  ? [Exclude<All extends unknown ? (Filled<All> extends Filled<K> ? All : never) : never, K>] extends [never]
    ? K
    : never
  : never
type Operation<P extends string, M extends Method> = paths[Extract<MostSpecific<Matching<P, M>>, keyof paths>][Lowercase<M>]
type Json<T> = T extends { content: { 'application/json': infer B } } ? B : never
type Responses<P extends string, M extends Method> =
  Operation<P, M> extends { responses: infer R } ? { [S in keyof R]: S extends 204 ? undefined : Json<R[S]> }[keyof R] : never
// undefined for 204 No Content; void when no answer has a body.
type Answer<P extends string, M extends Method> = [Responses<P, M>] extends [never] ? void : Responses<P, M>
type Body<P extends string, M extends Method> = Operation<P, M> extends { requestBody?: infer R } ? Json<R> : never
type BodyArg<P extends string, M extends Method> = [Body<P, M>] extends [never] ? [] : [body: Body<P, M>]

export async function getJson<P extends ApiPath<'GET'>>(url: P): Promise<Answer<P, 'GET'>> {
  const response = await fetch(url)
  if (!response.ok) throw await toError(response)
  return await response.json()
}

// POST/PUT/DELETE, with the JSON body the route takes. Resolves to the JSON response, or undefined for 204 No Content.
export async function sendJson<M extends Method, P extends ApiPath<M>>(
  method: M,
  url: P,
  ...[body]: BodyArg<P, M>
): Promise<Answer<P, M>> {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!response.ok) throw await toError(response)
  return response.status === 204 ? undefined : await response.json()
}
